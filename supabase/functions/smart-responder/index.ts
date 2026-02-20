import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4"

const HUBSPOT_API_KEY = Deno.env.get('HUBSPOT_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: recentLogs, error: logError } = await supabase
    .from('sync_log')
    .select('*, client_registry!inner(client_name, health_status, strategic_pillar_id)')
    .eq('sync_status', 'pending')
    .limit(10);
  if (logError) return new Response(JSON.stringify({ error: logError.message }), { status: 500 });
  const proposals = [];
  for (const item of recentLogs) {
    const { data: rules } = await supabase
      .from('operating_manual')
      .select('content, agent_restriction')
      .contains('keywords', [item.source_type])
      .limit(3);
    proposals.push({
      agent_id: 'chief-of-staff',
      action_type: item.source_type === 'ticket' ? 'Draft Reply' : 'Status Update',
      client_id: item.hubspot_contact_id,
      related_task_id: item.task_id,
      justification: `Client ${item.client_registry.client_name} has a ${item.health_status} status. Rules found: ${rules?.length || 0}`,
      proposed_content: { subject: `Follow up: ${item.task_name}`, body_suggestion: "Drafting based on operating manual rules..." },
      status: 'pending'
    });
  }
  if (proposals.length > 0) await supabase.from('agent_proposals').insert(proposals);
  return new Response(JSON.stringify({ message: `Generated ${proposals.length} proposals.` }), { headers: { "Content-Type": "application/json" } });
});