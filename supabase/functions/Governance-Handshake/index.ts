import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
serve(async (req)=>{
  try {
    const { assistant_id, operation, payload, target_system } = await req.json();
    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    // --- 1. THE EMERGENCY KILL SWITCH ---
    // Checks if the entire agency is paused before doing anything else
    const { data: settings } = await supabase.from('agency_settings').select('is_active, maintenance_message').eq('id', 1).single();
    if (settings && !settings.is_active) {
      return new Response(JSON.stringify({
        status: "PAUSED",
        message: settings.maintenance_message
      }), {
        status: 503,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // --- 2. IDENTITY & RULE REGISTRY ---
    // Fetches the agent's laws and instructions
    const { data: governance, error } = await supabase.from('governor_view').select('*').eq('assistant_id', assistant_id).single();
    if (error || !governance) {
      return new Response(JSON.stringify({
        error: "Agent Not Registered"
      }), {
        status: 404
      });
    }
    // --- 3. THE CRUD GATEKEEPER (Human-in-the-Loop) ---
    // Intercepts sensitive actions and routes them to the Slack-monitored queue
    if (operation === 'UPDATE' || operation === 'DELETE') {
      const { error: queueError } = await supabase.from('approval_queue').insert({
        assistant_id,
        operation_type: operation,
        target_system: target_system,
        proposed_payload: payload,
        status: 'pending'
      });
      return new Response(JSON.stringify({
        status: "HELD_FOR_APPROVAL",
        message: "Destructive action blocked. Sent to Slack for Human Approval."
      }), {
        status: 202,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // --- 4. SUCCESSFUL HANDSHAKE ---
    // Returns full operating instructions for safe (READ/INFO) operations
    return new Response(JSON.stringify({
      agent_name: governance.assistant_name,
      scope: governance.scope,
      rules: governance.active_rules,
      restrictions: governance.active_restrictions,
      skill_path: governance.skill_file_path,
      can_proceed: true
    }), {
      headers: {
        "Content-Type": "application/json"
      },
      status: 200
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: err.message
    }), {
      status: 500
    });
  }
});
