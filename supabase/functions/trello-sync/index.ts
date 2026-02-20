import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const VERSION = '2.2.0';
const ACTIVE_PURPOSES = [
  'new_action_items',
  'in_progress',
  'compliance_draft',
  'compliance_review',
  'ready_to_publish'
];
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
Deno.serve(async (req)=>{
  const supabase = createClient(supabaseUrl, supabaseKey);
  try {
    const body = await req.json();
    const { action } = body;
    // Get Trello credentials via RPC (reads trello_api_key + trello_token from vault)
    const { data: secrets, error: secretsErr } = await supabase.rpc('get_trello_secrets');
    if (secretsErr || !secrets?.api_key || !secrets?.api_token) {
      const errMsg = `trello-sync FATAL: Trello credentials not found \u2014 ${secretsErr?.message || 'missing api_key or api_token'}`;
      await supabase.rpc('slack_alert', {
        p_text: errMsg,
        p_emoji: ':rotating_light:',
        p_source: 'trello-sync'
      });
      return respond({
        error: errMsg,
        version: VERSION
      }, 500);
    }
    const apiKey = secrets.api_key;
    const apiToken = secrets.api_token;
    // === ACTION: get_board_info (preserved from v1) ===
    if (action === 'get_board_info') {
      const boardId = body.board_id;
      const [listsRes, membersRes] = await Promise.all([
        fetch(`https://api.trello.com/1/boards/${boardId}/lists?key=${apiKey}&token=${apiToken}`),
        fetch(`https://api.trello.com/1/boards/${boardId}/members?key=${apiKey}&token=${apiToken}`)
      ]);
      return respond({
        lists: await listsRes.json(),
        members: await membersRes.json(),
        version: VERSION
      });
    }
    // === ACTION: create_card (preserved from v1) ===
    if (action === 'create_card') {
      const { list_id, name, desc, member_id, due } = body;
      const params = new URLSearchParams({
        key: apiKey,
        token: apiToken,
        idList: list_id,
        name,
        desc: desc || ''
      });
      if (member_id) params.append('idMembers', member_id);
      if (due) params.append('due', due);
      const res = await fetch('https://api.trello.com/1/cards', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });
      return respond({
        ...await res.json(),
        version: VERSION
      });
    }
    // === ACTION: sync ===
    if (action === 'sync') {
      return await handleSync(supabase, apiKey, apiToken);
    }
    return respond({
      error: 'Unknown action. Use get_board_info, create_card, or sync',
      version: VERSION
    }, 400);
  } catch (err) {
    const errMsg = `trello-sync FATAL: ${String(err)}`;
    try {
      await supabase.rpc('slack_alert', {
        p_text: errMsg,
        p_emoji: ':rotating_light:',
        p_source: 'trello-sync'
      });
    } catch (_) {}
    return respond({
      error: errMsg,
      version: VERSION
    }, 500);
  }
});
async function handleSync(supabase, apiKey, apiToken) {
  const syncStart = Date.now();
  let totalAttempted = 0;
  let totalSynced = 0;
  let totalFailures = 0;
  const orphanCards = [];
  try {
    // 1. Get all active boards
    const { data: boards, error: boardErr } = await supabase.from('trello_board_config').select('*').eq('is_active', true);
    if (boardErr) throw new Error(`Failed to load board config: ${boardErr.message}`);
    if (!boards || boards.length === 0) {
      return respond({
        message: 'No active boards configured',
        synced: 0,
        version: VERSION
      });
    }
    const allSyncedCardIds = [];
    for (const board of boards){
      // 2. Build active list IDs + lookups from board config
      const activeListIds = [];
      const listLookup = {};
      for (const list of board.list_mapping || []){
        if (ACTIVE_PURPOSES.includes(list.purpose)) {
          activeListIds.push(list.id);
          listLookup[list.id] = {
            name: list.name,
            purpose: list.purpose
          };
        }
      }
      const memberLookup = {};
      for (const m of board.member_mapping || []){
        memberLookup[m.id] = m.fullName;
      }
      // 3. Fetch ALL cards from board via Trello API
      const cardsRes = await fetch(`https://api.trello.com/1/boards/${board.board_id}/cards?key=${apiKey}&token=${apiToken}&fields=name,desc,url,due,dateLastActivity,idList,idMembers,labels`);
      if (!cardsRes.ok) {
        const errText = await cardsRes.text();
        throw new Error(`Trello API ${cardsRes.status} for board ${board.board_id}: ${errText}`);
      }
      const allCards = await cardsRes.json();
      // 4. Filter to active lists only
      const activeCards = allCards.filter((c)=>activeListIds.includes(c.idList));
      totalAttempted += activeCards.length;
      // 5. Match each card to HubSpot + build upsert rows
      const upsertRows = [];
      for (const card of activeCards){
        const listInfo = listLookup[card.idList] || {
          name: 'Unknown',
          purpose: 'unknown'
        };
        const memberNames = (card.idMembers || []).map((mid)=>memberLookup[mid] || mid);
        // Deterministic match: parse HubSpot ticket URL from card description
        let hubspotTicketId = null;
        let matchMethod = 'unmatched';
        const hsUrlMatch = (card.desc || '').match(/HubSpot Ticket:.*\/record\/0-5\/([0-9]+)/);
        if (hsUrlMatch) {
          hubspotTicketId = hsUrlMatch[1];
          matchMethod = 'deterministic';
        }
        // Fuzzy match: search work_items by card name for same client
        if (!hubspotTicketId) {
          const cardNameClean = card.name.replace(/[^a-zA-Z0-9\s]/g, '').trim();
          if (cardNameClean.length > 3) {
            const { data: matchedItems } = await supabase.from('work_items').select('hubspot_ticket_id, title').eq('hubspot_company_id', board.hubspot_company_id).ilike('title', `%${cardNameClean.substring(0, 40)}%`).limit(1);
            if (matchedItems && matchedItems.length > 0) {
              hubspotTicketId = String(matchedItems[0].hubspot_ticket_id);
              matchMethod = 'fuzzy';
            }
          }
        }
        if (!hubspotTicketId) {
          orphanCards.push({
            card_name: card.name,
            card_url: card.url,
            board_name: board.board_name,
            list_name: listInfo.name,
            client_name: board.client_name,
            assigned_to: memberNames.length > 0 ? memberNames.join(', ') : 'Unassigned'
          });
        }
        upsertRows.push({
          card_id: card.id,
          board_id: board.board_id,
          list_id: card.idList,
          list_name: listInfo.name,
          list_purpose: listInfo.purpose,
          card_name: card.name,
          card_desc: (card.desc || '').substring(0, 2000),
          card_url: card.url,
          due_date: card.due || null,
          assigned_member_ids: card.idMembers || [],
          assigned_member_names: memberNames,
          labels: card.labels || [],
          last_activity: card.dateLastActivity || null,
          client_name: board.client_name,
          hubspot_company_id: board.hubspot_company_id,
          hubspot_ticket_id: hubspotTicketId,
          match_method: matchMethod,
          synced_at: new Date().toISOString()
        });
        allSyncedCardIds.push(card.id);
      }
      // 6. Upsert cards
      if (upsertRows.length > 0) {
        const { error: upsertErr } = await supabase.from('trello_card_cache').upsert(upsertRows, {
          onConflict: 'card_id'
        });
        if (upsertErr) {
          totalFailures += upsertRows.length;
          throw new Error(`Upsert failed for board ${board.board_id}: ${upsertErr.message}`);
        }
        totalSynced += upsertRows.length;
      }
    }
    // 7. Delete cards no longer in active lists
    if (allSyncedCardIds.length > 0) {
      const { error: deleteErr } = await supabase.from('trello_card_cache').delete().not('card_id', 'in', `(${allSyncedCardIds.join(',')})`);
      if (deleteErr) console.warn('Delete stale cards warning:', deleteErr.message);
    } else {
      const { error: clearErr } = await supabase.from('trello_card_cache').delete().neq('card_id', '__never_match__');
      if (clearErr) console.warn('Clear cache warning:', clearErr.message);
    }
    // 8. Slack alert for orphaned cards — grouped by assignee
    if (orphanCards.length > 0) {
      // Group orphans by assigned_to
      const byAssignee = {};
      for (const c of orphanCards){
        const key = c.assigned_to;
        if (!byAssignee[key]) byAssignee[key] = [];
        byAssignee[key].push(c);
      }
      const sections = Object.entries(byAssignee).map(([assignee, cards])=>{
        const cardList = cards.map((c)=>`  \u2022 ${c.card_name} (${c.list_name})`).join('\n');
        return `*${assignee}* (${cards.length}):\n${cardList}`;
      }).join('\n\n');
      await supabase.rpc('slack_alert', {
        p_text: `\ud83d\udfe0 Trello Orphans \u2014 ${orphanCards.length} card(s) on *${orphanCards[0].board_name}* (${orphanCards[0].client_name}) with no matching HubSpot ticket:\n\n${sections}`,
        p_emoji: ':warning:',
        p_source: 'trello-sync'
      });
    }
    // 9. Log to sync_operations
    const status = totalFailures > 0 ? 'partial' : 'success';
    await supabase.from('sync_operations').insert({
      agent_name: 'trello_sync',
      status,
      total_tickets_attempted: totalAttempted,
      total_tickets_synced: totalSynced,
      total_failures: totalFailures,
      sync_timestamp: new Date().toISOString()
    });
    return respond({
      version: VERSION,
      status,
      boards_synced: boards.length,
      cards_attempted: totalAttempted,
      cards_synced: totalSynced,
      cards_failed: totalFailures,
      orphan_cards: orphanCards.length,
      orphan_details: orphanCards,
      duration_ms: Date.now() - syncStart
    });
  } catch (err) {
    await supabase.from('sync_operations').insert({
      agent_name: 'trello_sync',
      status: 'failed',
      total_tickets_attempted: totalAttempted,
      total_tickets_synced: totalSynced,
      total_failures: totalAttempted,
      sync_timestamp: new Date().toISOString()
    });
    await supabase.rpc('slack_alert', {
      p_text: `trello-sync SYNC FAILED: ${String(err)}`,
      p_emoji: ':rotating_light:',
      p_source: 'trello-sync'
    });
    return respond({
      error: String(err),
      version: VERSION,
      cards_attempted: totalAttempted,
      cards_synced: totalSynced
    }, 500);
  }
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
