// email-classifier v6 - AI-powered email classification engine
// Classifies emails from email_monitoring_queue using rule-based + Claude AI hybrid
// Stages: rule match -> thread context -> HubSpot enrichment -> Claude classification -> routing
// Actions: classify_email, classify_batch, get_classification_rules
// Tables: email_monitoring_queue, email_classification_rules, client_registry,
//         email_folder_map, automation_audit_log
// RPCs: get_processor_secrets, get_classifier_context
// External: Anthropic API (claude-sonnet), HubSpot CRM API

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Full implementation in live Supabase Edge Function email-classifier v6

Deno.serve(async (_req: Request) => {
  return new Response(JSON.stringify({ error: "See live Edge Function for full implementation" }), {
    status: 501, headers: { "Content-Type": "application/json" }
  });
});