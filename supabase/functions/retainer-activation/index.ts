import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const VERSION = '1.1.0';
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
// Pipeline ID → first ("new") stage ID mapping
const PIPELINE_FIRST_STAGE = {
  '0': '1',
  '3722904': '3722905'
};
Deno.serve(async (req)=>{
  const supabase = createClient(supabaseUrl, supabaseKey);
  try {
    const body = await req.json();
    const { action } = body;
    if (action === 'activate') {
      return await handleActivation(supabase, body);
    }
    return respond({
      error: 'Unknown action. Use activate',
      version: VERSION
    }, 400);
  } catch (err) {
    const errMsg = `retainer-activation FATAL: ${String(err)}`;
    try {
      await supabase.rpc('slack_alert', {
        p_text: errMsg,
        p_emoji: ':rotating_light:',
        p_source: 'retainer-activation'
      });
    } catch (_) {}
    return respond({
      error: errMsg,
      version: VERSION
    }, 500);
  }
});
async function handleActivation(supabase, body) {
  const activationStart = Date.now();
  const targetDate = body.target_date ? new Date(body.target_date) : new Date();
  const weekStart = getMonday(targetDate);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const weekStartStr = weekStart.toISOString().split('T')[0];
  const weekEndStr = weekEnd.toISOString().split('T')[0];
  let totalProcessed = 0;
  let ticketsCreated = 0;
  let trelloCardsCreated = 0;
  let ticketsLinked = 0;
  let skipped = 0;
  const errors = [];
  const perClient = {};
  try {
    // 1. Get planned items for target week
    const { data: items, error: itemsErr } = await supabase.from('retainer_calendar_items').select('*').eq('status', 'planned').gte('scheduled_date', weekStartStr).lte('scheduled_date', weekEndStr);
    if (itemsErr) throw new Error(`Failed to load retainer items: ${itemsErr.message}`);
    if (!items || items.length === 0) {
      await logSync(supabase, 'success', 0, 0, 0, weekStartStr);
      return respond({
        message: `No planned items for week of ${weekStartStr}`,
        version: VERSION
      });
    }
    // 2. Get Trello board configs
    const { data: trelloBoards } = await supabase.from('trello_board_config').select('*').eq('is_active', true);
    const trelloBoardMap = {};
    for (const b of trelloBoards || []){
      trelloBoardMap[b.hubspot_company_id] = b;
    }
    // 3. Get credentials
    const { data: hsKey } = await supabase.rpc('get_hubspot_token');
    if (!hsKey) throw new Error('HubSpot API key not found in vault');
    const { data: trelloSecrets } = await supabase.rpc('get_trello_secrets');
    const hasTrelloCreds = trelloSecrets?.api_key && trelloSecrets?.api_token;
    // 4. Process each item
    for (const item of items){
      totalProcessed++;
      const clientShort = getClientShort(item.client_name);
      const ticketSubject = `${clientShort} - Retainer - ${item.activity_name}`;
      if (!perClient[item.client_name]) perClient[item.client_name] = {
        activated: 0,
        errors: 0
      };
      try {
        let hubspotTicketId = item.hubspot_ticket_id;
        let trelloCardId = item.trello_card_id;
        // === DEDUPE: Check for existing HubSpot ticket ===
        if (!hubspotTicketId) {
          const { data: existingTickets } = await supabase.from('work_items').select('source_id, title').eq('hubspot_company_id', item.hubspot_company_id).ilike('title', `%${item.activity_name}%`).limit(1);
          if (existingTickets && existingTickets.length > 0) {
            hubspotTicketId = existingTickets[0].source_id;
            ticketsLinked++;
          }
        }
        // === CREATE HUBSPOT TICKET ===
        if (!hubspotTicketId) {
          const stageId = PIPELINE_FIRST_STAGE[item.hubspot_pipeline] || '1';
          const ticketResult = await createHubSpotTicket(hsKey, ticketSubject, item.hubspot_pipeline, stageId, item.hubspot_company_id);
          if (ticketResult.error) {
            errors.push({
              item: item.activity_name,
              step: 'hubspot_ticket',
              error: ticketResult.error
            });
            perClient[item.client_name].errors++;
            continue;
          }
          hubspotTicketId = ticketResult.ticket_id;
          ticketsCreated++;
        }
        // === DEDUPE: Check for existing Trello card ===
        if (!trelloCardId && trelloBoardMap[item.hubspot_company_id] && hasTrelloCreds) {
          if (hubspotTicketId) {
            const { data: existingCards } = await supabase.from('trello_card_cache').select('card_id').eq('hubspot_ticket_id', String(hubspotTicketId)).limit(1);
            if (existingCards && existingCards.length > 0) {
              trelloCardId = existingCards[0].card_id;
            }
          }
        }
        // === CREATE TRELLO CARD ===
        if (!trelloCardId && trelloBoardMap[item.hubspot_company_id] && hasTrelloCreds) {
          const board = trelloBoardMap[item.hubspot_company_id];
          const todoListId = getListIdByPurpose(board.list_mapping, 'new_action_items') || board.default_list_id;
          const hsTicketUrl = `https://app.hubspot.com/contacts/4736045/record/0-5/${hubspotTicketId}`;
          const cardDesc = `HubSpot Ticket: ${hsTicketUrl}\n\nContent Type: ${item.content_type || 'N/A'}\nOwner: ${item.owner || 'N/A'}`;
          const cardResult = await createTrelloCard(trelloSecrets.api_key, trelloSecrets.api_token, todoListId, ticketSubject, cardDesc, board.default_assignee_member_id, item.scheduled_date);
          if (cardResult.error) {
            errors.push({
              item: item.activity_name,
              step: 'trello_card',
              error: cardResult.error
            });
          } else {
            trelloCardId = cardResult.card_id;
            trelloCardsCreated++;
          }
        }
        // === UPDATE retainer_calendar_items ===
        const updatePayload = {
          status: 'activated',
          updated_at: new Date().toISOString()
        };
        if (hubspotTicketId) updatePayload.hubspot_ticket_id = String(hubspotTicketId);
        if (trelloCardId) updatePayload.trello_card_id = trelloCardId;
        const { error: updateErr } = await supabase.from('retainer_calendar_items').update(updatePayload).eq('id', item.id);
        if (updateErr) {
          errors.push({
            item: item.activity_name,
            step: 'update_status',
            error: updateErr.message
          });
          perClient[item.client_name].errors++;
        } else {
          perClient[item.client_name].activated++;
        }
      } catch (itemErr) {
        errors.push({
          item: item.activity_name,
          step: 'unknown',
          error: String(itemErr)
        });
        perClient[item.client_name].errors++;
      }
    }
    // 5. Log
    const status = errors.length > 0 ? errors.length === totalProcessed ? 'failed' : 'partial' : 'success';
    await logSync(supabase, status, totalProcessed, ticketsCreated + ticketsLinked + trelloCardsCreated, errors.length, weekStartStr);
    // 6. Slack summary
    const clientSummary = Object.entries(perClient).map(([name, stats])=>`  \u2022 ${name}: ${stats.activated} activated${stats.errors > 0 ? `, ${stats.errors} errors` : ''}`).join('\n');
    const slackMsg = `\u2705 Retainer Activation \u2014 Week of ${weekStartStr}\n\n` + `Items: ${totalProcessed} processed\n` + `Tickets: ${ticketsCreated} created, ${ticketsLinked} linked (existing)\n` + `Trello: ${trelloCardsCreated} cards created\n` + `Skipped: ${skipped}\n` + (errors.length > 0 ? `\u26a0\ufe0f Errors: ${errors.length}\n` : '') + `\n${clientSummary}`;
    await supabase.rpc('slack_alert', {
      p_text: slackMsg,
      p_emoji: errors.length > 0 ? ':warning:' : ':white_check_mark:',
      p_source: 'retainer-activation'
    });
    return respond({
      version: VERSION,
      status,
      week: weekStartStr,
      total_processed: totalProcessed,
      tickets_created: ticketsCreated,
      tickets_linked: ticketsLinked,
      trello_cards_created: trelloCardsCreated,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      per_client: perClient,
      duration_ms: Date.now() - activationStart
    });
  } catch (err) {
    await logSync(supabase, 'failed', totalProcessed, 0, totalProcessed, weekStartStr);
    await supabase.rpc('slack_alert', {
      p_text: `retainer-activation FAILED: ${String(err)}`,
      p_emoji: ':rotating_light:',
      p_source: 'retainer-activation'
    });
    return respond({
      error: String(err),
      version: VERSION
    }, 500);
  }
}
async function createHubSpotTicket(apiKey, subject, pipelineId, stageId, companyId) {
  try {
    const body = {
      properties: {
        subject,
        hs_pipeline: pipelineId,
        hs_pipeline_stage: stageId
      },
      associations: [
        {
          to: {
            id: companyId
          },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: 26
            }
          ]
        }
      ]
    };
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/tickets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (res.status === 201) {
      return {
        ticket_id: data.id
      };
    } else {
      return {
        error: `HubSpot ${res.status}: ${JSON.stringify(data).substring(0, 300)}`
      };
    }
  } catch (err) {
    return {
      error: String(err)
    };
  }
}
async function createTrelloCard(apiKey, apiToken, listId, name, desc, memberId, dueDate) {
  try {
    const params = new URLSearchParams({
      key: apiKey,
      token: apiToken,
      idList: listId,
      name,
      desc
    });
    if (memberId) params.append('idMembers', memberId);
    if (dueDate) params.append('due', dueDate);
    const res = await fetch('https://api.trello.com/1/cards', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const data = await res.json();
    if (res.ok) {
      return {
        card_id: data.id
      };
    } else {
      return {
        error: `Trello ${res.status}: ${JSON.stringify(data).substring(0, 300)}`
      };
    }
  } catch (err) {
    return {
      error: String(err)
    };
  }
}
function getClientShort(clientName) {
  const parts = clientName.split(' ');
  if (parts.length > 1 && [
    'financial',
    'wealth',
    'advisers',
    'advisors',
    'llc',
    'group',
    'management',
    'strategies'
  ].includes(parts[parts.length - 1].toLowerCase())) {
    return parts.slice(0, -1).join(' ');
  }
  return parts[0];
}
function getListIdByPurpose(listMapping, purpose) {
  const list = (listMapping || []).find((l)=>l.purpose === purpose);
  return list?.id || null;
}
function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
async function logSync(supabase, status, attempted, synced, failures, weekStart) {
  await supabase.from('sync_operations').insert({
    agent_name: 'retainer_activation',
    status,
    total_tickets_attempted: attempted,
    total_tickets_synced: synced,
    total_failures: failures,
    sync_timestamp: new Date().toISOString()
  });
}
function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Connection': 'keep-alive'
    }
  });
}
