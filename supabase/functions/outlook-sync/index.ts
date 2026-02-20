import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
async function sendSlackAlert(webhookUrl, functionName, errors) {
  try {
    const errorList = errors.map((e)=>`\u2022 ${e}`).join("\n");
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: `:rotating_light: *${functionName} Failed*\n\n${errorList}\n\n_${new Date().toISOString()}_`
      })
    });
  } catch (_) {}
}
function stripHtml(html) {
  let text = html;
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/&amp;/gi, "&");
  text = text.replace(/&lt;/gi, "<");
  text = text.replace(/&gt;/gi, ">");
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/&#x27;/gi, "'");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n\s*\n/g, "\n");
  return text.trim();
}
async function refreshToken(sb, r) {
  try {
    const { data: secrets, error: rpcErr } = await sb.rpc("get_msgraph_secrets");
    if (rpcErr || !secrets) {
      r.errors.push(`get_msgraph_secrets RPC failed: ${rpcErr?.message || 'no data'}`);
      return null;
    }
    const clientId = secrets.client_id;
    const clientSecret = secrets.client_secret;
    const tenantId = secrets.tenant_id;
    if (!clientId || !clientSecret || !tenantId) {
      r.errors.push("Missing MS Graph creds from vault");
      return null;
    }
    const { data: tokenRow } = await sb.from("msgraph_tokens").select("refresh_token").eq("id", 1).single();
    if (!tokenRow?.refresh_token) {
      r.errors.push("No refresh token");
      return null;
    }
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokenRow.refresh_token,
      grant_type: "refresh_token",
      scope: "https://graph.microsoft.com/.default offline_access"
    });
    const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });
    if (!tokenRes.ok) {
      r.errors.push(`Token refresh failed: ${tokenRes.status} - ${await tokenRes.text()}`);
      return null;
    }
    const td = await tokenRes.json();
    await sb.from("msgraph_tokens").update({
      access_token: td.access_token,
      refresh_token: td.refresh_token || tokenRow.refresh_token,
      expires_at: new Date(Date.now() + (td.expires_in || 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", 1);
    r.token_refreshed = true;
    return td.access_token;
  } catch (err) {
    r.errors.push(`Token refresh exception: ${String(err)}`);
    return null;
  }
}
function jsonResponse(d, s = 200) {
  return new Response(JSON.stringify(d, null, 2), {
    status: s,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
Deno.serve(async (req)=>{
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const result = {
    emails_synced: 0,
    emails_skipped: 0,
    calendar_synced: 0,
    calendar_skipped: 0,
    clients_matched: 0,
    errors: [],
    token_refreshed: false,
    classifier_triggered: false,
    classifier_result: null
  };
  let slackUrl = null;
  try {
    try {
      const { data: procSecrets } = await supabase.rpc("get_processor_secrets");
      if (procSecrets?.slack_webhook_url) slackUrl = procSecrets.slack_webhook_url;
    } catch (_) {}
    let accessToken = await refreshToken(supabase, result);
    if (!accessToken) {
      if (slackUrl) await sendSlackAlert(slackUrl, "outlook-sync", result.errors);
      return jsonResponse({
        error: "Could not obtain valid MS Graph token",
        details: result.errors
      }, 500);
    }
    const { data: clients } = await supabase.from("client_registry").select("hubspot_id, client_name, domain").not("domain", "is", null);
    const domainToClient = {};
    for (const c of clients || []){
      if (c.domain) domainToClient[c.domain.toLowerCase()] = {
        hubspot_id: c.hubspot_id,
        client_name: c.client_name
      };
    }
    // SYNC UNREAD OUTLOOK EMAILS
    try {
      const sinceDate = "2025-11-18T00:00:00Z";
      const emailUrl = `${GRAPH_BASE}/me/mailFolders/inbox/messages?$filter=isRead eq false and receivedDateTime ge ${sinceDate}&$orderby=receivedDateTime desc&$top=200&$select=id,subject,from,receivedDateTime,conversationId,internetMessageId,bodyPreview,body,isRead`;
      const emailRes = await fetch(emailUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });
      if (!emailRes.ok) {
        throw new Error(`Email fetch failed: ${emailRes.status} - ${await emailRes.text()}`);
      }
      const messages = (await emailRes.json()).value || [];
      for (const msg of messages){
        try {
          const senderEmail = msg.from?.emailAddress?.address?.toLowerCase() || "";
          const senderDomain = senderEmail.split("@")[1] || "";
          const messageId = msg.id;
          const { data: existing } = await supabase.from("email_monitoring_queue").select("id").eq("message_id", messageId).maybeSingle();
          if (existing) {
            await supabase.from("email_monitoring_queue").update({
              last_seen_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }).eq("id", existing.id);
            result.emails_skipped++;
            continue;
          }
          const clientMatch = domainToClient[senderDomain] || null;
          let bodyPreview;
          if (clientMatch && msg.body?.content) {
            bodyPreview = stripHtml(msg.body.content).substring(0, 1500);
          } else {
            bodyPreview = (msg.bodyPreview || "").substring(0, 500);
          }
          const queueRecord = {
            message_id: messageId,
            mailbox: "outlook",
            sender_email: senderEmail,
            sender_domain: senderDomain,
            subject: msg.subject || "(no subject)",
            received_at: msg.receivedDateTime,
            thread_id: msg.conversationId || null,
            internet_message_id: msg.internetMessageId || null,
            body_preview: bodyPreview,
            status: "new",
            requires_action: true,
            client_identified: !!clientMatch,
            client_confidence: clientMatch ? "high" : null,
            hubspot_company_id: clientMatch?.hubspot_id || null,
            last_seen_at: new Date().toISOString()
          };
          const { error: insertErr } = await supabase.from("email_monitoring_queue").insert(queueRecord);
          if (insertErr) {
            result.errors.push(`Email insert failed for ${messageId}: ${insertErr.message}`);
          } else {
            result.emails_synced++;
            if (clientMatch) result.clients_matched++;
          }
        } catch (msgErr) {
          result.errors.push(`Failed processing message: ${String(msgErr)}`);
        }
      }
    } catch (emailErr) {
      result.errors.push(`Email sync error: ${String(emailErr)}`);
    }
    // SYNC OUTLOOK CALENDAR
    try {
      const now = new Date();
      const mstOffset = -7 * 60 * 60 * 1000;
      const mstNow = new Date(now.getTime() + mstOffset);
      const todayStart = new Date(Date.UTC(mstNow.getUTCFullYear(), mstNow.getUTCMonth(), mstNow.getUTCDate(), 7, 0, 0));
      const dayAfterTomorrow = new Date(todayStart.getTime() + 2 * 24 * 60 * 60 * 1000);
      const calUrl = `${GRAPH_BASE}/me/calendarView?startDateTime=${todayStart.toISOString()}&endDateTime=${dayAfterTomorrow.toISOString()}&$orderby=start/dateTime&$top=50&$select=id,subject,start,end,location,isAllDay,isCancelled,organizer,attendees,onlineMeeting,bodyPreview,responseStatus,webLink`;
      const calRes = await fetch(calUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: 'outlook.timezone="America/Phoenix"'
        }
      });
      if (!calRes.ok) throw new Error(`Calendar fetch failed: ${calRes.status} - ${await calRes.text()}`);
      const events = (await calRes.json()).value || [];
      const todayDateStr = todayStart.toISOString().split("T")[0];
      const tomorrowDateStr = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      await supabase.from("calendar_cache").delete().in("event_date", [
        todayDateStr,
        tomorrowDateStr
      ]);
      for (const evt of events){
        try {
          const subjectLower = (evt.subject || "").toLowerCase();
          if (subjectLower.includes("focus time")) {
            result.calendar_skipped++;
            continue;
          }
          const startTzSuffix = evt.start?.timeZone === "UTC" ? "Z" : "-07:00";
          const endTzSuffix = evt.end?.timeZone === "UTC" ? "Z" : "-07:00";
          const startDt = new Date(evt.start?.dateTime + startTzSuffix);
          const endDt = new Date(evt.end?.dateTime + endTzSuffix);
          const eventDate = evt.start?.dateTime?.split("T")[0] || todayDateStr;
          let matchedClient = null;
          const allEmails = [
            evt.organizer?.emailAddress?.address,
            ...(evt.attendees || []).map((a)=>a.emailAddress?.address)
          ].filter(Boolean);
          for (const email of allEmails){
            const domain = email.toLowerCase().split("@")[1];
            if (domain && domain !== "tingomgroup.net" && domain !== "flowops360.ai" && domainToClient[domain]) {
              matchedClient = domainToClient[domain];
              break;
            }
          }
          const calRecord = {
            event_id: evt.id,
            event_date: eventDate,
            start_time: startDt.toISOString(),
            end_time: endDt.toISOString(),
            subject: evt.subject || "(no subject)",
            location: evt.location?.displayName || null,
            is_online: !!(evt.onlineMeeting?.joinUrl || evt.location?.displayName?.includes("Teams")),
            online_meeting_url: evt.onlineMeeting?.joinUrl || null,
            organizer_name: evt.organizer?.emailAddress?.name || null,
            organizer_email: evt.organizer?.emailAddress?.address || null,
            attendees: JSON.stringify((evt.attendees || []).map((a)=>({
                name: a.emailAddress?.name,
                email: a.emailAddress?.address,
                response: a.status?.response
              }))),
            body_preview: (evt.bodyPreview || "").substring(0, 500),
            is_all_day: evt.isAllDay || false,
            is_cancelled: evt.isCancelled || false,
            response_status: evt.responseStatus?.response || null,
            hubspot_company_id: matchedClient?.hubspot_id || null,
            client_name: matchedClient?.client_name || null,
            synced_at: new Date().toISOString()
          };
          const { error: calInsertErr } = await supabase.from("calendar_cache").upsert(calRecord, {
            onConflict: "event_id,event_date"
          });
          if (calInsertErr) result.errors.push(`Cal insert fail ${evt.id}: ${calInsertErr.message}`);
          else result.calendar_synced++;
        } catch (evtErr) {
          result.errors.push(`Event fail: ${String(evtErr)}`);
        }
      }
    } catch (calErr) {
      result.errors.push(`Calendar sync error: ${String(calErr)}`);
    }
    // CHAIN: Trigger email-classifier
    try {
      const classifierRes = await fetch(`${SUPABASE_URL}/functions/v1/email-classifier`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          triggered_by: "outlook-sync"
        })
      });
      result.classifier_triggered = true;
      if (classifierRes.ok) {
        result.classifier_result = await classifierRes.json();
      } else {
        const errText = await classifierRes.text();
        result.errors.push(`Classifier chain failed: ${classifierRes.status} - ${errText.substring(0, 300)}`);
        result.classifier_result = {
          error: true,
          status: classifierRes.status
        };
      }
    } catch (chainErr) {
      result.errors.push(`Classifier chain exception: ${String(chainErr)}`);
      result.classifier_result = {
        error: true,
        message: String(chainErr)
      };
    }
    // Log to sync_operations for Integration Architect staleness detection
    // Note: calendar_skipped (Focus Time events) are intentional filters, not sync attempts
    // emails_skipped are already-existing emails that were re-checked successfully
    await supabase.from('sync_operations').insert({
      agent_name: 'outlook_sync',
      status: result.errors.length > 0 ? 'partial_error' : 'success',
      total_tickets_attempted: result.emails_synced + result.emails_skipped + result.calendar_synced,
      total_tickets_synced: result.emails_synced + result.emails_skipped + result.calendar_synced,
      total_failures: result.errors.length,
      sync_timestamp: new Date().toISOString()
    });
    if (result.errors.length > 0 && slackUrl) {
      await sendSlackAlert(slackUrl, "outlook-sync", result.errors);
    }
    await supabase.from("automation_audit_log").insert({
      mailbox: "outlook",
      actor: "outlook-sync",
      scenario_name: "outlook-sync",
      actions_taken: {
        emails_synced: result.emails_synced,
        emails_skipped: result.emails_skipped,
        calendar_synced: result.calendar_synced,
        calendar_skipped: result.calendar_skipped,
        clients_matched: result.clients_matched,
        classifier_triggered: result.classifier_triggered
      },
      outcome: result.errors.length > 0 ? "partial_error" : "success",
      error_message: result.errors.length > 0 ? result.errors.join("; ") : null
    });
    return jsonResponse({
      message: "Outlook sync complete",
      ...result
    });
  } catch (err) {
    const errorMsg = String(err);
    if (slackUrl) await sendSlackAlert(slackUrl, "outlook-sync", [
      errorMsg
    ]);
    await supabase.from("automation_audit_log").insert({
      mailbox: "outlook",
      actor: "outlook-sync",
      scenario_name: "outlook-sync",
      outcome: "error",
      error_message: errorMsg
    }).catch(()=>{});
    return jsonResponse({
      error: errorMsg,
      details: result
    }, 500);
  }
});
