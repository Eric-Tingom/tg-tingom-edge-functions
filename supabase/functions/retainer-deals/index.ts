import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// HubSpot constants
const SERVICE_DELIVERY_PIPELINE = "9196710";
const IN_PROGRESS_STAGE = "26095017";
const ERIC_OWNER_ID = "33210562";
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return jsonResponse(null, 200, true);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    const body = req.method === "POST" ? await req.json() : {};
    const targetMonth = body.billing_month || getNextMonth();
    const dryRun = body.dry_run === true;
    console.log(`[retainer-deals] Target month: ${targetMonth}, dry_run: ${dryRun}`);
    // Step 1: Get all retainer clients from client_registry
    const { data: clients, error: clientErr } = await supabase.from("client_registry").select("client_name, hubspot_id, billing_model, monthly_retainer_amount").in("billing_model", [
      "flat_retainer",
      "capped_retainer",
      "monthly_retainer"
    ]).eq("is_internal", false).not("monthly_retainer_amount", "is", null);
    if (clientErr || !clients?.length) {
      return jsonResponse({
        error: "No retainer clients found in client_registry",
        details: clientErr?.message
      }, 404);
    }
    console.log(`[retainer-deals] Found ${clients.length} retainer clients`);
    // Step 2: Check existing billing periods for target month
    const { data: existingPeriods } = await supabase.from("retainer_billing_periods").select("client_name, hubspot_deal_id, billing_month").eq("billing_month", targetMonth);
    const existingMap = new Map((existingPeriods || []).map((p)=>[
        p.client_name,
        p.hubspot_deal_id
      ]));
    // Step 3: Check prior month invoice status for flagging
    const priorMonth = getPriorMonth(targetMonth);
    const { data: priorPeriods } = await supabase.from("retainer_billing_periods").select("client_name, invoice_status").eq("billing_month", priorMonth);
    const priorInvoiceMap = new Map((priorPeriods || []).map((p)=>[
        p.client_name,
        p.invoice_status
      ]));
    // Step 4: Get HubSpot access token from Supabase secrets
    const hubspotToken = await getHubSpotToken(supabase);
    if (!hubspotToken && !dryRun) {
      return jsonResponse({
        error: "Could not obtain HubSpot access token"
      }, 500);
    }
    // Step 5: Process each client
    const results = [];
    for (const client of clients){
      const result = {
        client_name: client.client_name,
        billing_month: targetMonth,
        action: "created"
      };
      // Check prior month invoice status
      const priorStatus = priorInvoiceMap.get(client.client_name);
      if (priorStatus && priorStatus !== "paid" && priorStatus !== "invoiced") {
        result.prior_month_invoice_status = priorStatus;
      }
      // Skip if already exists
      if (existingMap.has(client.client_name)) {
        result.action = "skipped_exists";
        result.hubspot_deal_id = existingMap.get(client.client_name);
        results.push(result);
        continue;
      }
      if (!client.monthly_retainer_amount) {
        result.action = "skipped_no_retainer";
        results.push(result);
        continue;
      }
      if (dryRun) {
        result.action = "created";
        result.deal_name = buildDealName(client.client_name, targetMonth);
        result.amount = client.monthly_retainer_amount;
        result.hubspot_deal_id = "DRY_RUN";
        results.push(result);
        continue;
      }
      // Create HubSpot deal
      try {
        const dealName = buildDealName(client.client_name, targetMonth);
        const closeDate = getLastDayOfMonth(targetMonth);
        const dealResponse = await createHubSpotDeal(hubspotToken, {
          dealname: dealName,
          pipeline: SERVICE_DELIVERY_PIPELINE,
          dealstage: IN_PROGRESS_STAGE,
          amount: String(client.monthly_retainer_amount),
          closedate: closeDate,
          hubspot_owner_id: ERIC_OWNER_ID
        }, client.hubspot_id);
        if (!dealResponse.id) {
          throw new Error("No deal ID returned from HubSpot");
        }
        // Create billing period in Supabase
        const { error: insertErr } = await supabase.from("retainer_billing_periods").insert({
          hubspot_company_id: client.hubspot_id,
          client_name: client.client_name,
          billing_month: targetMonth,
          billing_type: "retainer",
          retainer_amount: client.monthly_retainer_amount,
          hubspot_deal_id: String(dealResponse.id),
          hubspot_deal_stage: IN_PROGRESS_STAGE,
          total_items_planned: 0,
          total_items_completed: 0,
          invoice_status: "pending"
        });
        if (insertErr) {
          console.error(`[retainer-deals] Supabase insert failed for ${client.client_name}:`, insertErr);
        }
        result.action = "created";
        result.hubspot_deal_id = String(dealResponse.id);
        result.deal_name = dealName;
        result.amount = client.monthly_retainer_amount;
      } catch (err) {
        result.action = "error";
        result.error = String(err);
        console.error(`[retainer-deals] Error for ${client.client_name}:`, err);
      }
      results.push(result);
    }
    // Step 6: Build summary
    const created = results.filter((r)=>r.action === "created");
    const skipped = results.filter((r)=>r.action === "skipped_exists");
    const errors = results.filter((r)=>r.action === "error");
    const invoiceAlerts = results.filter((r)=>r.prior_month_invoice_status);
    const summary = {
      target_month: targetMonth,
      dry_run: dryRun,
      total_clients: clients.length,
      deals_created: created.length,
      deals_skipped: skipped.length,
      errors: errors.length,
      invoice_alerts: invoiceAlerts.length,
      results
    };
    console.log(`[retainer-deals] Complete:`, JSON.stringify(summary));
    return jsonResponse(summary);
  } catch (err) {
    console.error("[retainer-deals] Fatal error:", err);
    return jsonResponse({
      error: String(err)
    }, 500);
  }
});
// ========================================
// HUBSPOT API
// ========================================
async function createHubSpotDeal(token, properties, companyId) {
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/deals", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      properties,
      associations: [
        {
          to: {
            id: companyId
          },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 342
            }
          ]
        }
      ]
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HubSpot deal creation failed (${res.status}): ${errText}`);
  }
  return await res.json();
}
async function getHubSpotToken(supabase) {
  // Try vault secrets first
  try {
    const { data } = await supabase.rpc("get_hubspot_token");
    if (data) return data;
  } catch (_e) {
  // RPC might not exist yet
  }
  // Fallback: check if token is stored in vault
  try {
    const { data: secrets } = await supabase.from("vault.decrypted_secrets").select("decrypted_secret").eq("name", "hubspot_access_token").single();
    if (secrets?.decrypted_secret) return secrets.decrypted_secret;
  } catch (_e) {
  // vault view might not be accessible
  }
  // Final fallback: check connected_systems for the token
  const { data: sys } = await supabase.from("connected_systems").select("api_key").eq("system_name", "hubspot").single();
  return sys?.api_key || null;
}
// ========================================
// DATE HELPERS
// ========================================
function getNextMonth() {
  const now = new Date();
  const year = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const month = now.getMonth() === 11 ? 1 : now.getMonth() + 2;
  return `${year}-${String(month).padStart(2, "0")}`;
}
function getPriorMonth(billingMonth) {
  const [year, month] = billingMonth.split("-").map(Number);
  if (month === 1) return `${year - 1}-12`;
  return `${year}-${String(month - 1).padStart(2, "0")}`;
}
function getLastDayOfMonth(billingMonth) {
  const [year, month] = billingMonth.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return `${billingMonth}-${String(lastDay).padStart(2, "0")}`;
}
function buildDealName(clientName, billingMonth) {
  const [year, month] = billingMonth.split("-").map(Number);
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];
  return `${clientName} \u2014 ${monthNames[month - 1]} ${year} Retainer`;
}
// ========================================
// HELPERS
// ========================================
function jsonResponse(data, status = 200, cors = false) {
  return new Response(data ? JSON.stringify(data, null, 2) : null, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...cors ? {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      } : {}
    }
  });
}
