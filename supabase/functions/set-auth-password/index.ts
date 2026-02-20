import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }
  try {
    const { password, secret } = await req.json();
    if (secret !== "tingom-set-pw-2026") {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    if (!password || password.length < 8) {
      return new Response(JSON.stringify({ error: "Password must be at least 8 characters" }), { status: 400 });
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const userId = "4571b4a3-66fe-4584-8d85-facc54039537";
    const { data, error } = await supabase.auth.admin.updateUser(userId, {
      password: password,
      email_confirm: true,
    });
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
    return new Response(JSON.stringify({
      success: true,
      message: "Password set for etingom@tingomgroup.net. Delete this Edge Function now.",
      user_id: data.user.id,
      email: data.user.email
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});