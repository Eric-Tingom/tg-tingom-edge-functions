import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json"
};
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response(null, {
    headers: corsHeaders
  });
  try {
    const { owner, repo } = await req.json();
    const sb = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    // Fetch dashboard HTML from coo-dashboard edge function
    const dashRes = await fetch(Deno.env.get("SUPABASE_URL") + '/functions/v1/coo-dashboard');
    if (!dashRes.ok) return new Response(JSON.stringify({
      error: 'Failed to fetch dashboard',
      status: dashRes.status
    }), {
      status: 500,
      headers: corsHeaders
    });
    let fullHTML = await dashRes.text();
    // FIX: Escape </ inside <script> blocks to prevent HTML parser issues
    // The Edge Function template literals produce raw </ which breaks browsers
    // Replace </ with <\/ inside all script blocks (safe in JS: \/ === /)
    fullHTML = fullHTML.replace(/<script>(.*?)<\/script>/gs, (match, scriptContent)=>{
      // Escape </ to <\/ in the JS content
      // But preserve the actual </script> closing tag
      const fixed = scriptContent.replace(/<\//g, '<\\/');
      // Also fix regex /</g -> /\x3c/g
      const fixed2 = fixed.replace(/\/(<\\\/)g/g, '/\\x3c/g');
      return '<script>' + fixed2 + '</script>';
    });
    // Get GitHub token via existing RPC
    const { data: ghToken, error: rpcErr } = await sb.rpc('get_vault_secret', {
      secret_name: 'GitHub_Code_Deploy'
    });
    if (rpcErr || !ghToken) return new Response(JSON.stringify({
      error: 'Vault access failed',
      detail: rpcErr?.message
    }), {
      status: 500,
      headers: corsHeaders
    });
    const ghH = {
      "Authorization": `Bearer ${ghToken}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "FlowOps360",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    const b64 = btoa(unescape(encodeURIComponent(fullHTML)));
    let sha;
    const ck = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/public/index.html`, {
      headers: ghH
    });
    if (ck.ok) {
      const ex = await ck.json();
      sha = ex.sha;
    }
    const body = {
      message: 'Deploy FlowOps360 Command Center v1.0 - fix script escaping',
      content: b64
    };
    if (sha) body.sha = sha;
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/public/index.html`, {
      method: "PUT",
      headers: {
        ...ghH,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const result = await r.json();
    return new Response(JSON.stringify({
      status: r.status,
      sha: result.content?.sha,
      size: fullHTML.length,
      message: result.message || "pushed"
    }), {
      headers: corsHeaders
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: e.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
