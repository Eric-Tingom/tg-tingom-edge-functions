import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const VERSION = "1.0.1";
const DQ_RULE_CONTACT_ASSOC = "860ab66d-0886-4a8d-930b-3e57e5b82c30";
const AGENT_ID = "dq_remediation_engine";
const SKILL_NAME = "hubspot-ticket-associator";
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
// ─── HELPERS ───
async function getHubSpotToken() {
  const { data, error } = await supabase.rpc("get_hubspot_token");
  if (error || !data) throw new Error("HubSpot token not found: " + (error?.message || "no data"));
  return data;
}
async function batchGetAssociations(token, objectType, toType, objectIds) {
  const found = {};
  const missing = [];
  for(let i = 0; i < objectIds.length; i += 100){
    const chunk = objectIds.slice(i, i + 100);
    const res = await fetch(`https://api.hubapi.com/crm/v4/associations/${objectType}/${toType}/batch/read`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        inputs: chunk.map((id)=>({
            id
          }))
      })
    });
    if (!res.ok) throw new Error(`Association batch read failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    for (const result of data.results || []){
      const fromId = result.from?.id;
      const toId = result.to?.[0]?.toObjectId;
      if (fromId && toId) found[fromId] = String(toId);
    }
    for (const err of data.errors || []){
      const fromId = err.context?.fromObjectId?.[0];
      if (fromId) missing.push(fromId);
    }
  }
  return {
    found,
    missing
  };
}
async function getCompanyContacts(token, companyId) {
  const contacts = [];
  let url = `https://api.hubapi.com/crm/v4/objects/companies/${companyId}/associations/contacts`;
  while(url){
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });
    if (!res.ok) {
      console.error(`Company ${companyId} contacts lookup failed (${res.status})`);
      return contacts;
    }
    const data = await res.json();
    for (const r of data.results || []){
      contacts.push(String(r.toObjectId));
    }
    url = data.paging?.next?.link || null;
  }
  return contacts;
}
async function batchCreateAssociations(token, fromType, toType, associations) {
  const successes = [];
  const failures = [];
  if (associations.length === 0) return {
    successes,
    failures
  };
  for(let i = 0; i < associations.length; i += 100){
    const chunk = associations.slice(i, i + 100);
    const payload = {
      inputs: chunk.map((a)=>({
          from: {
            id: a.fromId
          },
          to: {
            id: a.toId
          },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: a.typeId
            }
          ]
        }))
    };
    console.log(`[HS] Creating ${chunk.length} ${fromType}->${toType} associations (batch ${Math.floor(i / 100) + 1})`);
    const res = await fetch(`https://api.hubapi.com/crm/v4/associations/${fromType}/${toType}/batch/create`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[HS] Batch create failed (${res.status}): ${errText.substring(0, 300)}`);
      for (const a of chunk)failures.push({
        fromId: a.fromId,
        error: `HTTP ${res.status}`
      });
      continue;
    }
    const data = await res.json();
    if (data.results) {
      for(let j = 0; j < data.results.length; j++){
        successes.push(chunk[j].fromId);
      }
    }
    if (data.errors) {
      for (const err of data.errors){
        const failedId = err.context?.fromObjectId?.[0] || "unknown";
        failures.push({
          fromId: failedId,
          error: err.message || "batch error"
        });
        console.error(`[HS] Association error for ${failedId}: ${err.message}`);
      }
    }
  }
  return {
    successes,
    failures
  };
}
// ─── MAIN HANDLER ───
Deno.serve(async (req)=>{
  const startTime = Date.now();
  console.log(`[START] dq-remediate-associations v${VERSION}`);
  try {
    const token = await getHubSpotToken();
    console.log("[OK] HubSpot token retrieved");
    const { data: targets, error: targetsError } = await supabase.rpc("get_dq_remediation_targets");
    if (targetsError) throw new Error(`RPC get_dq_remediation_targets failed: ${targetsError.message}`);
    if (!targets || targets.length === 0) {
      console.log("[DONE] No targets to remediate");
      await logSuccess(startTime, 0, {
        reason: "nothing_to_remediate",
        targets: 0,
        re_checked_resolved: 0,
        auto_associated: 0,
        needs_manual: 0,
        update_errors: 0,
        actions: [],
        manual_flags: []
      });
      return respond({
        success: true,
        version: VERSION,
        targets: 0
      });
    }
    console.log(`[Step 1] Loaded ${targets.length} remediation targets`);
    const ticketIds = targets.map((t)=>t.ticket_id);
    const contactCheck = await batchGetAssociations(token, "tickets", "contacts", ticketIds);
    const nowResolved = targets.filter((t)=>contactCheck.found[t.ticket_id]);
    const stillMissing = targets.filter((t)=>!contactCheck.found[t.ticket_id]);
    console.log(`[Step 2] Re-check: ${nowResolved.length} now have contacts, ${stillMissing.length} still missing`);
    const toAssociate = [];
    const needsCompanyCheck = [];
    const needsManual = [];
    for (const ticket of stillMissing){
      if (ticket.default_contact_id) {
        toAssociate.push({
          ticket_id: ticket.ticket_id,
          contact_id: ticket.default_contact_id,
          reason: "default_contact",
          client: ticket.client_name || "Unknown"
        });
      } else if (ticket.hubspot_company_id) {
        needsCompanyCheck.push(ticket);
      } else {
        needsManual.push({
          ticket_id: ticket.ticket_id,
          reason: `no_company_association`
        });
      }
    }
    console.log(`[Step 3] Priority 1 (default_contact): ${toAssociate.length} resolved`);
    if (needsCompanyCheck.length > 0) {
      const uniqueCompanyIds = [
        ...new Set(needsCompanyCheck.map((t)=>t.hubspot_company_id))
      ];
      console.log(`[Step 3] Checking ${uniqueCompanyIds.length} companies for contacts (Priority 2/3)`);
      const companyContacts = {};
      for (const companyId of uniqueCompanyIds){
        companyContacts[companyId] = await getCompanyContacts(token, companyId);
        console.log(`[Step 3] Company ${companyId}: ${companyContacts[companyId].length} contacts`);
      }
      for (const ticket of needsCompanyCheck){
        const contacts = companyContacts[ticket.hubspot_company_id] || [];
        if (contacts.length === 1) {
          toAssociate.push({
            ticket_id: ticket.ticket_id,
            contact_id: contacts[0],
            reason: "single_company_contact",
            client: ticket.client_name || "Unknown"
          });
        } else {
          needsManual.push({
            ticket_id: ticket.ticket_id,
            reason: contacts.length === 0 ? `no_contacts_on_company:${ticket.client_name}` : `multiple_contacts_no_default:${ticket.client_name}(${contacts.length})`
          });
        }
      }
    }
    console.log(`[Step 3] Total to associate: ${toAssociate.length}, needs manual: ${needsManual.length}`);
    const successfulTicketIds = new Set();
    if (toAssociate.length > 0) {
      const contactAssocs = toAssociate.map((a)=>({
          fromId: a.ticket_id,
          toId: a.contact_id,
          typeId: 16
        }));
      const contactResult = await batchCreateAssociations(token, "tickets", "contacts", contactAssocs);
      for (const id of contactResult.successes)successfulTicketIds.add(id);
      console.log(`[Step 4a] ticket→contact: ${contactResult.successes.length} created, ${contactResult.failures.length} failed`);
      if (successfulTicketIds.size > 0) {
        const successIds = [
          ...successfulTicketIds
        ];
        const companyCheck = await batchGetAssociations(token, "tickets", "companies", successIds);
        const missingCompany = successIds.filter((id)=>!companyCheck.found[id]);
        if (missingCompany.length > 0) {
          console.log(`[Step 4b] ${missingCompany.length} tickets missing company association`);
          const companyAssocs = [];
          for (const ticketId of missingCompany){
            const action = toAssociate.find((a)=>a.ticket_id === ticketId);
            if (!action) continue;
            const contactCompany = await batchGetAssociations(token, "contacts", "companies", [
              action.contact_id
            ]);
            const companyId = contactCompany.found[action.contact_id];
            if (companyId) {
              companyAssocs.push({
                fromId: ticketId,
                toId: companyId,
                typeId: 340
              });
            }
          }
          if (companyAssocs.length > 0) {
            const compResult = await batchCreateAssociations(token, "tickets", "companies", companyAssocs);
            console.log(`[Step 4b] ticket→company: ${compResult.successes.length} created, ${compResult.failures.length} failed`);
          }
        }
      }
    }
    const updates = toAssociate.filter((a)=>successfulTicketIds.has(a.ticket_id)).map((a)=>({
        ticket_id: a.ticket_id,
        hubspot_contact_id: a.contact_id
      }));
    let updateResult = {
      updated: 0,
      errors: 0,
      last_error: null
    };
    if (updates.length > 0) {
      const { data, error } = await supabase.rpc("update_work_item_associations", {
        p_updates: JSON.stringify(updates)
      });
      if (error) {
        console.error(`[Step 5] RPC error: ${error.message}`);
        updateResult = {
          updated: 0,
          errors: updates.length,
          last_error: error.message
        };
      } else {
        updateResult = data;
      }
    }
    const allResolvedIds = [
      ...nowResolved.map((t)=>t.ticket_id),
      ...updates.map((u)=>u.ticket_id)
    ];
    if (allResolvedIds.length > 0) {
      const { data: resolveResult, error: resolveError } = await supabase.rpc("resolve_sync_dq_issues", {
        p_rule_id: DQ_RULE_CONTACT_ASSOC,
        p_resolved_record_ids: allResolvedIds
      });
      if (resolveError) {
        console.error(`[Step 6] resolve_sync_dq_issues error: ${resolveError.message}`);
      } else {
        console.log(`[Step 6] Resolved ${resolveResult?.resolved || 0} DQ issues`);
      }
    }
    for (const m of needsManual){
      await supabase.from("data_quality_issues").update({
        issue_detail: `NEEDS_MANUAL: ${m.reason}`,
        severity: "medium"
      }).eq("record_id", m.ticket_id).eq("rule_id", DQ_RULE_CONTACT_ASSOC).eq("status", "open");
    }
    const summary = {
      targets: targets.length,
      re_checked_resolved: nowResolved.length,
      auto_associated: updates.length,
      needs_manual: needsManual.length,
      update_errors: updateResult.errors,
      actions: toAssociate.filter((a)=>successfulTicketIds.has(a.ticket_id)).map((a)=>({
          ticket_id: a.ticket_id,
          contact_id: a.contact_id,
          reason: a.reason,
          client: a.client
        })),
      manual_flags: needsManual,
      hs_failures: toAssociate.length - successfulTicketIds.size
    };
    await logSuccess(startTime, targets.length, summary);
    const slackText = `🔧 DQ Remediation v${VERSION}: ${allResolvedIds.length}/${targets.length} fixed` + ` (${updates.length} auto, ${nowResolved.length} already fixed),` + ` ${needsManual.length} need manual review` + (updateResult.errors > 0 ? `, ⚠️ ${updateResult.errors} update errors` : "");
    await supabase.rpc("slack_alert", {
      p_text: slackText,
      p_emoji: ":wrench:",
      p_source: "dq-remediate-associations"
    });
    console.log(`[DONE] ${JSON.stringify(summary)}`);
    return respond({
      success: true,
      version: VERSION,
      ...summary
    });
  } catch (err) {
    console.error(`[FATAL] ${String(err)}`);
    try {
      await supabase.rpc("slack_alert", {
        p_text: `dq-remediate-associations FATAL: ${String(err)}`,
        p_emoji: ":rotating_light:",
        p_source: "dq-remediate-associations"
      });
      await supabase.from("agent_activity_log").insert({
        agent_id: AGENT_ID,
        skill_name: SKILL_NAME,
        environment: "prod",
        execution_start: new Date(startTime).toISOString(),
        execution_end: new Date().toISOString(),
        duration_seconds: (Date.now() - startTime) / 1000,
        status: "failure",
        error_message: String(err),
        triggered_by: "cron"
      });
    } catch (_) {
      console.error("[FATAL] Even error logging failed");
    }
    return respond({
      success: false,
      version: VERSION,
      error: String(err)
    }, 500);
  }
});
// ─── LOGGING HELPERS ───
async function logSuccess(startTime, recordsProcessed, summary) {
  const hasErrors = (summary.update_errors || 0) > 0 || (summary.hs_failures || 0) > 0;
  await supabase.from("sync_operations").insert({
    agent_name: "dq_remediate_associations",
    status: hasErrors ? "partial" : "success",
    total_tickets_attempted: summary.targets || 0,
    total_tickets_synced: (summary.re_checked_resolved || 0) + (summary.auto_associated || 0),
    total_failures: (summary.update_errors || 0) + (summary.hs_failures || 0),
    sync_timestamp: new Date().toISOString()
  });
  await supabase.from("agent_activity_log").insert({
    agent_id: AGENT_ID,
    skill_name: SKILL_NAME,
    environment: "prod",
    execution_start: new Date(startTime).toISOString(),
    execution_end: new Date().toISOString(),
    duration_seconds: (Date.now() - startTime) / 1000,
    status: hasErrors ? "partial" : "success",
    records_processed: recordsProcessed,
    triggered_by: "cron",
    context: summary
  });
}
function respond(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      Connection: "keep-alive"
    }
  });
}
