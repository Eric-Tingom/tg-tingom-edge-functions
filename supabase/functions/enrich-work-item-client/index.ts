import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
Deno.serve(async (req)=>{
  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    // Find work items missing client data (that came from HubSpot)
    const { data: orphanItems, error: fetchErr } = await supabase.from('work_items').select('id, source_id, source_system').is('client_name', null).eq('source_system', 'hubspot_ticket').limit(50);
    if (fetchErr) throw fetchErr;
    if (!orphanItems || orphanItems.length === 0) {
      return new Response(JSON.stringify({
        message: 'No orphan work items found',
        enriched: 0
      }), {
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    // Get HubSpot token from vault
    const { data: tokenData } = await supabase.from('decrypted_secrets').select('decrypted_secret').eq('name', 'hubspot_access_token').single();
    const hubspotToken = tokenData?.decrypted_secret;
    if (!hubspotToken) {
      return new Response(JSON.stringify({
        error: 'HubSpot token not found in vault'
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    let enriched = 0;
    let newClients = 0;
    for (const item of orphanItems){
      try {
        // Look up ticket's associated companies via HubSpot API
        const assocRes = await fetch(`https://api.hubapi.com/crm/v4/objects/tickets/${item.source_id}/associations/companies`, {
          headers: {
            'Authorization': `Bearer ${hubspotToken}`
          }
        });
        if (!assocRes.ok) continue;
        const assocData = await assocRes.json();
        const companyIds = assocData.results?.map((r)=>r.toObjectId) || [];
        if (companyIds.length === 0) continue;
        const companyId = String(companyIds[0]);
        // Check if company exists in client_registry
        const { data: existing } = await supabase.from('client_registry').select('client_name').eq('hubspot_id', companyId).single();
        let clientName;
        if (existing) {
          clientName = existing.client_name;
        } else {
          // Fetch company name from HubSpot and add to registry
          const compRes = await fetch(`https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=name,domain`, {
            headers: {
              'Authorization': `Bearer ${hubspotToken}`
            }
          });
          if (!compRes.ok) continue;
          const compData = await compRes.json();
          clientName = compData.properties?.name || `Company ${companyId}`;
          const domain = compData.properties?.domain || null;
          // Auto-add to client_registry for future local lookups
          await supabase.from('client_registry').upsert({
            hubspot_id: companyId,
            client_name: clientName,
            domain: domain,
            is_internal: false,
            health_status: 'GREEN'
          }, {
            onConflict: 'hubspot_id'
          });
          newClients++;
        }
        // Update the work item
        await supabase.from('work_items').update({
          client_name: clientName,
          hubspot_company_id: companyId,
          needs_review: false
        }).eq('id', item.id);
        enriched++;
      } catch (itemErr) {
        console.error(`Failed to enrich work item ${item.id}:`, itemErr);
      }
    }
    return new Response(JSON.stringify({
      message: `Enriched ${enriched}/${orphanItems.length} work items`,
      enriched,
      newClientsAdded: newClients,
      totalOrphans: orphanItems.length
    }), {
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: String(err)
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
});
