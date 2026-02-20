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
Deno.serve(async (req)=>{
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const result = {
    total_processed: 0,
    rule_matched: 0,
    ai_classified: 0,
    thread_matched: 0,
    moved_to_folder: 0,
    rules_learned: 0,
    hubspot_lookups: 0,
    errors: [],
    token_refreshed: false
  };
  let slackUrl = null;
  let aiApiKey = null;
  let hubspotKey = null;
  try {
    // Get secrets early (Slack + AI + HubSpot)
    try {
      const { data: procSecrets } = await supabase.rpc("get_processor_secrets");
      if (procSecrets) {
        slackUrl = procSecrets.slack_webhook_url || null;
        aiApiKey = procSecrets.anthropic_api_key || null;
        hubspotKey = procSecrets.hubspot_api_key || null;
      }
    } catch (_) {}
    // 1. Get unclassified emails
    const { data: newEmails, error: fetchErr } = await supabase.from("email_monitoring_queue").select("*").eq("status", "new").is("classification_source", null).order("received_at", {
      ascending: true
    }).limit(20);
    if (fetchErr) throw new Error(`Fetch error: ${fetchErr.message}`);
    if (!newEmails || newEmails.length === 0) {
      return jsonResponse({
        message: "No new emails to classify",
        ...result
      });
    }
    // 2. Load classification rules
    const { data: rules } = await supabase.from("email_classification_rules").select("*").eq("is_active", true).order("priority", {
      ascending: true
    });
    // 3. Load folder mappings
    const { data: folderMaps } = await supabase.from("email_folder_map").select("*").eq("is_active", true);
    const folderByType = {};
    for (const fm of folderMaps || [])folderByType[fm.email_type] = fm;
    // 4. Load client domains
    const { data: clients } = await supabase.from("client_registry").select("client_name, hubspot_id, domain, billing_model").not("domain", "is", null);
    const domainToClient = {};
    for (const c of clients || []){
      if (c.domain) domainToClient[c.domain.toLowerCase()] = c;
    }
    // 5. ALWAYS force fresh MS Graph token
    let accessToken = null;
    try {
      accessToken = await refreshToken(supabase, result);
    } catch (e) {
      result.errors.push(`Token error: ${String(e)}`);
    }
    // 6. Process each email
    for (const email of newEmails){
      try {
        result.total_processed++;
        let classification = null;
        // STEP A: Thread matching
        if (email.thread_id) {
          const { data: threadMatch } = await supabase.from("email_monitoring_queue").select("email_type, priority, bms_area, action_bucket, confidence_score").eq("thread_id", email.thread_id).not("classification_source", "is", null).neq("id", email.id).order("received_at", {
            ascending: false
          }).limit(1).maybeSingle();
          if (threadMatch?.email_type) {
            const fm = folderByType[threadMatch.email_type];
            classification = {
              email_type: threadMatch.email_type,
              priority: threadMatch.priority || fm?.default_priority || "normal",
              bms_area: threadMatch.bms_area || fm?.default_bms_area || null,
              action_bucket: threadMatch.action_bucket || fm?.default_action_bucket || "review",
              source: "thread_match",
              confidence_score: threadMatch.confidence_score || 0.9,
              ai_raw_output: null,
              suggested_actions: null,
              lead_qualified: null,
              escalation_path: "standup",
              due_hint: null,
              actionable: fm?.requires_action ?? true,
              rule_id: null
            };
            result.thread_matched++;
          }
        }
        // STEP B: Rule-based
        if (!classification && rules) {
          for (const rule of rules){
            let matched = false;
            const fieldValue = email[rule.match_field]?.toLowerCase() || "";
            const matchVal = rule.match_value.toLowerCase();
            switch(rule.match_operator){
              case "equals":
                matched = fieldValue === matchVal;
                break;
              case "contains":
                matched = fieldValue.includes(matchVal);
                break;
              case "ends_with":
                matched = fieldValue.endsWith(matchVal);
                break;
              case "starts_with":
                matched = fieldValue.startsWith(matchVal);
                break;
            }
            if (matched) {
              const fm = folderByType[rule.resulting_email_type];
              classification = {
                email_type: rule.resulting_email_type,
                priority: rule.resulting_priority || fm?.default_priority || "normal",
                bms_area: fm?.default_bms_area || null,
                action_bucket: rule.resulting_action_bucket || fm?.default_action_bucket || "review",
                source: "rule",
                confidence_score: rule.confidence_score || 0.95,
                ai_raw_output: null,
                suggested_actions: null,
                lead_qualified: null,
                escalation_path: "none",
                due_hint: null,
                actionable: fm?.requires_action ?? true,
                rule_id: rule.id
              };
              result.rule_matched++;
              await supabase.from("email_classification_rules").update({
                times_matched: rule.times_matched + 1,
                last_matched_at: new Date().toISOString()
              }).eq("id", rule.id);
              break;
            }
          }
        }
        // STEP C: AI fallback
        if (!classification && aiApiKey) {
          try {
            const aiResult = await classifyWithAI(aiApiKey, email, domainToClient, folderByType);
            if (aiResult) {
              const fm = folderByType[aiResult.email_type] || folderByType["unknown"];
              classification = {
                email_type: aiResult.email_type,
                priority: aiResult.priority || fm?.default_priority || "normal",
                bms_area: aiResult.bms_area || fm?.default_bms_area || null,
                action_bucket: aiResult.action_bucket || fm?.default_action_bucket || "review",
                source: "ai",
                confidence_score: aiResult.confidence_score || 0.8,
                ai_raw_output: aiResult,
                suggested_actions: aiResult.suggested_actions || null,
                lead_qualified: aiResult.lead_qualified ?? null,
                escalation_path: aiResult.escalation_path || "none",
                due_hint: aiResult.due_hint || null,
                actionable: aiResult.actionable ?? fm?.requires_action ?? true,
                rule_id: null
              };
              result.ai_classified++;
              if (aiResult.confidence_score >= 0.95 && email.sender_email) {
                try {
                  const { data: existingRule } = await supabase.from("email_classification_rules").select("id").eq("match_field", "sender_email").eq("match_value", email.sender_email).maybeSingle();
                  if (!existingRule) {
                    await supabase.from("email_classification_rules").insert({
                      rule_name: `Auto: ${email.sender_email} -> ${aiResult.email_type}`,
                      match_field: "sender_email",
                      match_value: email.sender_email,
                      match_operator: "equals",
                      resulting_email_type: aiResult.email_type,
                      source: "auto_learned",
                      source_email_id: email.id,
                      priority: 50,
                      is_active: true,
                      confidence_score: aiResult.confidence_score
                    });
                    result.rules_learned++;
                  }
                } catch (learnErr) {
                  result.errors.push(`Auto-learn failed: ${String(learnErr)}`);
                }
              }
            }
          } catch (aiErr) {
            result.errors.push(`AI classify failed for ${email.id}: ${String(aiErr)}`);
          }
        }
        // STEP D: Fallback
        if (!classification) {
          classification = {
            email_type: "unknown",
            priority: "normal",
            bms_area: null,
            action_bucket: "review",
            source: "fallback",
            confidence_score: 0,
            ai_raw_output: null,
            suggested_actions: null,
            lead_qualified: null,
            escalation_path: "none",
            due_hint: null,
            actionable: true,
            rule_id: null
          };
        }
        // STEP E: Resolve folder
        const fm = folderByType[classification.email_type] || folderByType["unknown"];
        const targetFolderId = fm?.outlook_folder_id || folderByType["unknown"]?.outlook_folder_id;
        const targetFolderName = fm?.folder_name || "Review";
        // STEP F: HubSpot lookup
        let hubspotContactId = email.hubspot_contact_id;
        if (!hubspotContactId && fm?.auto_associate_hubspot && hubspotKey && email.sender_email) {
          try {
            const hsRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${hubspotKey}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                filterGroups: [
                  {
                    filters: [
                      {
                        propertyName: "email",
                        operator: "EQ",
                        value: email.sender_email
                      }
                    ]
                  }
                ],
                properties: [
                  "email",
                  "firstname",
                  "lastname"
                ],
                limit: 1
              })
            });
            if (hsRes.ok) {
              const hsData = await hsRes.json();
              if (hsData.results?.length > 0) {
                hubspotContactId = hsData.results[0].id;
                result.hubspot_lookups++;
              }
            }
          } catch (hsErr) {
            result.errors.push(`HubSpot lookup failed: ${String(hsErr)}`);
          }
        }
        // STEP G: Move email in Outlook
        let folderMoved = false;
        if (accessToken && targetFolderId && email.message_id) {
          try {
            const moveRes = await fetch(`${GRAPH_BASE}/me/messages/${email.message_id}/move`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                destinationId: targetFolderId
              })
            });
            if (moveRes.ok) {
              folderMoved = true;
              result.moved_to_folder++;
              const moveData = await moveRes.json();
              if (moveData.id && moveData.id !== email.message_id) {
                await supabase.from("email_monitoring_queue").update({
                  message_id: moveData.id
                }).eq("id", email.id);
              }
            } else {
              result.errors.push(`Move failed for ${email.id}: ${moveRes.status}`);
            }
          } catch (moveErr) {
            result.errors.push(`Move exception for ${email.id}: ${String(moveErr)}`);
          }
        }
        // STEP H: Update queue record
        const newStatus = classification.actionable ? "action_required" : "filed";
        const updatePayload = {
          email_type: classification.email_type,
          priority: classification.priority,
          bms_area: classification.bms_area,
          action_bucket: classification.action_bucket,
          classification_source: classification.source,
          classification_rule_id: classification.rule_id,
          confidence_score: classification.confidence_score,
          ai_raw_output: classification.ai_raw_output,
          suggested_actions: classification.suggested_actions,
          lead_qualified: classification.lead_qualified,
          escalation_path: classification.escalation_path,
          due_hint: classification.due_hint,
          requires_action: classification.actionable,
          status: newStatus,
          updated_at: new Date().toISOString()
        };
        if (hubspotContactId && !email.hubspot_contact_id) updatePayload.hubspot_contact_id = hubspotContactId;
        if (folderMoved) {
          updatePayload.outlook_folder_id = targetFolderId;
          updatePayload.outlook_folder_name = targetFolderName;
        }
        const { error: updateErr } = await supabase.from("email_monitoring_queue").update(updatePayload).eq("id", email.id);
        if (updateErr) result.errors.push(`Update failed for ${email.id}: ${updateErr.message}`);
      } catch (emailErr) {
        result.errors.push(`Process failed for email ${email.id}: ${String(emailErr)}`);
      }
    }
    // Alert on errors
    if (result.errors.length > 0 && slackUrl) {
      await sendSlackAlert(slackUrl, "email-classifier", result.errors);
    }
    await supabase.from("automation_audit_log").insert({
      mailbox: "outlook",
      actor: "email-classifier",
      scenario_name: "email-classifier",
      actions_taken: {
        total_processed: result.total_processed,
        rule_matched: result.rule_matched,
        ai_classified: result.ai_classified,
        thread_matched: result.thread_matched,
        moved_to_folder: result.moved_to_folder,
        rules_learned: result.rules_learned,
        hubspot_lookups: result.hubspot_lookups
      },
      outcome: result.errors.length > 0 ? "partial_error" : "success",
      error_message: result.errors.length > 0 ? result.errors.join("; ") : null
    });
    return jsonResponse({
      message: "Classification complete",
      ...result
    });
  } catch (err) {
    const errorMsg = String(err);
    if (slackUrl) await sendSlackAlert(slackUrl, "email-classifier", [
      errorMsg
    ]);
    await supabase.from("automation_audit_log").insert({
      mailbox: "outlook",
      actor: "email-classifier",
      scenario_name: "email-classifier",
      outcome: "error",
      error_message: errorMsg
    }).catch(()=>{});
    return jsonResponse({
      error: errorMsg,
      details: result
    }, 500);
  }
});
async function classifyWithAI(apiKey, email, domainToClient, folderByType) {
  const validTypes = Object.keys(folderByType).filter((t)=>t !== "unknown");
  const clientMatch = domainToClient[email.sender_domain] || null;
  const clientContext = clientMatch ? `KNOWN CLIENT: ${clientMatch.client_name} (billing: ${clientMatch.billing_model}).` : "Sender is NOT a known client.";
  const systemPrompt = `You are an email triage assistant for Eric Tingom, COO of Tingom Group LLC (DBA FlowOps360), a B2B services business focused on business automation and operations management for financial advisors.\n\nClassify the email into exactly ONE of these types: ${validTypes.join(", ")}\n\nType definitions:\n- client_work_request: Client asking for something to be done\n- client_status_update: Client providing info/update on existing work\n- client_billing: Invoice, payment, billing question FROM a client\n- partner_communication: Partner/reseller/referral correspondence\n- lead_inbound: Direct email from potential new business prospect\n- lead_linkedin: LinkedIn notification\n- lead_platform_notification: Other platform lead notifications\n- vendor_billing: Bill/invoice/receipt FROM a vendor or tool\n- vendor_invoice: Invoice requiring payment action from a vendor\n- vendor_operational: Vendor support, status, operational comms\n- tool_admin: Password resets, system alerts, security notifications\n- newsletter: Newsletters, marketing emails, digests. NEVER actionable.\n- learning_content: Courses, webinars, educational content\n- event_invitation: Calendar invites, event registrations\n- personal: Personal/non-business email\n\nRules:\n- Newsletters/marketing = NEVER actionable\n- Client emails = always actionable\n- Vendor billing (receipts) = not actionable, file only\n- Vendor invoices (requiring payment) = actionable\n- Tool admin = not actionable unless security alert\n\n${clientContext}\n\nRespond ONLY with valid JSON, no markdown. Schema:\n{"email_type":"...","priority":"low|normal|high","bms_area":"operations|sales|marketing|finance|leadership_admin|legal","action_bucket":"respond|create_ticket|review|file|ignore","actionable":true/false,"due_hint":"today|this_week|this_month|no_deadline","reasoning":"...","suggested_actions":"...","lead_qualified":null,"escalation_path":"none|slack|standup","confidence_score":0.0-1.0}`;
  const userPrompt = `From: ${email.sender_email}\nDomain: ${email.sender_domain}\nSubject: ${email.subject}\nReceived: ${email.received_at}\nClient identified: ${email.client_identified}\nHubSpot company: ${email.hubspot_company_id || "none"}\n\nBody preview:\n${(email.body_preview || "").substring(0, 1000)}`;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: userPrompt
        }
      ],
      system: systemPrompt
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI API error: ${response.status} - ${errText.substring(0, 300)}`);
  }
  const data = await response.json();
  const textBlock = data.content?.find((b)=>b.type === "text");
  if (!textBlock?.text) throw new Error("No text in AI response");
  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!folderByType[parsed.email_type] && parsed.email_type !== "unknown") parsed.email_type = "unknown";
  return parsed;
}
async function refreshToken(sb, r) {
  try {
    const { data: secrets, error: rpcErr } = await sb.rpc("get_msgraph_secrets");
    if (rpcErr || !secrets) {
      r.errors.push(`get_msgraph_secrets RPC failed: ${rpcErr?.message || 'no data'}`);
      return null;
    }
    const { client_id: clientId, client_secret: clientSecret, tenant_id: tenantId } = secrets;
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
