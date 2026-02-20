// supabase/functions/governance-engine/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
serve(async (req)=>{
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const { assistant_id, task_request, client_id } = await req.json();
  // 1. GET AGENT SCOPE & RULES
  const { data: assistant } = await supabase.from('assistants').select('scope, rules_assigned, scope_confirmation_required').eq('assistant_id', assistant_id).single();
  // 2. GET OPERATING MANUAL RESTRICTIONS
  const { data: manualRules } = await supabase.from('operating_manual').select('content, agent_restriction').filter('id', 'in', `(${assistant.rules_assigned.join(',')})`);
  // 3. GOVERNANCE EVALUATION
  // Here, the function decides if the task_request matches the scope.
  const isAllowed = manualRules.every((rule)=>!task_request.includes(rule.agent_restriction));
  if (!isAllowed) {
    return new Response(JSON.stringify({
      error: "Scope Violation Detected"
    }), {
      status: 403
    });
  }
  // 4. LOG ATTEMPT
  await supabase.from('execution_log').insert({
    agent_id: assistant_id,
    action_type: 'governance_check',
    status: 'passed'
  });
  return new Response(JSON.stringify({
    status: "Governed Proceed",
    rules_applied: manualRules.length
  }));
});
