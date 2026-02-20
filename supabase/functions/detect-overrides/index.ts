import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// Map folder IDs to human-readable names
const FOLDER_NAMES = {
  "AAMkADNkZmM3NjY0LTc1MzMtNGViZC1hNzU4LWViMzcwNzg2NmVlMwAuAAAAAADAjg4MMZFjSIwcSTajcm5CAQDA9GbOYQMjRqnrHdoGMRg_AAw8VZBFAAA=": "Leads",
  "AAMkADNkZmM3NjY0LTc1MzMtNGViZC1hNzU4LWViMzcwNzg2NmVlMwAuAAAAAADAjg4MMZFjSIwcSTajcm5CAQDA9GbOYQMjRqnrHdoGMRg_AAw8VZBVAAA=": "Processed/Action Required",
  "AAMkADNkZmM3NjY0LTc1MzMtNGViZC1hNzU4LWViMzcwNzg2NmVlMwAuAAAAAADAjg4MMZFjSIwcSTajcm5CAQDA9GbOYQMjRqnrHdoGMRg_AAw8VZBWAAA=": "Processed/Filed",
  "AAMkADNkZmM3NjY0LTc1MzMtNGViZC1hNzU4LWViMzcwNzg2NmVlMwAuAAAAAADAjg4MMZFjSIwcSTajcm5CAQDA9GbOYQMjRqnrHdoGMRg_AAw8VZBTAAA=": "Review"
};
// Reverse: folder name → email_types that belong there
const FOLDER_TO_TYPES = {
  "Leads": [
    "lead_linkedin",
    "lead_platform_notification",
    "lead_inbound"
  ],
  "Processed/Action Required": [
    "client_work_request",
    "client_status_update",
    "client_billing",
    "vendor_billing",
    "partner_communication",
    "event_invitation"
  ],
  "Processed/Filed": [
    "personal",
    "vendor_operational",
    "newsletter",
    "learning_content",
    "tool_admin"
  ],
  "Review": [
    "unknown"
  ]
};
Deno.serve(async (req)=>{
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const result = {
    checked: 0,
    overrides_found: 0,
    rules_created: 0,
    rules_updated: 0,
    errors: [],
    details: []
  };
  try {
    // Get Graph token
    const graphToken = await getValidGraphToken(supabase);
    if (!graphToken) return jsonResponse({
      error: "Could not obtain MS Graph token"
    }, 500);
    // Get recently processed emails that haven't been checked for overrides yet
    // Check emails processed in the last 48h, limit to 20 per run to stay within Graph rate limits
    const { data: emails, error: fetchErr } = await supabase.from("email_monitoring_queue").select("id, message_id, sender_email, sender_domain, subject, email_type, outlook_folder_id, outlook_folder_name, classification_source, override_detected, override_checked_at").not("status", "eq", "new").not("outlook_folder_id", "is", null).not("message_id", "is", null).gte("received_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()).or("override_checked_at.is.null,override_checked_at.lt." + new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()).order("received_at", {
      ascending: false
    }).limit(20);
    if (fetchErr) return jsonResponse({
      error: `Fetch failed: ${fetchErr.message}`
    }, 500);
    if (!emails || emails.length === 0) return jsonResponse({
      message: "No emails to check",
      ...result
    });
    // Load folder map for reverse lookups
    const { data: folderMap } = await supabase.from("email_folder_map").select("email_type, folder_name, outlook_folder_id").eq("is_active", true);
    const folderIdToTypes = {};
    for (const fm of folderMap || []){
      if (!folderIdToTypes[fm.outlook_folder_id]) folderIdToTypes[fm.outlook_folder_id] = [];
      folderIdToTypes[fm.outlook_folder_id].push(fm.email_type);
    }
    for (const email of emails){
      try {
        result.checked++;
        // Get current folder from Graph API
        const msgRes = await fetch(`${GRAPH_BASE}/me/messages/${email.message_id}?$select=parentFolderId`, {
          headers: {
            Authorization: `Bearer ${graphToken}`
          }
        });
        if (!msgRes.ok) {
          if (msgRes.status === 404) {
            // Message deleted or permanently moved — mark as checked
            await supabase.from("email_monitoring_queue").update({
              override_checked_at: new Date().toISOString()
            }).eq("id", email.id);
            continue;
          }
          result.errors.push(`Graph API error for ${email.id}: ${msgRes.status}`);
          continue;
        }
        const msgData = await msgRes.json();
        const currentFolderId = msgData.parentFolderId;
        // Mark as checked
        const checkUpdate = {
          override_checked_at: new Date().toISOString()
        };
        // Compare current folder to where processor put it
        if (currentFolderId && currentFolderId !== email.outlook_folder_id) {
          // OVERRIDE DETECTED
          const originalFolderName = FOLDER_NAMES[email.outlook_folder_id] || email.outlook_folder_name || "Unknown";
          const currentFolderName = FOLDER_NAMES[currentFolderId] || "Unknown";
          // Infer what Eric was correcting to
          const inferredTypes = folderIdToTypes[currentFolderId] || FOLDER_TO_TYPES[currentFolderName] || null;
          let inferredCorrection = null;
          // If the destination folder maps to a single category of types, we can infer the correction
          if (inferredTypes && inferredTypes.length > 0) {
            // If moved to Leads folder, likely a lead type
            // If moved to Filed, likely noise
            // If moved to Action Required, likely needs action
            // We can't know the exact type, but we know the folder preference
            inferredCorrection = currentFolderName;
          }
          checkUpdate.override_detected = true;
          checkUpdate.override_from_folder = originalFolderName;
          checkUpdate.override_to_folder = currentFolderName;
          checkUpdate.override_detected_at = new Date().toISOString();
          // Update the stored folder to match reality
          checkUpdate.outlook_folder_id = currentFolderId;
          checkUpdate.outlook_folder_name = currentFolderName;
          result.overrides_found++;
          result.details.push({
            email_id: email.id,
            sender: email.sender_email,
            subject: email.subject,
            original_type: email.email_type,
            original_folder: originalFolderName,
            current_folder: currentFolderName,
            inferred_correction: inferredCorrection
          });
          // FEEDBACK LOOP: Update or create classification rules based on the override
          await processOverrideFeedback(supabase, email, currentFolderName, currentFolderId, folderMap || [], result);
        }
        await supabase.from("email_monitoring_queue").update(checkUpdate).eq("id", email.id);
      } catch (emailErr) {
        result.errors.push(`Error checking email ${email.id}: ${String(emailErr)}`);
      }
    }
    // Log the run
    await supabase.from("automation_audit_log").insert({
      mailbox: "outlook",
      actor: "detect-overrides",
      scenario_name: "detect-overrides",
      actions_taken: {
        checked: result.checked,
        overrides_found: result.overrides_found,
        rules_created: result.rules_created,
        rules_updated: result.rules_updated,
        details: result.details
      },
      outcome: result.errors.length > 0 ? "partial" : "success",
      error_message: result.errors.length > 0 ? result.errors.join("; ") : null
    });
    return jsonResponse({
      message: `Checked ${result.checked} emails, found ${result.overrides_found} overrides`,
      ...result
    });
  } catch (err) {
    await supabase.from("automation_audit_log").insert({
      mailbox: "outlook",
      actor: "detect-overrides",
      scenario_name: "detect-overrides",
      outcome: "error",
      error_message: String(err)
    }).catch(()=>{});
    return jsonResponse({
      error: String(err),
      details: result
    }, 500);
  }
});
async function processOverrideFeedback(supabase, email, targetFolderName, targetFolderId, folderMap, result) {
  // Determine if this was a classification correction we can learn from.
  //
  // Scenarios:
  // 1. AI classified as "newsletter" → Filed. Eric moved to "Action Required"
  //    → The sender needs action. Disable auto-learn rule if one exists.
  // 2. AI classified as "client_work_request" → Action Required. Eric moved to "Filed"
  //    → Likely not actionable. Could create a rule for this sender.
  // 3. AI classified as "unknown" → Review. Eric moved to "Filed"
  //    → Eric decided it's noise. Create auto-learn rule.
  // 4. AI classified as "unknown" → Review. Eric moved to "Action Required"
  //    → Eric decided it needs action. Log but don't auto-learn (too ambiguous).
  //
  // Key principle: Only create rules for sender_email moves that are unambiguous.
  // Moving to "Filed" = noise. Moving to "Leads" = lead. Moving to "Action Required" is ambiguous
  // (could be any of several action types).
  const senderEmail = email.sender_email?.toLowerCase();
  if (!senderEmail) return;
  // Check if there's an existing auto-learned rule for this sender
  const { data: existingRule } = await supabase.from("email_classification_rules").select("id, source, resulting_email_type, times_matched").eq("match_field", "sender_email").eq("match_value", senderEmail).eq("is_active", true).maybeSingle();
  // CASE 1: Moved to "Processed/Filed" — Eric says this is noise
  if (targetFolderName === "Processed/Filed") {
    // Infer the most likely "filed" type based on original classification
    // If it was a client type moved to filed, probably vendor_operational or personal
    // If it was unknown moved to filed, probably newsletter/tool_admin
    const filedType = inferFiledType(email.email_type, email.sender_domain);
    if (existingRule) {
      // Update existing rule to file instead
      if (existingRule.resulting_email_type !== filedType) {
        await supabase.from("email_classification_rules").update({
          resulting_email_type: filedType,
          rule_name: `Override: ${senderEmail} -> ${filedType}`,
          source: "human_override",
          confidence_score: 1.0
        }).eq("id", existingRule.id);
        result.rules_updated++;
      }
    } else {
      // Create new rule
      await supabase.from("email_classification_rules").insert({
        rule_name: `Override: ${senderEmail} -> ${filedType}`,
        match_field: "sender_email",
        match_value: senderEmail,
        match_operator: "equals",
        resulting_email_type: filedType,
        source: "human_override",
        source_email_id: email.id,
        confidence_score: 1.0,
        priority: 40
      });
      result.rules_created++;
    }
  } else if (targetFolderName === "Leads") {
    const leadType = "lead_inbound"; // Default to inbound lead
    if (existingRule) {
      if (existingRule.resulting_email_type !== leadType) {
        await supabase.from("email_classification_rules").update({
          resulting_email_type: leadType,
          rule_name: `Override: ${senderEmail} -> ${leadType}`,
          source: "human_override",
          confidence_score: 1.0
        }).eq("id", existingRule.id);
        result.rules_updated++;
      }
    } else {
      await supabase.from("email_classification_rules").insert({
        rule_name: `Override: ${senderEmail} -> ${leadType}`,
        match_field: "sender_email",
        match_value: senderEmail,
        match_operator: "equals",
        resulting_email_type: leadType,
        source: "human_override",
        source_email_id: email.id,
        confidence_score: 1.0,
        priority: 40
      });
      result.rules_created++;
    }
  } else if (targetFolderName === "Processed/Action Required") {
    if (existingRule && existingRule.source === "auto_learned") {
      // The auto-learned rule got it wrong — deactivate it
      await supabase.from("email_classification_rules").update({
        is_active: false,
        rule_name: `DISABLED by override: ${existingRule.resulting_email_type}`
      }).eq("id", existingRule.id);
      result.rules_updated++;
    }
  // Don't create a new rule — "Action Required" is too ambiguous to map to a single email_type
  }
// CASE 4: Moved to "Review" — Eric isn't sure, wants to look later
// No rule changes — just log it
}
function inferFiledType(originalType, senderDomain) {
  // If it was originally classified as a client type but Eric filed it,
  // it's probably vendor_operational or personal
  if (originalType?.startsWith("client_")) return "vendor_operational";
  if (originalType === "unknown") return "newsletter"; // Most unknowns that get filed are noise
  if (originalType === "lead_inbound" || originalType === "lead_linkedin") return "newsletter"; // False lead
  return "tool_admin"; // Default filed type
}
async function getValidGraphToken(supabase) {
  try {
    const { data: tokenRow } = await supabase.from("msgraph_tokens").select("access_token, expires_at").eq("id", 1).single();
    if (!tokenRow) return null;
    if (new Date(tokenRow.expires_at).getTime() - Date.now() > 5 * 60 * 1000) return tokenRow.access_token;
    const { data: creds } = await supabase.rpc("get_msgraph_credentials");
    if (!creds) return null;
    const { client_id, client_secret, tenant_id, refresh_token } = creds;
    const body = new URLSearchParams({
      client_id,
      client_secret,
      refresh_token,
      grant_type: "refresh_token",
      scope: "https://graph.microsoft.com/.default offline_access"
    });
    const tokenRes = await fetch(`https://login.microsoftonline.com/${tenant_id}/oauth2/v2.0/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });
    if (!tokenRes.ok) return null;
    const tokenData = await tokenRes.json();
    await supabase.from("msgraph_tokens").update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || refresh_token,
      expires_at: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", 1);
    return tokenData.access_token;
  } catch  {
    return null;
  }
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
