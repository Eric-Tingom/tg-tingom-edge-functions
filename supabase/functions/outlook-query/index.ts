import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
  }
  if (req.method !== "POST") {
    return jsonResponse({
      error: "Expected POST request"
    }, 405);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    const body = await req.json();
    const { action } = body;
    const accessToken = await getValidToken(supabase);
    if (!accessToken) {
      return jsonResponse({
        error: "Could not obtain valid MS Graph token. Refresh token may be expired — re-auth needed."
      }, 500);
    }
    switch(action){
      case "search_emails":
        return await searchEmails(accessToken, body.params);
      case "get_email":
        return await getEmail(accessToken, body.params?.messageId);
      case "get_email_thread":
        return await getEmailThread(accessToken, body.params?.conversationId);
      case "search_calendar":
        return await searchCalendar(accessToken, body.params);
      case "get_event":
        return await getEvent(accessToken, body.params?.eventId);
      case "send_email":
        return await sendEmail(accessToken, body.params);
      case "create_draft":
        return await createDraft(accessToken, body.params);
      case "list_folders":
        return await listFolders(accessToken);
      case "list_child_folders":
        return await listChildFolders(accessToken, body.params?.folderId);
      case "create_folder":
        return await createFolder(accessToken, body.params);
      case "move_email":
        return await moveEmail(accessToken, body.params);
      default:
        return jsonResponse({
          error: `Unknown action: ${action}`,
          available_actions: [
            "search_emails",
            "get_email",
            "get_email_thread",
            "search_calendar",
            "get_event",
            "send_email",
            "create_draft",
            "list_folders",
            "list_child_folders",
            "create_folder",
            "move_email"
          ]
        }, 400);
    }
  } catch (err) {
    return jsonResponse({
      error: String(err)
    }, 500);
  }
});
// ========================================
// EMAIL ACTIONS
// ========================================
async function searchEmails(token, params) {
  const { query, from, subject, folder, top = 20, after, before, hasAttachments } = params || {};
  const emailFields = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,conversationId,bodyPreview,hasAttachments,isRead,importance";
  const kqlParts = [];
  if (query) kqlParts.push(query);
  if (subject) kqlParts.push(`subject:${subject}`);
  if (from) kqlParts.push(`from:${from}`);
  if (hasAttachments === true) kqlParts.push(`hasAttachments:true`);
  const useSearch = kqlParts.length > 0;
  const filters = [];
  if (!useSearch) {
    if (after) filters.push(`receivedDateTime ge ${after}`);
    if (before) filters.push(`receivedDateTime le ${before}`);
    if (hasAttachments !== undefined) filters.push(`hasAttachments eq ${hasAttachments}`);
  }
  let url;
  if (useSearch) {
    url = `${GRAPH_BASE}/me/messages?`;
    url += `$top=${Math.min(top, 50)}`;
    url += `&$select=${emailFields}`;
    const kqlString = kqlParts.join(" ");
    url += `&$search="${kqlString}"`;
  } else {
    const targetFolder = folder || "inbox";
    url = `${GRAPH_BASE}/me/mailFolders/${targetFolder}/messages?`;
    url += `$top=${Math.min(top, 50)}`;
    url += `&$select=${emailFields}`;
    if (filters.length > 0) url += `&$filter=${filters.join(" and ")}`;
    url += `&$orderby=receivedDateTime desc`;
  }
  const res = await graphFetch(token, url);
  if (!res.ok) {
    const errText = await res.text();
    return jsonResponse({
      error: `Email search failed: ${res.status}`,
      details: errText,
      url_used: url
    }, res.status);
  }
  const data = await res.json();
  const messages = (data.value || []).map(formatMessage);
  return jsonResponse({
    count: messages.length,
    messages,
    hasMore: !!data["@odata.nextLink"]
  });
}
async function getEmail(token, messageId) {
  if (!messageId) return jsonResponse({
    error: "messageId required"
  }, 400);
  const url = `${GRAPH_BASE}/me/messages/${messageId}?$select=id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,conversationId,internetMessageId,body,hasAttachments,importance,isRead`;
  const res = await graphFetch(token, url);
  if (!res.ok) return jsonResponse({
    error: `Get email failed: ${res.status}`
  }, res.status);
  const m = await res.json();
  return jsonResponse({
    id: m.id,
    subject: m.subject,
    from: m.from?.emailAddress,
    to: (m.toRecipients || []).map((r)=>r.emailAddress),
    cc: (m.ccRecipients || []).map((r)=>r.emailAddress),
    bcc: (m.bccRecipients || []).map((r)=>r.emailAddress),
    receivedAt: m.receivedDateTime,
    sentAt: m.sentDateTime,
    body: m.body?.content,
    bodyType: m.body?.contentType,
    conversationId: m.conversationId,
    internetMessageId: m.internetMessageId,
    hasAttachments: m.hasAttachments,
    importance: m.importance,
    isRead: m.isRead
  });
}
async function getEmailThread(token, conversationId) {
  if (!conversationId) return jsonResponse({
    error: "conversationId required"
  }, 400);
  const escapedId = conversationId.replace(/'/g, "''");
  const url = `${GRAPH_BASE}/me/messages?$filter=conversationId eq '${escapedId}'&$orderby=receivedDateTime asc&$top=50&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,isRead`;
  const res = await graphFetch(token, url);
  if (!res.ok) {
    const errText = await res.text();
    return jsonResponse({
      error: `Get thread failed: ${res.status}`,
      details: errText
    }, res.status);
  }
  const data = await res.json();
  const messages = (data.value || []).map((m)=>({
      id: m.id,
      subject: m.subject,
      from: m.from?.emailAddress,
      to: (m.toRecipients || []).map((r)=>r.emailAddress),
      receivedAt: m.receivedDateTime,
      preview: m.bodyPreview,
      body: m.body?.content,
      isRead: m.isRead
    }));
  return jsonResponse({
    count: messages.length,
    messages
  });
}
async function sendEmail(token, params) {
  if (!params?.to?.length || !params?.subject) return jsonResponse({
    error: "to and subject required"
  }, 400);
  const message = {
    subject: params.subject,
    body: {
      contentType: params.bodyType || "HTML",
      content: params.body
    },
    toRecipients: params.to.map((e)=>({
        emailAddress: {
          address: e
        }
      }))
  };
  if (params.cc) message.ccRecipients = params.cc.map((e)=>({
      emailAddress: {
        address: e
      }
    }));
  if (params.bcc) message.bccRecipients = params.bcc.map((e)=>({
      emailAddress: {
        address: e
      }
    }));
  if (params.replyTo) message.replyTo = params.replyTo.map((e)=>({
      emailAddress: {
        address: e
      }
    }));
  const res = await graphFetch(token, `${GRAPH_BASE}/me/sendMail`, {
    method: "POST",
    body: JSON.stringify({
      message,
      saveToSentItems: params.saveToSentItems !== false
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    return jsonResponse({
      error: `Send failed: ${res.status}`,
      details: errText
    }, res.status);
  }
  return jsonResponse({
    success: true,
    message: "Email sent from etingom@tingomgroup.net"
  });
}
async function createDraft(token, params) {
  if (!params?.to?.length || !params?.subject) return jsonResponse({
    error: "to and subject required"
  }, 400);
  const message = {
    subject: params.subject,
    body: {
      contentType: params.bodyType || "HTML",
      content: params.body
    },
    toRecipients: params.to.map((e)=>({
        emailAddress: {
          address: e
        }
      }))
  };
  if (params.cc) message.ccRecipients = params.cc.map((e)=>({
      emailAddress: {
        address: e
      }
    }));
  if (params.bcc) message.bccRecipients = params.bcc.map((e)=>({
      emailAddress: {
        address: e
      }
    }));
  const res = await graphFetch(token, `${GRAPH_BASE}/me/messages`, {
    method: "POST",
    body: JSON.stringify(message)
  });
  if (!res.ok) {
    const errText = await res.text();
    return jsonResponse({
      error: `Draft creation failed: ${res.status}`,
      details: errText
    }, res.status);
  }
  const draft = await res.json();
  return jsonResponse({
    success: true,
    draftId: draft.id,
    webLink: draft.webLink,
    message: "Draft created in Outlook"
  });
}
// ========================================
// FOLDER ACTIONS
// ========================================
async function listFolders(token) {
  const url = `${GRAPH_BASE}/me/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount,parentFolderId`;
  const res = await graphFetch(token, url);
  if (!res.ok) return jsonResponse({
    error: `List folders failed: ${res.status}`
  }, res.status);
  const data = await res.json();
  return jsonResponse({
    folders: (data.value || []).map((f)=>({
        id: f.id,
        name: f.displayName,
        totalItems: f.totalItemCount,
        unreadItems: f.unreadItemCount,
        parentFolderId: f.parentFolderId
      }))
  });
}
async function listChildFolders(token, folderId) {
  if (!folderId) return jsonResponse({
    error: "folderId required"
  }, 400);
  const url = `${GRAPH_BASE}/me/mailFolders/${folderId}/childFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount,parentFolderId`;
  const res = await graphFetch(token, url);
  if (!res.ok) {
    const errText = await res.text();
    return jsonResponse({
      error: `List child folders failed: ${res.status}`,
      details: errText
    }, res.status);
  }
  const data = await res.json();
  return jsonResponse({
    folders: (data.value || []).map((f)=>({
        id: f.id,
        name: f.displayName,
        totalItems: f.totalItemCount,
        unreadItems: f.unreadItemCount,
        parentFolderId: f.parentFolderId
      }))
  });
}
async function createFolder(token, params) {
  if (!params?.displayName) return jsonResponse({
    error: "displayName required"
  }, 400);
  // If parentFolderId is provided, create as child folder
  // Otherwise create at top level
  const url = params.parentFolderId ? `${GRAPH_BASE}/me/mailFolders/${params.parentFolderId}/childFolders` : `${GRAPH_BASE}/me/mailFolders`;
  const res = await graphFetch(token, url, {
    method: "POST",
    body: JSON.stringify({
      displayName: params.displayName,
      isHidden: false
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    return jsonResponse({
      error: `Create folder failed: ${res.status}`,
      details: errText
    }, res.status);
  }
  const folder = await res.json();
  return jsonResponse({
    success: true,
    folder: {
      id: folder.id,
      name: folder.displayName,
      parentFolderId: folder.parentFolderId
    }
  });
}
async function moveEmail(token, params) {
  if (!params?.messageId) return jsonResponse({
    error: "messageId required"
  }, 400);
  if (!params?.destinationFolderId) return jsonResponse({
    error: "destinationFolderId required"
  }, 400);
  const url = `${GRAPH_BASE}/me/messages/${params.messageId}/move`;
  const res = await graphFetch(token, url, {
    method: "POST",
    body: JSON.stringify({
      destinationId: params.destinationFolderId
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    return jsonResponse({
      error: `Move email failed: ${res.status}`,
      details: errText
    }, res.status);
  }
  const moved = await res.json();
  return jsonResponse({
    success: true,
    newMessageId: moved.id,
    destinationFolderId: params.destinationFolderId
  });
}
// ========================================
// CALENDAR ACTIONS
// ========================================
async function searchCalendar(token, params) {
  if (!params?.startDate || !params?.endDate) return jsonResponse({
    error: "startDate and endDate required (ISO format, e.g. 2026-02-01T00:00:00)"
  }, 400);
  const calFields = "id,subject,start,end,location,isAllDay,isCancelled,organizer,attendees,onlineMeeting,bodyPreview,responseStatus,webLink";
  let url = `${GRAPH_BASE}/me/calendarView?startDateTime=${params.startDate}&endDateTime=${params.endDate}&$orderby=start/dateTime&$top=${Math.min(params.top || 50, 100)}&$select=${calFields}`;
  const res = await graphFetch(token, url, {
    headers: {
      Prefer: 'outlook.timezone="America/Phoenix"'
    }
  });
  if (!res.ok) {
    const errText = await res.text();
    return jsonResponse({
      error: `Calendar search failed: ${res.status}`,
      details: errText
    }, res.status);
  }
  const data = await res.json();
  const events = (data.value || []).map(formatEvent);
  return jsonResponse({
    count: events.length,
    events,
    hasMore: !!data["@odata.nextLink"]
  });
}
async function getEvent(token, eventId) {
  if (!eventId) return jsonResponse({
    error: "eventId required"
  }, 400);
  const url = `${GRAPH_BASE}/me/events/${eventId}?$select=id,subject,start,end,location,isAllDay,isCancelled,organizer,attendees,onlineMeeting,body,responseStatus,webLink`;
  const res = await graphFetch(token, url, {
    headers: {
      Prefer: 'outlook.timezone="America/Phoenix"'
    }
  });
  if (!res.ok) return jsonResponse({
    error: `Get event failed: ${res.status}`
  }, res.status);
  const evt = await res.json();
  return jsonResponse({
    ...formatEvent(evt),
    body: evt.body?.content,
    bodyType: evt.body?.contentType
  });
}
// ========================================
// TOKEN MANAGEMENT
// ========================================
async function getValidToken(supabase) {
  const { data: tokenRow } = await supabase.from("msgraph_tokens").select("access_token, expires_at").eq("id", 1).single();
  if (!tokenRow) return null;
  const expiresAt = new Date(tokenRow.expires_at);
  const bufferMs = 5 * 60 * 1000;
  if (expiresAt.getTime() - Date.now() > bufferMs) {
    return tokenRow.access_token;
  }
  return await refreshToken(supabase);
}
async function refreshToken(supabase) {
  try {
    const { data: creds, error: rpcError } = await supabase.rpc("get_msgraph_credentials");
    if (rpcError || !creds) {
      console.error("RPC get_msgraph_credentials failed:", rpcError);
      return null;
    }
    const { client_id, client_secret, tenant_id, refresh_token } = creds;
    if (!client_id || !client_secret || !tenant_id || !refresh_token) {
      console.error("Missing credentials from vault");
      return null;
    }
    const tokenUrl = `https://login.microsoftonline.com/${tenant_id}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id,
      client_secret,
      refresh_token,
      grant_type: "refresh_token",
      scope: "https://graph.microsoft.com/.default offline_access"
    });
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("Token refresh failed:", tokenRes.status, errText);
      return null;
    }
    const tokenData = await tokenRes.json();
    const newAccessToken = tokenData.access_token;
    const newRefreshToken = tokenData.refresh_token || refresh_token;
    const expiresIn = tokenData.expires_in || 3600;
    const newExpiresAt = new Date(Date.now() + expiresIn * 1000);
    await supabase.from("msgraph_tokens").update({
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      expires_at: newExpiresAt.toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", 1);
    return newAccessToken;
  } catch (err) {
    console.error("Token refresh exception:", err);
    return null;
  }
}
// ========================================
// FORMATTERS
// ========================================
function formatMessage(m) {
  return {
    id: m.id,
    subject: m.subject,
    from: m.from?.emailAddress?.address,
    fromName: m.from?.emailAddress?.name,
    to: (m.toRecipients || []).map((r)=>r.emailAddress?.address),
    cc: (m.ccRecipients || []).map((r)=>r.emailAddress?.address),
    receivedAt: m.receivedDateTime,
    preview: m.bodyPreview,
    conversationId: m.conversationId,
    hasAttachments: m.hasAttachments,
    isRead: m.isRead,
    importance: m.importance
  };
}
function formatEvent(evt) {
  return {
    id: evt.id,
    subject: evt.subject,
    startTime: evt.start?.dateTime,
    endTime: evt.end?.dateTime,
    timeZone: evt.start?.timeZone,
    location: evt.location?.displayName,
    isAllDay: evt.isAllDay,
    isCancelled: evt.isCancelled,
    organizer: evt.organizer?.emailAddress,
    attendees: (evt.attendees || []).map((a)=>({
        name: a.emailAddress?.name,
        email: a.emailAddress?.address,
        response: a.status?.response
      })),
    onlineMeetingUrl: evt.onlineMeeting?.joinUrl,
    preview: evt.bodyPreview,
    responseStatus: evt.responseStatus?.response,
    webLink: evt.webLink
  };
}
// ========================================
// HELPERS
// ========================================
async function graphFetch(token, url, options = {}) {
  return fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers || {}
    },
    body: options.body
  });
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
