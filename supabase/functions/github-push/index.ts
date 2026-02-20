import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Phase 1 guardrails: kill switch, path allowlist, repo allowlist
// Actions: push, push_file, whoami, check_ascii, read_files,
//          push_from_db, push_from_design_documents, drain_design_documents_queue,
//          drain_dashboard_files_queue

const ALLOWED_OWNER  = "Eric-Tingom";
const ALLOWED_REPO   = "tg-tingom-edge-functions";
const ALLOWED_BRANCH = "main";
const PUBLISHING_ACTIONS = new Set(["push", "push_file", "push_from_db", "drain_dashboard_files_queue", "push_from_design_documents", "drain_design_documents_queue"]);

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

function validatePath(p: string): { ok: boolean; reason?: string } {
  if (p.startsWith("/")) return { ok: false, reason: `no leading slash: ${p}` };
  if (p.includes("..")) return { ok: false, reason: `no ..: ${p}` };
  if (p.includes("\\\\")) return { ok: false, reason: `no backslash: ${p}` };
  if (!p.startsWith("supabase/functions/")) return { ok: false, reason: `must start with supabase/functions/: ${p}` };
  return { ok: true };
}

// [See Supabase Edge Function github-push v14 for full pushFilesAtomic,
//  drain_dashboard_files_queue, drain_design_documents_queue, and all other actions]

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();
    const { action } = body;
    if (PUBLISHING_ACTIONS.has(action) && Deno.env.get("GITHUB_PUSH_DISABLED") === "true") {
      return new Response(JSON.stringify({ error: "GitHub publishing disabled" }), { status: 403, headers: corsHeaders });
    }
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // Full implementation in live Edge Function v14
    return new Response(JSON.stringify({ error: "See live Edge Function for full implementation" }), { status: 501, headers: corsHeaders });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});