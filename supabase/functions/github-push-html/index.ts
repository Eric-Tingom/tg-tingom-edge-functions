import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { owner, repo } = await req.json();
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const dashRes = await fetch(Deno.env.get("SUPABASE_URL")! + "/functions/v1/coo-dashboard");
    if (!dashRes.ok) return new Response(JSON.stringify({ error: "Failed to fetch dashboard" }), { status: 500, headers: corsHeaders });
    let fullHTML = await dashRes.text();
    fullHTML = fullHTML.replace(/<script>(.*?)<\/script>/gs, (match: string, scriptContent: string) => {
      const fixed = scriptContent.replace(/<\//g, "<\\/");
      const fixed2 = fixed.replace(/\/(<\\\/)/g, "/\\x3c/g");
      return "<script>" + fixed2 + "</script>";
    });
    const { data: ghToken, error: rpcErr } = await sb.rpc("get_vault_secret", { secret_name: "GitHub_Code_Deploy" });
    if (rpcErr || !ghToken) return new Response(JSON.stringify({ error: "Vault access failed" }), { status: 500, headers: corsHeaders });
    const ghH = { "Authorization": `Bearer ${ghToken}`, "Accept": "application/vnd.github+json", "User-Agent": "FlowOps360", "X-GitHub-Api-Version": "2022-11-28" };
    const b64 = btoa(unescape(encodeURIComponent(fullHTML)));
    let sha;
    const ck = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/public/index.html`, { headers: ghH });
    if (ck.ok) { const ex = await ck.json(); sha = ex.sha; }
    const body: any = { message: "Deploy FlowOps360 Command Center", content: b64 };
    if (sha) body.sha = sha;
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/public/index.html`, { method: "PUT", headers: { ...ghH, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await r.json();
    return new Response(JSON.stringify({ status: r.status, sha: result.content?.sha, size: fullHTML.length }), { headers: corsHeaders });
  } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders }); }
});