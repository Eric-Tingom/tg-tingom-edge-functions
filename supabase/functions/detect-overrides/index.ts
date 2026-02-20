// detect-overrides v2 - Detects when Eric manually moves emails in Outlook
// Checks recently processed emails and compares current Outlook folder to expected
// Creates/updates classification rules based on human feedback (override learning)
// Tables: email_monitoring_queue, email_classification_rules, email_folder_map, automation_audit_log
// External: MS Graph API

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Full implementation in live Supabase Edge Function detect-overrides v2

Deno.serve(async (_req: Request) => {
  return new Response(JSON.stringify({ error: "See live Edge Function for full implementation" }), {
    status: 501, headers: { "Content-Type": "application/json" }
  });
});