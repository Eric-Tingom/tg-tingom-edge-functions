import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const VERSION = '13';
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// ─── SHARED HELPERS ───
async function getHubSpotToken(supabase) {
  const { data, error } = await supabase.rpc('get_hubspot_token');
  if (error || !data) throw new Error('HubSpot token not found: ' + (error?.message || 'no data'));
  return data;
}
async function getConstants(supabase) {
  const { data } = await supabase.from('system_constants').select('constant_key, constant_value').in('constant_key', [
    'hub_id'
  ]);
  const map = {};
  for (const row of data || [])map[row.constant_key] = row.constant_value;
  return map;
}
async function getStatusMappings(supabase) {
  const { data } = await supabase.from('status_mapping').select('source_system, source_status, work_item_status, is_terminal').in('source_system', [
    'hubspot_do_it',
    'hubspot_client_actions'
  ]).eq('is_active', true);
  const map = {};
  for (const row of data || []){
    map[`${row.source_system}:${row.source_status}`] = {
      status: row.work_item_status,
      terminal: row.is_terminal
    };
  }
  return map;
}
async function getClientRegistry(supabase) {
  const { data } = await supabase.from('client_registry').select('hubspot_id, client_name');
  const map = {};
  for (const row of data || [])map[row.hubspot_id] = row.client_name;
  return map;
}
// ─── HUBSPOT BATCH HELPERS ───
async function batchReadCompanyNames(token, companyIds) {
  if (companyIds.length === 0) return {};
  const map = {};
  for(let i = 0; i < companyIds.length; i += 100){
    const chunk = companyIds.slice(i, i + 100);
    try {
      const res = await fetch('https://api.hubapi.com/crm/v3/objects/companies/batch/read', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          inputs: chunk.map((id)=>({
              id
            })),
          properties: [
            'name'
          ]
        })
      });
      if (res.ok) {
        const data = await res.json();
        for (const co of data.results || []){
          if (co.id && co.properties?.name) {
            map[String(co.id)] = co.properties.name;
          }
        }
      }
    } catch (e) {
      console.error('Company name batch error:', e);
    }
  }
  return map;
}
async function batchGetAssociations(token, objectType, toType, objectIds) {
  const found = {};
  const missing = [];
  for(let i = 0; i < objectIds.length; i += 100){
    const chunk = objectIds.slice(i, i + 100);
    try {
      const res = await fetch(`https://api.hubapi.com/crm/v4/associations/${objectType}/${toType}/batch/read`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          inputs: chunk.map((id)=>({
              id
            }))
        })
      });
      if (!res.ok) throw new Error(`Association batch failed (${res.status})`);
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
    } catch (e) {
      console.error(`Association batch error (${objectType}->${toType}):`, e);
    }
  }
  return {
    found,
    missing
  };
}
const PIPELINES = [
  {
    id: '0',
    sourceSystem: 'hubspot_client_actions',
    closedStage: '4'
  },
  {
    id: '3722904',
    sourceSystem: 'hubspot_do_it',
    closedStage: '3722908'
  }
];
const DQ_RULE_CONTACT_ASSOC = '860ab66d-0886-4a8d-930b-3e57e5b82c30';
async function searchTickets(token, pipelineId, closedStage, after) {
  const body = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'hs_pipeline',
            operator: 'EQ',
            value: pipelineId
          },
          {
            propertyName: 'hs_pipeline_stage',
            operator: 'NEQ',
            value: closedStage
          }
        ]
      }
    ],
    properties: [
      'subject',
      'content',
      'hs_pipeline_stage',
      'hs_ticket_priority',
      'hs_lastmodifieddate',
      'createdate',
      'hubspot_owner_id'
    ],
    limit: 100
  };
  if (after) body.after = after;
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/tickets/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HubSpot ticket search failed (${res.status})`);
  const data = await res.json();
  return {
    results: data.results || [],
    nextAfter: data.paging?.next?.after || null
  };
}
async function syncTickets(supabase, token, hubId, statusMap, clientMap) {
  const ticketUrlBase = `https://app.hubspot.com/contacts/${hubId}/record/0-5/`;
  const allTicketIds = [];
  const rows = [];
  const seenSourceIds = new Set();
  const errors = [];
  // PASS 1: Pull all open tickets from HubSpot
  for (const pipeline of PIPELINES){
    let after;
    let hasMore = true;
    while(hasMore){
      const page = await searchTickets(token, pipeline.id, pipeline.closedStage, after);
      for (const ticket of page.results){
        try {
          const props = ticket.properties;
          const ticketId = ticket.id;
          const key = `${pipeline.sourceSystem}:${props.hs_pipeline_stage}`;
          const mapping = statusMap[key] || {
            status: 'next',
            terminal: false
          };
          if (mapping.terminal) continue;
          allTicketIds.push(ticketId);
          seenSourceIds.add(ticketId);
          rows.push({
            ticket_id: ticketId,
            title: props.subject || 'Untitled',
            description: props.content || null,
            status: mapping.status,
            source_system: pipeline.sourceSystem,
            source_url: ticketUrlBase + ticketId,
            client_name: null,
            hubspot_company_id: null,
            hubspot_contact_id: null,
            created_at: props.createdate || ticket.createdAt,
            last_modified: props.hs_lastmodifieddate || null
          });
        } catch (e) {
          errors.push({
            ticket_id: ticket.id,
            error: String(e)
          });
        }
      }
      after = page.nextAfter || undefined;
      hasMore = !!after;
    }
  }
  // PASS 2: Batch contact associations (ticket -> contact) — UNCHANGED
  const contactAssoc = await batchGetAssociations(token, 'tickets', 'contacts', allTicketIds);
  // PASS 3 (v13): Company resolution via correct chain
  //   Tickets WITH contact  → contact → company (preferred path)
  //   Tickets WITHOUT contact → ticket → company (fallback, no regression)
  const companyForTicket = {}; // ticketId → companyId
  let companiesViaContact = 0;
  let companiesViaDirectAssoc = 0;
  // 3a: For tickets WITH contacts, batch lookup contact → company
  const ticketsWithContact = allTicketIds.filter((id)=>contactAssoc.found[id]);
  const ticketsWithoutContact = allTicketIds.filter((id)=>!contactAssoc.found[id]);
  if (ticketsWithContact.length > 0) {
    const uniqueContactIds = [
      ...new Set(Object.values(contactAssoc.found))
    ];
    const contactCompanyAssoc = await batchGetAssociations(token, 'contacts', 'companies', uniqueContactIds);
    for (const ticketId of ticketsWithContact){
      const contactId = contactAssoc.found[ticketId];
      const companyId = contactCompanyAssoc.found[contactId];
      if (companyId) {
        companyForTicket[ticketId] = companyId;
        companiesViaContact++;
      }
    }
  }
  // 3b: For tickets WITHOUT contacts, fall back to ticket → company (preserves v12 coverage)
  if (ticketsWithoutContact.length > 0) {
    const directCompanyAssoc = await batchGetAssociations(token, 'tickets', 'companies', ticketsWithoutContact);
    for (const ticketId of ticketsWithoutContact){
      const companyId = directCompanyAssoc.found[ticketId];
      if (companyId) {
        companyForTicket[ticketId] = companyId;
        companiesViaDirectAssoc++;
      }
    }
  }
  // 3c: Also check ticket → company for tickets WITH contact where contact → company failed
  const contactTicketsMissingCompany = ticketsWithContact.filter((id)=>!companyForTicket[id]);
  if (contactTicketsMissingCompany.length > 0) {
    const fallbackAssoc = await batchGetAssociations(token, 'tickets', 'companies', contactTicketsMissingCompany);
    for (const ticketId of contactTicketsMissingCompany){
      const companyId = fallbackAssoc.found[ticketId];
      if (companyId) {
        companyForTicket[ticketId] = companyId;
        companiesViaDirectAssoc++;
      }
    }
  }
  console.log(`[v${VERSION}] Company resolution: ${companiesViaContact} via contact->company, ${companiesViaDirectAssoc} via ticket->company fallback`);
  // Collect unique company IDs for name resolution
  const allCompanyIds = new Set(Object.values(companyForTicket));
  // PASS 3.5: Batch-read company names from HubSpot for IDs not in client_registry
  const unresolvedCompanyIds = [
    ...allCompanyIds
  ].filter((id)=>!clientMap[id]);
  let hubspotCompanyNames = {};
  if (unresolvedCompanyIds.length > 0) {
    hubspotCompanyNames = await batchReadCompanyNames(token, unresolvedCompanyIds);
  }
  // Enrich rows
  let contactsFound = 0;
  let contactsMissing = 0;
  let companiesFromRegistry = 0;
  let companiesFromHubspot = 0;
  const dqIssues = [];
  const resolvedContactIds = [];
  for (const row of rows){
    // Contact association
    const contactId = contactAssoc.found[row.ticket_id];
    if (contactId) {
      row.hubspot_contact_id = contactId;
      contactsFound++;
      resolvedContactIds.push(row.ticket_id);
    } else {
      row.hubspot_contact_id = null;
      contactsMissing++;
      dqIssues.push({
        record_id: row.ticket_id,
        issue_detail: `Ticket "${row.title.substring(0, 80)}" has no contact association in HubSpot. Associate to correct contact record.`
      });
    }
    // Company association (v13: uses companyForTicket which prefers contact→company chain)
    const companyId = companyForTicket[row.ticket_id];
    if (companyId) {
      row.hubspot_company_id = companyId;
      if (clientMap[companyId]) {
        row.client_name = clientMap[companyId];
        companiesFromRegistry++;
      } else if (hubspotCompanyNames[companyId]) {
        row.client_name = hubspotCompanyNames[companyId];
        companiesFromHubspot++;
      } else {
        row.client_name = null;
      }
    } else {
      row.client_name = null;
    }
  }
  // PASS 4: Upsert to Supabase
  let upsertTotal = 0;
  let upsertErrors = 0;
  for(let i = 0; i < rows.length; i += 50){
    const { data, error } = await supabase.rpc('bulk_upsert_work_items', {
      p_items: JSON.stringify(rows.slice(i, i + 50))
    });
    if (error) {
      upsertErrors += 50;
      errors.push({
        type: 'upsert',
        error: error.message
      });
    } else if (data) {
      upsertTotal += data.upserted || 0;
      upsertErrors += data.errors || 0;
    }
  }
  // Mark closed
  const { data: closedData } = await supabase.rpc('mark_closed_work_items', {
    p_open_source_ids: Array.from(seenSourceIds)
  });
  // PASS 5: DQ issues via RPCs (handles partial unique index correctly)
  let dqWritten = 0;
  let dqResolved = 0;
  if (dqIssues.length > 0) {
    const { data: dqResult } = await supabase.rpc('write_sync_dq_issues', {
      p_rule_id: DQ_RULE_CONTACT_ASSOC,
      p_issues: JSON.stringify(dqIssues)
    });
    dqWritten = dqResult?.inserted || 0;
  }
  if (resolvedContactIds.length > 0) {
    const { data: resolveResult } = await supabase.rpc('resolve_sync_dq_issues', {
      p_rule_id: DQ_RULE_CONTACT_ASSOC,
      p_resolved_record_ids: resolvedContactIds
    });
    dqResolved = resolveResult?.resolved || 0;
  }
  return {
    version: VERSION,
    total_open_tickets: rows.length,
    upserted: upsertTotal,
    upsert_errors: upsertErrors,
    newly_closed: closedData?.marked || 0,
    contacts: {
      found: contactsFound,
      missing: contactsMissing,
      dq_issues_written: dqWritten,
      dq_issues_resolved: dqResolved
    },
    companies: {
      from_registry: companiesFromRegistry,
      from_hubspot: companiesFromHubspot,
      via_contact_chain: companiesViaContact,
      via_direct_fallback: companiesViaDirectAssoc,
      no_association: allTicketIds.length - Object.keys(companyForTicket).length
    },
    errors
  };
}
// ─── DEALS SYNC ───
async function syncDeals(supabase, token) {
  const errors = [];
  const { data: periods } = await supabase.from('retainer_billing_periods').select('hubspot_deal_id').not('hubspot_deal_id', 'is', null);
  if (!periods || periods.length === 0) {
    return {
      total_deals: 0,
      updated: 0,
      errors: 0
    };
  }
  const dealIds = periods.map((p)=>p.hubspot_deal_id);
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/deals/batch/read', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      inputs: dealIds.map((id)=>({
          id
        })),
      properties: [
        'dealstage',
        'amount',
        'dealname',
        'hs_lastmodifieddate'
      ]
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot deal batch read failed (${res.status}): ${text.substring(0, 200)}`);
  }
  const data = await res.json();
  const items = (data.results || []).map((deal)=>({
      deal_id: deal.id,
      deal_stage: deal.properties?.dealstage || null,
      amount: deal.properties?.amount || null
    }));
  const { data: result, error } = await supabase.rpc('sync_billing_deal_stages', {
    p_items: JSON.stringify(items)
  });
  if (error) {
    errors.push({
      type: 'upsert',
      error: error.message
    });
  }
  return {
    total_deals: items.length,
    updated: result?.updated || 0,
    update_errors: result?.errors || 0,
    errors
  };
}
// ─── MAIN HANDLER ───
Deno.serve(async (req)=>{
  const startTime = Date.now();
  try {
    let body = {};
    try {
      body = await req.json();
    } catch (_) {}
    const mode = body.mode || 'full';
    const supabase = createClient(supabaseUrl, supabaseKey);
    const token = await getHubSpotToken(supabase);
    const constants = await getConstants(supabase);
    const hubId = constants.hub_id;
    const result = {
      success: true,
      mode,
      version: VERSION
    };
    if (mode === 'tickets' || mode === 'full') {
      const statusMap = await getStatusMappings(supabase);
      const clientMap = await getClientRegistry(supabase);
      result.tickets = await syncTickets(supabase, token, hubId, statusMap, clientMap);
    }
    if (mode === 'deals' || mode === 'full') {
      result.deals = await syncDeals(supabase, token);
    }
    // Log sync
    const totalFailures = (result.tickets?.upsert_errors || 0) + (result.deals?.update_errors || 0);
    await supabase.from('sync_operations').insert({
      agent_name: `hubspot_cache_sync_${mode}`,
      status: totalFailures > 0 ? 'partial_error' : 'success',
      total_tickets_attempted: result.tickets?.total_open_tickets || 0,
      total_tickets_synced: result.tickets?.upserted || 0,
      total_failures: totalFailures,
      sync_timestamp: new Date().toISOString()
    });
    result.duration_ms = Date.now() - startTime;
    return new Response(JSON.stringify(result), {
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    try {
      const supabase = createClient(supabaseUrl, supabaseKey);
      await supabase.rpc('slack_alert', {
        p_text: `hubspot-cache-sync FATAL: ${String(err)}`,
        p_emoji: ':rotating_light:',
        p_source: 'hubspot-cache-sync'
      });
    } catch (_) {}
    return new Response(JSON.stringify({
      success: false,
      fatal: true,
      error: String(err),
      duration_ms: Date.now() - startTime
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
});
