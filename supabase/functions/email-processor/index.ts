import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const HUBSPOT_PIPELINES = [
  "9196710",
  "0"
];
const HUBSPOT_API_BASE = "https://api.hubapi.com";
Deno.serve(async (_req)=>{
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const result = {
    processed: 0,
    skipped: 0,
    errors: [],
    details: []
  };
  try {
    const { data: secrets, error: secretsErr } = await supabase.rpc("get_processor_secrets");
    if (secretsErr) return jr({
      error: `Failed to get secrets: ${secretsErr.message}`
    }, 500);
    const hubspotApiKey = secrets?.hubspot_api_key;
    const anthropicApiKey = secrets?.anthropic_api_key;
    const slackWebhookUrl = secrets?.slack_webhook_url;
    const { data: folderMap } = await supabase.from("email_folder_map").select("email_type, folder_name, outlook_folder_id, requires_action, default_priority, default_action_bucket, auto_associate_hubspot, default_bms_area").eq("is_active", true);
    const fl = {};
    for (const row of folderMap || [])fl[row.email_type] = row;
    const { data: rules } = await supabase.from("email_classification_rules").select("id, rule_name, match_field, match_value, match_operator, resulting_email_type, resulting_priority, resulting_action_bucket, source").eq("is_active", true).order("priority", {
      ascending: true
    });
    const { data: clients } = await supabase.from("client_registry").select("hubspot_id, client_name, domain, billing_model, is_internal").not("domain", "is", null);
    const d2c = {};
    for (const c of clients || []){
      if (c.domain && !c.is_internal) d2c[c.domain.toLowerCase()] = c;
    }
    const graphToken = await getValidGraphToken(supabase);
    const { data: newEmails, error: fetchErr } = await supabase.from("email_monitoring_queue").select("*").eq("status", "new").order("received_at", {
      ascending: true
    }).limit(25);
    if (fetchErr) return jr({
      error: `Failed to fetch: ${fetchErr.message}`
    }, 500);
    if (!newEmails || newEmails.length === 0) return jr({
      message: "No new emails",
      ...result
    });
    for (const email of newEmails){
      try {
        const u = {
          updated_at: new Date().toISOString()
        };
        let eType = null, cSrc = null, cRuleId = null;
        let pri = null, aBucket = null, bms = null;
        let ePath = null, conf = null, lq = null;
        let sActions = null, tIds = [];
        // S1: THREAD
        if (email.thread_id) {
          const { data: tm } = await supabase.from("email_monitoring_queue").select("id, email_type, status, outlook_folder_id, outlook_folder_name, hubspot_ticket_ids").eq("thread_id", email.thread_id).neq("id", email.id).neq("status", "new").order("received_at", {
            ascending: false
          }).limit(1).maybeSingle();
          if (tm) {
            if (tm.status === "waiting_response") {
              eType = tm.email_type || "unknown";
              const af = fl["client_work_request"] || fl[eType];
              u.outlook_folder_id = af?.outlook_folder_id || tm.outlook_folder_id;
              u.outlook_folder_name = "Processed/Action Required";
              u.status = "action_required";
              u.email_type = eType;
              u.classification_source = "thread_match";
              u.requires_action = true;
              u.priority = tm.email_type === "client_work_request" ? "high" : "normal";
              u.escalation_path = "standup";
              u.hubspot_ticket_ids = tm.hubspot_ticket_ids;
              await supabase.from("email_monitoring_queue").update({
                status: "resolved",
                updated_at: new Date().toISOString()
              }).eq("id", tm.id);
              await doUpdate(supabase, graphToken, email, u, result);
              continue;
            }
            if (tm.status === "filed" || tm.status === "classified") {
              u.email_type = tm.email_type;
              u.classification_source = "thread_match";
              u.status = "thread_existing";
              u.outlook_folder_id = tm.outlook_folder_id;
              u.outlook_folder_name = tm.outlook_folder_name;
              u.requires_action = false;
              u.hubspot_ticket_ids = tm.hubspot_ticket_ids;
              u.escalation_path = "none";
              await doUpdate(supabase, graphToken, email, u, result);
              continue;
            }
            if (tm.status === "action_required") {
              u.email_type = tm.email_type;
              u.classification_source = "thread_match";
              u.status = "action_required";
              u.outlook_folder_id = tm.outlook_folder_id;
              u.outlook_folder_name = tm.outlook_folder_name || "Processed/Action Required";
              u.requires_action = true;
              u.priority = tm.email_type === "client_work_request" ? "high" : "normal";
              u.hubspot_ticket_ids = tm.hubspot_ticket_ids;
              u.escalation_path = "standup";
              await doUpdate(supabase, graphToken, email, u, result);
              continue;
            }
          }
        }
        // S2: RULES
        let rm = false;
        for (const rule of rules || []){
          if (matchRule(rule, email)) {
            eType = rule.resulting_email_type;
            cSrc = "rule";
            cRuleId = rule.id;
            pri = rule.resulting_priority || null;
            aBucket = rule.resulting_action_bucket || null;
            rm = true;
            try {
              await supabase.rpc("increment_rule_match", {
                rule_id: rule.id
              });
            } catch (_e) {}
            break;
          }
        }
        // S3: IDENTITY
        let cType = email.hubspot_company_type || null, coId = email.hubspot_company_id || null;
        let ctId = email.hubspot_contact_id || null, cName = null, isClient = false;
        const cm = d2c[email.sender_domain?.toLowerCase()];
        if (cm) {
          cName = cm.client_name;
          if (!coId) coId = cm.hubspot_id;
          isClient = true;
        }
        if (hubspotApiKey && !cType) {
          try {
            if (!ctId) {
              const cr = await hsSearchContact(hubspotApiKey, email.sender_email);
              if (cr) {
                ctId = cr.id;
                if (!coId) {
                  const ac = await hsContactCo(hubspotApiKey, cr.id);
                  if (ac) {
                    coId = ac.id;
                    cType = ac.type;
                    if (!cName) cName = ac.name;
                    if (ac.type === "Customer" || ac.type === "CUSTOMER") isClient = true;
                  }
                }
              }
            }
            if (coId && !cType) {
              const co = await hsCo(hubspotApiKey, coId);
              if (co) {
                cType = co.type;
                if (!cName) cName = co.name;
                if (co.type === "Customer" || co.type === "CUSTOMER") isClient = true;
              }
            }
            if (!coId && email.sender_domain) {
              const dc = await hsCoDomain(hubspotApiKey, email.sender_domain);
              if (dc) {
                coId = dc.id;
                cType = dc.type;
                if (!cName) cName = dc.name;
                if (dc.type === "Customer" || dc.type === "CUSTOMER") isClient = true;
              }
            }
          } catch (e) {
            result.errors.push(`HS enrich fail ${email.sender_email}: ${String(e)}`);
          }
        }
        u.hubspot_contact_id = ctId;
        u.hubspot_company_id = coId;
        u.hubspot_company_type = cType;
        u.client_identified = isClient;
        // S3b: TICKETS
        if (hubspotApiKey && coId && isClient) {
          try {
            const ot = await hsTickets(hubspotApiKey, coId);
            if (ot.length > 0) {
              tIds = ot.map((t)=>t.id);
              u.hubspot_ticket_ids = tIds;
            }
          } catch (e) {
            result.errors.push(`Ticket fail ${coId}: ${String(e)}`);
          }
        }
        // S4: AI
        if (!rm && anthropicApiKey) {
          try {
            const ai = await classifyAI(anthropicApiKey, {
              subject: email.subject,
              sender_email: email.sender_email,
              sender_domain: email.sender_domain,
              body_preview: email.body_preview || "",
              company_type: cType,
              company_name: cName,
              client_identified: isClient,
              billing_model: cm?.billing_model,
              open_ticket_count: tIds.length
            });
            if (ai) {
              eType = ai.email_type;
              cSrc = "ai";
              pri = ai.priority;
              aBucket = ai.action_bucket;
              bms = ai.bms_area;
              ePath = ai.escalation_path;
              conf = ai.confidence_score;
              lq = ai.lead_qualified;
              sActions = ai.suggested_actions;
              u.ai_raw_output = ai;
            } else {
              eType = "unknown";
              cSrc = "ai";
            }
          } catch (e) {
            result.errors.push(`AI fail ${email.id}: ${String(e)}`);
            eType = "unknown";
            cSrc = "ai";
          }
        } else if (!rm && !anthropicApiKey) {
          eType = "unknown";
          cSrc = "rule";
          result.errors.push(`No API key - ${email.id} unknown`);
        }
        // S5: RESOLVE
        eType = eType || "unknown";
        const fi = fl[eType] || fl["unknown"];
        pri = pri || fi?.default_priority || "normal";
        aBucket = aBucket || fi?.default_action_bucket || "review";
        bms = bms || fi?.default_bms_area || null;
        if (!ePath) ePath = detEsc(eType, pri);
        const ra = fi?.requires_action ?? true;
        const st = eType === "unknown" ? "unknown" : ra ? "action_required" : "filed";
        u.email_type = eType;
        u.classification_source = cSrc;
        u.classification_rule_id = cRuleId;
        u.priority = pri;
        u.action_bucket = aBucket;
        u.bms_area = bms;
        u.escalation_path = ePath;
        u.confidence_score = conf;
        u.lead_qualified = lq;
        u.suggested_actions = sActions;
        u.requires_action = ra;
        u.status = st;
        u.outlook_folder_id = fi?.outlook_folder_id || null;
        u.outlook_folder_name = fi?.folder_name || null;
        // S6: AUTO-LEARN
        if (cSrc === "ai" && conf !== null && conf >= 0.90 && eType !== "unknown" && !isClient) {
          try {
            const { data: er } = await supabase.from("email_classification_rules").select("id").eq("match_field", "sender_email").eq("match_value", email.sender_email.toLowerCase()).eq("is_active", true).maybeSingle();
            if (!er) {
              await supabase.from("email_classification_rules").insert({
                rule_name: `Auto: ${email.sender_email} -> ${eType}`,
                match_field: "sender_email",
                match_value: email.sender_email.toLowerCase(),
                match_operator: "equals",
                resulting_email_type: eType,
                source: "auto_learned",
                source_email_id: email.id,
                confidence_score: conf,
                priority: 50
              });
            }
          } catch (e) {
            result.errors.push(`Auto-learn fail ${email.sender_email}: ${String(e)}`);
          }
        }
        await doUpdate(supabase, graphToken, email, u, result);
        const ld = result.details[result.details.length - 1];
        if (ld && tIds.length > 0) ld.ticket_ids = tIds;
        // S7: SLACK - fires for escalation=slack OR action_bucket=create_ticket
        if ((u.escalation_path === "slack" || u.action_bucket === "create_ticket") && slackWebhookUrl) {
          try {
            await slackNotify(slackWebhookUrl, {
              email_id: email.id,
              sender_email: email.sender_email,
              subject: email.subject,
              email_type: u.email_type,
              priority: u.priority,
              suggested_actions: u.suggested_actions || sActions,
              hubspot_company_id: u.hubspot_company_id || coId,
              hubspot_ticket_ids: u.hubspot_ticket_ids || tIds,
              lead_qualified: u.lead_qualified ?? lq,
              confidence_score: u.confidence_score ?? conf,
              client_name: cName,
              body_preview: email.body_preview,
              action_bucket: u.action_bucket
            });
          } catch (e) {
            result.errors.push(`Slack fail ${email.id}: ${String(e)}`);
          }
        }
      } catch (e) {
        result.errors.push(`Failed ${email.id}: ${String(e)}`);
      }
    }
    await supabase.from("automation_audit_log").insert({
      mailbox: "outlook",
      actor: "email-processor",
      scenario_name: "email-processor",
      actions_taken: {
        processed: result.processed,
        skipped: result.skipped,
        details: result.details
      },
      outcome: result.errors.length > 0 ? "partial" : "success",
      error_message: result.errors.length > 0 ? result.errors.join("; ") : null
    });
    return jr({
      message: `Processed ${result.processed} emails`,
      ...result
    });
  } catch (err) {
    try {
      await supabase.from("automation_audit_log").insert({
        mailbox: "outlook",
        actor: "email-processor",
        scenario_name: "email-processor",
        outcome: "error",
        error_message: String(err)
      });
    } catch (_e) {}
    return jr({
      error: String(err),
      details: result
    }, 500);
  }
});
function matchRule(r, e) {
  const f = r.match_field, v = r.match_value.toLowerCase(), o = r.match_operator;
  let t;
  switch(f){
    case "sender_email":
      t = (e.sender_email || "").toLowerCase();
      break;
    case "sender_domain":
      t = (e.sender_domain || "").toLowerCase();
      break;
    case "subject_contains":
    case "subject_prefix":
      t = (e.subject || "").toLowerCase();
      break;
    case "sender_domain_pattern":
      t = (e.sender_domain || "").toLowerCase();
      break;
    default:
      return false;
  }
  switch(o){
    case "equals":
      return t === v;
    case "contains":
      return t.includes(v);
    case "starts_with":
      return t.startsWith(v);
    case "ends_with":
      return t.endsWith(v);
    case "regex":
      try {
        return new RegExp(v, "i").test(t);
      } catch  {
        return false;
      }
    default:
      return false;
  }
}
function detEsc(et, p) {
  if (p === "urgent") return "slack";
  if (et === "lead_inbound" || et === "client_work_request") return "slack";
  if ([
    "client_status_update",
    "client_billing",
    "vendor_invoice",
    "partner_communication",
    "event_invitation",
    "unknown"
  ].includes(et)) return "standup";
  return "none";
}
async function doUpdate(sb, gt, e, u, r) {
  const { error } = await sb.from("email_monitoring_queue").update(u).eq("id", e.id);
  if (error) {
    r.errors.push(`Update fail ${e.id}: ${error.message}`);
    return;
  }
  if (u.outlook_folder_id && gt && e.message_id) {
    try {
      const mr = await fetch(`${GRAPH_BASE}/me/messages/${e.message_id}/move`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gt}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          destinationId: u.outlook_folder_id
        })
      });
      if (!mr.ok) {
        const et2 = await mr.text();
        r.errors.push(mr.status === 404 ? `Move skip ${e.id}: not found` : `Move fail ${e.id}: ${mr.status} - ${et2}`);
      }
    } catch (me) {
      r.errors.push(`Move exc ${e.id}: ${String(me)}`);
    }
  }
  r.processed++;
  r.details.push({
    email_id: e.id,
    sender: e.sender_email,
    subject: e.subject,
    email_type: u.email_type || "unknown",
    folder: u.outlook_folder_name || "unknown",
    source: u.classification_source || "unknown"
  });
}
async function classifyAI(key, ctx) {
  const sys = `You are an email classifier for Eric Tingom, COO of Tingom Group (a B2B automation consultancy).\nReturn ONLY valid JSON, no markdown.\n\nCONTEXT: Eric manages clients (Heritage, Harness, Hance, Maridea, others) on retainer/work-order billing. Tools: HubSpot, Supabase, Make.com, Trello, Outlook, Zoom, GitHub, Sembly. LinkedIn Sales Navigator generates lead notifications.\n\nEMAIL TYPES (pick one):\n- client_work_request: Client asking for something done\n- client_status_update: Client providing info or updating on work\n- client_billing: Invoice/payment from/about client\n- lead_linkedin: LinkedIn lead notification\n- lead_platform_notification: Lead from another platform\n- lead_inbound: Direct email from someone interested in services\n- vendor_invoice: Unpaid bill/invoice FROM a vendor that needs payment or review\n- vendor_billing: Payment confirmation, receipt, or subscription renewal notice from a vendor (already paid)\n- vendor_operational: Vendor support/status update\n- partner_communication: Business partner email\n- newsletter: Newsletter, marketing, promotional\n- learning_content: Course, webinar, educational\n- event_invitation: Calendar invite, event registration\n- tool_admin: Password reset, system alert, admin notification, usage report\n- personal: Personal email, banking alerts, subscriptions\n- unknown: ONLY if truly cannot classify\n\nGUIDANCE:\n- Banking alerts (BofA, Chase) = personal\n- SaaS marketing = newsletter\n- Tool notifications (Harvest, Trello, GitHub, Notion, Sembly, Zoom) = tool_admin\n- Microsoft invoices with "is ready" = vendor_invoice (needs review)\n- Microsoft/Intuit/vendor "payment received" or "subscription payment" = vendor_billing (already paid, just a receipt)\n- Microsoft security/PIM = tool_admin\n- Key distinction: vendor_invoice = you owe money or need to review charges. vendor_billing = money already paid, just a confirmation/receipt.\n- Do NOT default to unknown because body_preview is empty\n- Use subject + sender to classify with at least 0.7 confidence\n\nJSON STRUCTURE:\n{"email_type": "...", "actionable": bool, "priority": "urgent|high|normal|low", "action_bucket": "respond|review|create_ticket|file|ignore", "due_hint": "today|this_week|next_week|no_deadline", "suggested_actions": "...", "bms_area": "operations|sales|marketing|finance|legal|leadership_admin", "lead_qualified": true/false/null, "confidence_score": 0.0-1.0, "escalation_path": "slack|standup|none", "reasoning": "..."}\n\nRULES: lead_qualified only for lead types (true=US, false=non-US, null=not lead). Newsletters/tool_admin NEVER actionable. If client_identified=true lean client_*. escalation: slack for urgent/leads/client_work_request, standup for other actionable, none for noise.`;
  const msg = `Classify:\nSENDER: ${ctx.sender_email}\nDOMAIN: ${ctx.sender_domain}\nSUBJECT: ${ctx.subject}\nPREVIEW: ${ctx.body_preview || "(none)"}\nCOMPANY TYPE: ${ctx.company_type || "unknown"}\nCOMPANY NAME: ${ctx.company_name || "unknown"}\nCLIENT: ${ctx.client_identified}\nBILLING: ${ctx.billing_model || "none"}\nTICKETS: ${ctx.open_ticket_count}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: msg
        }
      ],
      system: sys
    })
  });
  if (!res.ok) {
    const et = await res.text();
    throw new Error(`Anthropic ${res.status}: ${et}`);
  }
  const d = await res.json();
  const txt = d.content?.[0]?.text || "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`Non-JSON: ${txt.substring(0, 200)}`);
  return JSON.parse(m[0]);
}
async function hsSearchContact(k, email) {
  const r = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${k}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [
            {
              propertyName: "email",
              operator: "EQ",
              value: email
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
  if (!r.ok) return null;
  const d = await r.json();
  return d.results?.[0] || null;
}
async function hsContactCo(k, cid) {
  const r = await fetch(`${HUBSPOT_API_BASE}/crm/v4/objects/contacts/${cid}/associations/companies`, {
    headers: {
      Authorization: `Bearer ${k}`
    }
  });
  if (!r.ok) return null;
  const d = await r.json();
  const a = d.results?.[0];
  if (!a?.toObjectId) return null;
  return await hsCo(k, String(a.toObjectId));
}
async function hsCo(k, id) {
  const r = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/companies/${id}?properties=name,type,domain`, {
    headers: {
      Authorization: `Bearer ${k}`
    }
  });
  if (!r.ok) return null;
  const d = await r.json();
  return {
    id: d.id,
    name: d.properties?.name,
    type: d.properties?.type,
    domain: d.properties?.domain
  };
}
async function hsCoDomain(k, domain) {
  const r = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/companies/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${k}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [
            {
              propertyName: "domain",
              operator: "EQ",
              value: domain
            }
          ]
        }
      ],
      properties: [
        "name",
        "type",
        "domain"
      ],
      limit: 1
    })
  });
  if (!r.ok) return null;
  const d = await r.json();
  const c = d.results?.[0];
  if (!c) return null;
  return {
    id: c.id,
    name: c.properties?.name,
    type: c.properties?.type,
    domain: c.properties?.domain
  };
}
async function hsTickets(k, coId) {
  const all = [];
  for (const p of HUBSPOT_PIPELINES){
    try {
      const r = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/tickets/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${k}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "hs_pipeline",
                  operator: "EQ",
                  value: p
                },
                {
                  propertyName: "hs_pipeline_stage",
                  operator: "NOT_IN",
                  values: [
                    "4",
                    "3722908"
                  ]
                }
              ]
            }
          ],
          properties: [
            "subject",
            "hs_pipeline",
            "hs_pipeline_stage",
            "hs_ticket_priority"
          ],
          limit: 10
        })
      });
      if (!r.ok) continue;
      const d = await r.json();
      for (const t of d.results || []){
        try {
          const ar = await fetch(`${HUBSPOT_API_BASE}/crm/v4/objects/tickets/${t.id}/associations/companies`, {
            headers: {
              Authorization: `Bearer ${k}`
            }
          });
          if (!ar.ok) continue;
          const ad = await ar.json();
          if ((ad.results || []).some((a)=>String(a.toObjectId) === String(coId))) all.push({
            id: t.id,
            subject: t.properties?.subject,
            pipeline: t.properties?.hs_pipeline,
            stage: t.properties?.hs_pipeline_stage,
            priority: t.properties?.hs_ticket_priority
          });
        } catch  {}
      }
    } catch  {}
  }
  return all;
}
async function getValidGraphToken(sb) {
  try {
    const { data: t } = await sb.from("msgraph_tokens").select("access_token, expires_at").eq("id", 1).single();
    if (!t) return null;
    if (new Date(t.expires_at).getTime() - Date.now() > 5 * 60 * 1000) return t.access_token;
    const { data: c } = await sb.rpc("get_msgraph_credentials");
    if (!c) return null;
    const b = new URLSearchParams({
      client_id: c.client_id,
      client_secret: c.client_secret,
      refresh_token: c.refresh_token,
      grant_type: "refresh_token",
      scope: "https://graph.microsoft.com/.default offline_access"
    });
    const tr = await fetch(`https://login.microsoftonline.com/${c.tenant_id}/oauth2/v2.0/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: b.toString()
    });
    if (!tr.ok) return null;
    const td = await tr.json();
    await sb.from("msgraph_tokens").update({
      access_token: td.access_token,
      refresh_token: td.refresh_token || c.refresh_token,
      expires_at: new Date(Date.now() + (td.expires_in || 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", 1);
    return td.access_token;
  } catch  {
    return null;
  }
}
async function slackNotify(url, p) {
  const em = p.action_bucket === "create_ticket" ? "\u{1F3AB}" : p.priority === "urgent" ? "\u{1F6A8}" : p.email_type === "client_work_request" ? "\u{1F4CB}" : p.email_type === "lead_inbound" ? "\u{1F3AF}" : p.email_type === "lead_linkedin" ? "\u{1F517}" : "\u{1F4E7}";
  const pb = p.priority === "urgent" ? " \u{1F534} URGENT" : p.priority === "high" ? " \u{1F7E0} HIGH" : "";
  const tb = p.action_bucket === "create_ticket" ? " \u{1F3AB} NEEDS TICKET" : "";
  const tl = p.email_type?.replace(/_/g, " ").replace(/\b\w/g, (c)=>c.toUpperCase()) || "Email";
  const f = [];
  if (p.client_name) f.push(`*Client:* ${p.client_name}`);
  else f.push(`*From:* ${p.sender_email}`);
  f.push(`*Subject:* ${p.subject}`);
  if (p.hubspot_ticket_ids?.length > 0) f.push(`*Tickets:* ${p.hubspot_ticket_ids.map((i)=>`<https://app.hubspot.com/contacts/4736045/ticket/${i}|#${i}>`).join(", ")}`);
  if (p.lead_qualified === true) f.push("*Lead:* \u2705 US");
  else if (p.lead_qualified === false) f.push("*Lead:* \u274C Non-US");
  if (p.suggested_actions) f.push(`*Action:* ${p.suggested_actions}`);
  if (p.confidence_score) f.push(`*Conf:* ${Math.round(p.confidence_score * 100)}%`);
  const bl = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${em} *${tl}*${pb}${tb}`
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: f.join("\n")
      }
    }
  ];
  if (p.body_preview) bl.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `> ${p.body_preview.substring(0, 200)}${p.body_preview.length > 200 ? "..." : ""}`
      }
    ]
  });
  if (p.hubspot_company_id) bl.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "View in HubSpot"
        },
        url: `https://app.hubspot.com/contacts/4736045/company/${p.hubspot_company_id}`
      }
    ]
  });
  const sr = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text: `${em} ${tl}: ${p.subject}`,
      blocks: bl
    })
  });
  if (!sr.ok) throw new Error(`Slack fail: ${sr.status}`);
}
function jr(d, s = 200) {
  return new Response(JSON.stringify(d, null, 2), {
    status: s,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
