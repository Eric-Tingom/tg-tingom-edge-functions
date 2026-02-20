import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface SlackPayload {
  email_id: number; sender_email: string; subject: string; email_type: string;
  priority: string; escalation_path: string; suggested_actions?: string;
  hubspot_company_id?: string; hubspot_ticket_ids?: string[];
  lead_qualified?: boolean | null; confidence_score?: number;
  client_name?: string; body_preview?: string;
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    const payload: SlackPayload = await req.json();
    if (payload.escalation_path !== "slack") {
      return jsonResponse({ skipped: true, reason: "escalation_path is not slack" });
    }
    const { data: secrets } = await supabase.rpc("get_processor_secrets");
    const webhookUrl = secrets?.slack_webhook_url;
    if (!webhookUrl) return jsonResponse({ error: "No Slack webhook URL configured" }, 500);
    const emoji = payload.priority === "urgent" ? "🚨" : payload.email_type === "client_work_request" ? "📋" : "📧";
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `${emoji} *${payload.email_type}* ${payload.priority === "urgent" ? "🔴 URGENT" : ""}` } },
      { type: "section", text: { type: "mrkdwn", text: `*From:* ${payload.sender_email}\n*Subject:* ${payload.subject}` } },
    ];
    const slackRes = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `${emoji} ${payload.subject}`, blocks }) });
    if (!slackRes.ok) return jsonResponse({ error: `Slack send failed: ${slackRes.status}` }, 500);
    await supabase.from("automation_audit_log").insert({ mailbox: "outlook", actor: "slack-notify", scenario_name: "slack-notify", actions_taken: { email_id: payload.email_id, email_type: payload.email_type }, outcome: "success" });
    return jsonResponse({ sent: true, email_id: payload.email_id });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } });
}