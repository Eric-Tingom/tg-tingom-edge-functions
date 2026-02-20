import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data: orphanItems, error: fetchErr } = await supabase
      .from("work_items")
      .select("id, source_id, source_system")
      .is("client_name", null)
      .eq("source_system", "hubspot_ticket")
      .limit(50);
    if (fetchErr) throw fetchErr;
    if (!orphanItems || orphanItems.length === 0) {
      return new Response(JSON.stringify({ message: "No orphan work items found", enriched: 0 }), { headers: { "Content-Type": "application/json" } });
    }
    const { data: tokenData } = await supabase.from("decrypted_secrets").select("decrypted_secret").eq("name", "hubspot_access_token").single();
    const hubspotToken = tokenData?.decrypted_secret;
    if (!hubspotToken) {
      return new Response(JSON.stringify({ error: "HubSpot token not found in vault" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    let enriched = 0; let newClients = 0;
    for (const item of orphanItems) {
      try {
        const assocRes = await fetch(`https://api.hubapi.com/crm/v4/objects/tickets/${item.source_id}/associations/companies`, { headers: { "Authorization": `Bearer ${hubspotToken}` } });
        if (!assocRes.ok) continue;
        const assocData = await assocRes.json();
        const companyIds = assocData.results?.map((r: any) => r.toObjectId) || [];
        if (companyIds.length === 0) continue;
        const companyId = String(companyIds[0]);
        const { data: existing } = await supabase.from("client_registry").select("client_name").eq("hubspot_id", companyId).single();
        let clientName: string;
        if (existing) {
          clientName = existing.client_name;
        } else {
          const compRes = await fetch(`https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=name,domain`, { headers: { "Authorization": `Bearer ${hubspotToken}` } });
          if (!compRes.ok) continue;
          const compData = await compRes.json();
          clientName = compData.properties?.name || `Company ${companyId}`;
          const domain = compData.properties?.domain || null;
          await supabase.from("client_registry").upsert({ hubspot_id: companyId, client_name: clientName, domain, is_internal: false, health_status: "GREEN" }, { onConflict: "hubspot_id" });
          newClients++;
        }
        await supabase.from("work_items").update({ client_name: clientName, hubspot_company_id: companyId, needs_review: false }).eq("id", item.id);
        enriched++;
      } catch (itemErr) { console.error(`Failed to enrich work item ${item.id}:`, itemErr); }
    }
    return new Response(JSON.stringify({ message: `Enriched ${enriched}/${orphanItems.length} work items`, enriched, newClientsAdded: newClients, totalOrphans: orphanItems.length }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});