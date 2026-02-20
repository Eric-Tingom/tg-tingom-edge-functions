import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
Deno.serve(async (req)=>{
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    const payload = await req.json();
    // Only send if escalation_path is "slack"
    if (payload.escalation_path !== "slack") {
      return jsonResponse({
        skipped: true,
        reason: "escalation_path is not slack"
      });
    }
    // Get webhook URL from vault
    const { data: secrets } = await supabase.rpc("get_processor_secrets");
    const webhookUrl = secrets?.slack_webhook_url;
    if (!webhookUrl) {
      return jsonResponse({
        error: "No Slack webhook URL configured"
      }, 500);
    }
    // Build the Slack message
    const message = buildSlackMessage(payload);
    // Send to Slack
    const slackRes = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(message)
    });
    if (!slackRes.ok) {
      const errText = await slackRes.text();
      return jsonResponse({
        error: `Slack send failed: ${slackRes.status} - ${errText}`
      }, 500);
    }
    // Log the notification
    await supabase.from("automation_audit_log").insert({
      mailbox: "outlook",
      actor: "slack-notify",
      scenario_name: "slack-notify",
      actions_taken: {
        email_id: payload.email_id,
        email_type: payload.email_type,
        priority: payload.priority,
        channel: "slack"
      },
      outcome: "success"
    });
    return jsonResponse({
      sent: true,
      email_id: payload.email_id
    });
  } catch (err) {
    await supabase.from("automation_audit_log").insert({
      mailbox: "outlook",
      actor: "slack-notify",
      scenario_name: "slack-notify",
      outcome: "error",
      error_message: String(err)
    }).catch(()=>{});
    return jsonResponse({
      error: String(err)
    }, 500);
  }
});
function buildSlackMessage(payload) {
  const emoji = getEmoji(payload.email_type, payload.priority);
  const priorityBadge = payload.priority === "urgent" ? " 🔴 URGENT" : payload.priority === "high" ? " 🟠 HIGH" : "";
  // Header line
  const headerText = `${emoji} *${getTypeLabel(payload.email_type)}*${priorityBadge}`;
  // Build context fields
  const fields = [];
  if (payload.client_name) {
    fields.push(`*Client:* ${payload.client_name}`);
  } else {
    fields.push(`*From:* ${payload.sender_email}`);
  }
  fields.push(`*Subject:* ${payload.subject}`);
  if (payload.hubspot_ticket_ids && payload.hubspot_ticket_ids.length > 0) {
    const ticketLinks = payload.hubspot_ticket_ids.map((id)=>`<https://app.hubspot.com/contacts/4736045/ticket/${id}|#${id}>`).join(", ");
    fields.push(`*Open Tickets:* ${ticketLinks}`);
  }
  if (payload.lead_qualified === true) {
    fields.push("*Lead:* ✅ US-qualified");
  } else if (payload.lead_qualified === false) {
    fields.push("*Lead:* ❌ Non-US");
  }
  if (payload.suggested_actions) {
    fields.push(`*Action:* ${payload.suggested_actions}`);
  }
  if (payload.confidence_score) {
    fields.push(`*Confidence:* ${Math.round(payload.confidence_score * 100)}%`);
  }
  // Build blocks
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: headerText
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: fields.join("\n")
      }
    }
  ];
  // Add body preview if available
  if (payload.body_preview) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `> ${payload.body_preview.substring(0, 200)}${payload.body_preview.length > 200 ? "..." : ""}`
        }
      ]
    });
  }
  // Add HubSpot company link if available
  if (payload.hubspot_company_id) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "View in HubSpot"
          },
          url: `https://app.hubspot.com/contacts/4736045/company/${payload.hubspot_company_id}`
        }
      ]
    });
  }
  return {
    text: `${emoji} ${getTypeLabel(payload.email_type)}: ${payload.subject}`,
    blocks
  };
}
function getEmoji(emailType, priority) {
  if (priority === "urgent") return "🚨";
  switch(emailType){
    case "client_work_request":
      return "📋";
    case "client_status_update":
      return "💬";
    case "client_billing":
      return "💰";
    case "lead_inbound":
      return "🎯";
    case "lead_linkedin":
      return "🔗";
    case "lead_platform_notification":
      return "📣";
    case "vendor_billing":
      return "🧾";
    case "partner_communication":
      return "🤝";
    default:
      return "📧";
  }
}
function getTypeLabel(emailType) {
  switch(emailType){
    case "client_work_request":
      return "Client Work Request";
    case "client_status_update":
      return "Client Update";
    case "client_billing":
      return "Client Billing";
    case "lead_inbound":
      return "New Inbound Lead";
    case "lead_linkedin":
      return "LinkedIn Lead";
    case "lead_platform_notification":
      return "Platform Lead";
    case "vendor_billing":
      return "Vendor Bill";
    case "partner_communication":
      return "Partner Message";
    case "event_invitation":
      return "Event Invitation";
    default:
      return emailType.replace(/_/g, " ").replace(/\b\w/g, (c)=>c.toUpperCase());
  }
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
