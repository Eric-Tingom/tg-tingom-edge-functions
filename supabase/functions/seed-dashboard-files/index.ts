import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json"
};
function bad(status, msg) {
  return new Response(JSON.stringify({
    success: false,
    error: msg
  }), {
    status,
    headers: corsHeaders
  });
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response(null, {
    headers: corsHeaders
  });
  // Minimal protection (optional but smart): shared secret
  const secret = Deno.env.get("SEED_SHARED_SECRET");
  if (secret) {
    const got = req.headers.get("x-seed-secret");
    if (got !== secret) return bad(403, "Forbidden");
  }
  const { files } = await req.json().catch(()=>({}));
  if (!Array.isArray(files) || files.length === 0) return bad(400, "Missing files[]");
  // Validate paths (match your github-push allowlist)
  for (const f of files){
    if (!f?.path || !f?.content) return bad(400, "Each file needs path and content");
    const p = String(f.path);
    if (!p.startsWith("supabase/functions/")) return bad(400, `Path not allowed: ${p}`);
    if (p.includes("..") || p.includes("\\") || p.startsWith("/")) return bad(400, `Unsafe path: ${p}`);
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  // Upsert one-by-one to avoid payload issues
  const results = [];
  for (const f of files){
    const { error } = await sb.from("dashboard_files").upsert({
      file_path: f.path,
      file_content: f.content,
      deploy_status: "staged",
      deploy_error: null,
      updated_at: new Date().toISOString()
    }, {
      onConflict: "file_path"
    });
    results.push({
      path: f.path,
      ok: !error,
      error: error?.message ?? null
    });
  }
  return new Response(JSON.stringify({
    success: true,
    count: results.length,
    results
  }), {
    headers: corsHeaders
  });
});
