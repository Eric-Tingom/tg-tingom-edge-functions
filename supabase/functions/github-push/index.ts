// github-push Edge Function
// Actions: push, push_file, whoami, check_ascii, read_files,
//          push_from_db, push_from_design_documents, drain_design_documents_queue,
//          drain_dashboard_files_queue
//
// Phase 1 guardrails:
//   - GITHUB_PUSH_DISABLED env var kill switch
//   - Path allowlist for DB-sourced pushes
//   - Repo allowlist for drain_dashboard_files_queue
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const ALLOWED_OWNER = "Eric-Tingom";
const ALLOWED_REPO = "tg-tingom-edge-functions";
const ALLOWED_BRANCH = "main";
const PUBLISHING_ACTIONS = new Set([
  "push",
  "push_file",
  "push_from_db",
  "drain_dashboard_files_queue",
  "push_from_design_documents",
  "drain_design_documents_queue"
]);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json"
};
function validatePath(p) {
  if (p.startsWith("/")) return {
    ok: false,
    reason: `no leading slash: ${p}`
  };
  if (p.includes("..")) return {
    ok: false,
    reason: `no ..: ${p}`
  };
  if (p.includes("\\")) return {
    ok: false,
    reason: `no backslash: ${p}`
  };
  if (!p.startsWith("supabase/functions/")) return {
    ok: false,
    reason: `must start with supabase/functions/: ${p}`
  };
  return {
    ok: true
  };
}
function checkAscii(b64content, firstN = 10) {
  const binary = atob(b64content.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++)bytes[i] = binary.charCodeAt(i);
  let count = 0;
  const positions = [];
  const hexes = [];
  for(let i = 0; i < bytes.length; i++){
    const b = bytes[i];
    const allowed = b === 0x09 || b === 0x0A || b === 0x0D || b >= 0x20 && b <= 0x7E;
    if (!allowed) {
      count++;
      if (positions.length < firstN) {
        positions.push(i);
        hexes.push(b.toString(16).padStart(2, "0"));
      }
    }
  }
  return {
    clean: count === 0,
    non_ascii_count: count,
    first_n_positions: positions,
    first_n_bytes_hex: hexes
  };
}
async function pushFilesAtomic(ghH, owner, repo, branch, commitMessage, files) {
  const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
  const jsonH = {
    ...ghH,
    "Content-Type": "application/json"
  };
  const refR = await fetch(`${apiBase}/git/ref/heads/${branch}`, {
    headers: ghH
  });
  if (refR.status === 404) return {
    success: false,
    error: `preflight failed: repo or branch not found (404): ${owner}/${repo}@${branch}`
  };
  if (!refR.ok) return {
    success: false,
    error: `preflight failed: ref fetch returned ${refR.status}`
  };
  const refData = await refR.json();
  const latestCommit = refData.object.sha;
  const commitR = await fetch(`${apiBase}/git/commits/${latestCommit}`, {
    headers: ghH
  });
  if (!commitR.ok) return {
    success: false,
    error: `commit fetch failed: ${commitR.status}`
  };
  const commitData = await commitR.json();
  const baseTree = commitData.tree.sha;
  const treeItems = await Promise.all(files.map(async (f)=>{
    const b64 = btoa(unescape(encodeURIComponent(f.content)));
    const blobR = await fetch(`${apiBase}/git/blobs`, {
      method: "POST",
      headers: jsonH,
      body: JSON.stringify({
        content: b64,
        encoding: "base64"
      })
    });
    if (!blobR.ok) throw new Error(`blob failed for ${f.path}: ${blobR.status}`);
    const blob = await blobR.json();
    return {
      path: f.path,
      mode: "100644",
      type: "blob",
      sha: blob.sha
    };
  }));
  const newTreeR = await fetch(`${apiBase}/git/trees`, {
    method: "POST",
    headers: jsonH,
    body: JSON.stringify({
      base_tree: baseTree,
      tree: treeItems
    })
  });
  if (!newTreeR.ok) return {
    success: false,
    error: `tree create failed: ${newTreeR.status}`
  };
  const newTree = await newTreeR.json();
  const newCommitR = await fetch(`${apiBase}/git/commits`, {
    method: "POST",
    headers: jsonH,
    body: JSON.stringify({
      message: commitMessage,
      tree: newTree.sha,
      parents: [
        latestCommit
      ]
    })
  });
  if (!newCommitR.ok) return {
    success: false,
    error: `commit create failed: ${newCommitR.status}`
  };
  const newCommit = await newCommitR.json();
  const patchR = await fetch(`${apiBase}/git/refs/heads/${branch}`, {
    method: "PATCH",
    headers: jsonH,
    body: JSON.stringify({
      sha: newCommit.sha
    })
  });
  if (!patchR.ok) return {
    success: false,
    error: `ref patch failed: ${patchR.status}`
  };
  return {
    success: true,
    sha: newCommit.sha
  };
}
async function pushDesignDoc(sb, ghH, docId, branch = "main") {
  const { data: doc, error: fetchErr } = await sb.from("design_documents").select("id, content_md, github_repo, github_path, github_commit_message").eq("id", docId).single();
  if (fetchErr || !doc?.content_md) return {
    success: false,
    error: fetchErr?.message ?? "content_md missing"
  };
  if (!doc.github_repo || !doc.github_path) return {
    success: false,
    error: "github_repo or github_path missing"
  };
  await sb.from("design_documents").update({
    github_push_status: "pushing"
  }).eq("id", docId);
  const [owner, repo] = doc.github_repo.includes("/") ? doc.github_repo.split("/") : [
    "Eric-Tingom",
    doc.github_repo
  ];
  try {
    const result = await pushFilesAtomic(ghH, owner, repo, branch, doc.github_commit_message ?? `docs: update ${doc.github_path}`, [
      {
        path: doc.github_path,
        content: doc.content_md
      }
    ]);
    if (!result.success) throw new Error(result.error);
    await sb.from("design_documents").update({
      github_push_status: "pushed",
      github_pushed_at: new Date().toISOString(),
      github_push_error: null,
      source_url: `https://github.com/${owner}/${repo}/blob/${branch}/${doc.github_path}`
    }).eq("id", docId);
    return {
      success: true,
      sha: result.sha
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sb.from("design_documents").update({
      github_push_status: "failed",
      github_push_error: msg
    }).eq("id", docId);
    return {
      success: false,
      error: msg
    };
  }
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response(null, {
    headers: corsHeaders
  });
  try {
    const body = await req.json();
    const { action } = body;
    if (PUBLISHING_ACTIONS.has(action) && Deno.env.get("GITHUB_PUSH_DISABLED") === "true") {
      return new Response(JSON.stringify({
        error: "GitHub publishing disabled (GITHUB_PUSH_DISABLED=true)"
      }), {
        status: 403,
        headers: corsHeaders
      });
    }
    const sb = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    const { data: ghToken } = await sb.rpc("get_vault_secret", {
      secret_name: "GitHub_Code_Deploy"
    });
    const ghH = {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "FlowOps360",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (action === "drain_dashboard_files_queue") {
      const { data: rows, error: fetchErr } = await sb.from("dashboard_files").select("id, file_path, file_content").eq("deploy_status", "staged").like("file_path", "supabase/functions/%").limit(25);
      if (fetchErr) return new Response(JSON.stringify({
        success: false,
        error: fetchErr.message
      }), {
        status: 500,
        headers: corsHeaders
      });
      if (!rows || rows.length === 0) return new Response(JSON.stringify({
        success: true,
        processed: 0,
        results: []
      }), {
        headers: corsHeaders
      });
      const invalid = rows.filter((r)=>!validatePath(r.file_path).ok);
      if (invalid.length > 0) {
        return new Response(JSON.stringify({
          success: false,
          error: "path validation failed",
          invalid_paths: invalid.map((r)=>validatePath(r.file_path).reason)
        }), {
          status: 400,
          headers: corsHeaders
        });
      }
      const ids = rows.map((r)=>r.id);
      await sb.from("dashboard_files").update({
        deploy_status: "deploying",
        updated_at: new Date().toISOString()
      }).in("id", ids);
      const result = await pushFilesAtomic(ghH, ALLOWED_OWNER, ALLOWED_REPO, ALLOWED_BRANCH, `chore: sync edge functions (${rows.length} files)`, rows.map((r)=>({
          path: r.file_path,
          content: r.file_content
        })));
      if (result.success) {
        await sb.from("dashboard_files").update({
          deploy_status: "deployed",
          deploy_sha: result.sha,
          deployed_at: new Date().toISOString(),
          deploy_error: null,
          updated_at: new Date().toISOString()
        }).in("id", ids);
        return new Response(JSON.stringify({
          success: true,
          processed: rows.length,
          sha: result.sha
        }), {
          headers: corsHeaders
        });
      } else {
        await sb.from("dashboard_files").update({
          deploy_status: "failed",
          deploy_error: result.error,
          updated_at: new Date().toISOString()
        }).in("id", ids);
        return new Response(JSON.stringify({
          success: false,
          error: result.error
        }), {
          status: 500,
          headers: corsHeaders
        });
      }
    }
    if (action === "drain_design_documents_queue") {
      const { data: docs } = await sb.from("design_documents").select("id").eq("github_push_status", "queued").limit(5);
      const results = [];
      for (const d of docs ?? []){
        const r = await pushDesignDoc(sb, ghH, d.id);
        results.push({
          id: d.id,
          ...r
        });
      }
      return new Response(JSON.stringify({
        success: true,
        processed: results.length,
        results
      }), {
        headers: corsHeaders
      });
    }
    if (action === "push_from_design_documents") {
      const { design_document_id, branch = "main" } = body;
      const result = await pushDesignDoc(sb, ghH, design_document_id, branch);
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 422,
        headers: corsHeaders
      });
    }
    if (action === "push") {
      const { owner, repo, branch = "main", commit_message, files } = body;
      if (!owner || !repo || !files?.length) return new Response(JSON.stringify({
        error: "Missing owner, repo, or files"
      }), {
        status: 400,
        headers: corsHeaders
      });
      const result = await pushFilesAtomic(ghH, owner, repo, branch, commit_message ?? "chore: update files", files);
      if (!result.success) return new Response(JSON.stringify({
        success: false,
        error: result.error
      }), {
        status: 500,
        headers: corsHeaders
      });
      const asciiWarnings = files.filter((f)=>f.path.endsWith(".md")).map((f)=>{
        const r = checkAscii(btoa(unescape(encodeURIComponent(f.content))));
        return r.clean ? null : {
          path: f.path,
          non_ascii_count: r.non_ascii_count
        };
      }).filter(Boolean);
      return new Response(JSON.stringify({
        success: true,
        sha: result.sha,
        ascii_warnings: asciiWarnings
      }), {
        headers: corsHeaders
      });
    }
    if (action === "push_file") {
      const { owner, repo, branch = "main", path, content, commit_message } = body;
      const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
      const jsonH = {
        ...ghH,
        "Content-Type": "application/json"
      };
      const existing = await fetch(`${apiBase}/contents/${path}?ref=${branch}`, {
        headers: ghH
      });
      const existingData = existing.ok ? await existing.json() : null;
      const b64 = btoa(unescape(encodeURIComponent(content)));
      const putBody = {
        message: commit_message ?? `update ${path}`,
        content: b64,
        branch
      };
      if (existingData?.sha) putBody.sha = existingData.sha;
      const r = await fetch(`${apiBase}/contents/${path}`, {
        method: "PUT",
        headers: jsonH,
        body: JSON.stringify(putBody)
      });
      const data = await r.json();
      return new Response(JSON.stringify({
        success: r.ok,
        sha: data?.content?.sha
      }), {
        headers: corsHeaders
      });
    }
    if (action === "whoami") {
      const r = await fetch("https://api.github.com/user", {
        headers: ghH
      });
      return new Response(JSON.stringify(await r.json()), {
        headers: corsHeaders
      });
    }
    if (action === "check_ascii") {
      const { owner, repo, paths } = body;
      const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
      const results = await Promise.all(paths.map(async (p)=>{
        const r = await fetch(`${apiBase}/contents/${p}`, {
          headers: ghH
        });
        if (!r.ok) return {
          path: p,
          error: `fetch failed: ${r.status}`
        };
        const d = await r.json();
        const ascii = checkAscii(d.content ?? "");
        return {
          path: p,
          sha: d.sha,
          clean: ascii.clean,
          non_ascii_count: ascii.non_ascii_count,
          first_offenders: ascii.first_n_bytes_hex
        };
      }));
      return new Response(JSON.stringify({
        all_clean: results.every((r)=>r.clean),
        files: results
      }), {
        headers: corsHeaders
      });
    }
    if (action === "read_files") {
      const { owner, repo, paths, branch = "main" } = body;
      const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
      const results = await Promise.all(paths.map(async (p)=>{
        const r = await fetch(`${apiBase}/contents/${p}?ref=${branch}`, {
          headers: ghH
        });
        if (!r.ok) return {
          path: p,
          error: `fetch failed: ${r.status}`
        };
        const d = await r.json();
        return {
          path: p,
          sha: d.sha,
          content: d.encoding === "base64" ? atob(d.content.replace(/\n/g, "")) : d.content
        };
      }));
      return new Response(JSON.stringify({
        success: true,
        files: results
      }), {
        headers: corsHeaders
      });
    }
    if (action === "push_from_db") {
      const { file_path, owner = "Eric-Tingom", repo, branch = "main", commit_message } = body;
      const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
      const jsonH = {
        ...ghH,
        "Content-Type": "application/json"
      };
      const { data: fileRow } = await sb.from("dashboard_files").select("*").eq("file_path", file_path).single();
      if (!fileRow) return new Response(JSON.stringify({
        error: "file not found in dashboard_files"
      }), {
        status: 404,
        headers: corsHeaders
      });
      const b64 = btoa(unescape(encodeURIComponent(fileRow.file_content)));
      const refR = await fetch(`${apiBase}/git/ref/heads/${branch}`, {
        headers: ghH
      });
      const refData = await refR.json();
      const latestCommit = refData.object.sha;
      const commitData = await (await fetch(`${apiBase}/git/commits/${latestCommit}`, {
        headers: ghH
      })).json();
      const blobR = await fetch(`${apiBase}/git/blobs`, {
        method: "POST",
        headers: jsonH,
        body: JSON.stringify({
          content: b64,
          encoding: "base64"
        })
      });
      const blob = await blobR.json();
      const newTreeR = await fetch(`${apiBase}/git/trees`, {
        method: "POST",
        headers: jsonH,
        body: JSON.stringify({
          base_tree: commitData.tree.sha,
          tree: [
            {
              path: file_path,
              mode: "100644",
              type: "blob",
              sha: blob.sha
            }
          ]
        })
      });
      const newTree = await newTreeR.json();
      const newCommitR = await fetch(`${apiBase}/git/commits`, {
        method: "POST",
        headers: jsonH,
        body: JSON.stringify({
          message: commit_message ?? `update ${file_path}`,
          tree: newTree.sha,
          parents: [
            latestCommit
          ]
        })
      });
      const newCommit = await newCommitR.json();
      await fetch(`${apiBase}/git/refs/heads/${branch}`, {
        method: "PATCH",
        headers: jsonH,
        body: JSON.stringify({
          sha: newCommit.sha
        })
      });
      await sb.from("dashboard_files").update({
        deploy_status: "deployed",
        deploy_sha: newCommit.sha,
        deployed_at: new Date().toISOString(),
        deploy_error: null
      }).eq("file_path", file_path);
      return new Response(JSON.stringify({
        success: true,
        sha: newCommit.sha
      }), {
        headers: corsHeaders
      });
    }
    return new Response(JSON.stringify({
      error: "Unknown action"
    }), {
      status: 400,
      headers: corsHeaders
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      const sb2 = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
      await sb2.rpc("slack_alert", {
        p_text: `github-push FATAL: ${msg}`,
        p_emoji: ":rotating_light:",
        p_source: "github-push"
      });
    } catch (_) {}
    return new Response(JSON.stringify({
      error: msg
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
