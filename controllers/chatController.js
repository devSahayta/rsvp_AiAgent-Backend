// controllers/chatController.js
// ONE chat per phone number (like WhatsApp).
// All events' messages go into the same chat thread.
// Call-batch dashboard reads from event_rsvp_responses / conversation_results,
// not from chats — so this doesn't affect per-event reporting.

import { supabase } from "../config/supabase.js";

export async function ensureChat({
  event_id,
  phone_number,
  person_name,
  user_id,
}) {
  // 1. Exact match: event_id + phone (fastest path, avoids any churn)
  if (event_id) {
    const { data: exact, error: exactErr } = await supabase
      .from("chats")
      .select("*")
      .eq("event_id", event_id)
      .eq("phone_number", phone_number)
      .maybeSingle();

    if (exactErr) throw exactErr;

    if (exact) {
      console.log("✅ ensureChat: exact match:", exact.chat_id);
      if (user_id && !exact.user_id) {
        const { data: p } = await supabase
          .from("chats")
          .update({ user_id, updated_at: new Date().toISOString() })
          .eq("chat_id", exact.chat_id)
          .select()
          .single();
        return p || exact;
      }
      return exact;
    }
  }

  // 2. Any existing chat for this phone → REUSE IT (one chat per contact)
  const { data: anyChat, error: anyErr } = await supabase
    .from("chats")
    .select("*")
    .eq("phone_number", phone_number)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (anyErr) throw anyErr;

  if (anyChat) {
    // Patch missing user_id or person_name — never change event_id
    const patch = {
      ...(user_id && !anyChat.user_id ? { user_id } : {}),
      ...(person_name && !anyChat.person_name ? { person_name } : {}),
    };

    if (Object.keys(patch).length) {
      console.log("🔄 ensureChat: patching existing chat:", anyChat.chat_id);
      const { data: patched, error: patchErr } = await supabase
        .from("chats")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("chat_id", anyChat.chat_id)
        .select()
        .single();
      if (patchErr) throw patchErr;
      return patched;
    }

    console.log("✅ ensureChat: reusing chat:", anyChat.chat_id);
    return anyChat;
  }

  // 3. First time we see this phone — create new chat
  console.log("➕ ensureChat: creating new chat for:", phone_number);
  const { data: inserted, error: insertErr } = await supabase
    .from("chats")
    .insert([
      {
        event_id,
        phone_number,
        person_name,
        user_id,
        last_message: "",
        last_message_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    ])
    .select();

  if (insertErr || !inserted?.[0])
    throw insertErr || new Error("Insert failed");
  return inserted[0];
}

// saveMessage, getChatsForEvent, getChatsForUser, getMessagesForChat unchanged
export async function saveMessage({
  chat_id,
  sender_type = "user",
  message,
  message_type = "text",
  media_path = null,
}) {
  if (!message || message.trim() === "")
    message = `[${(message_type || "TEXT").toUpperCase()}]`;

  const { data: inserted, error } = await supabase
    .from("messages")
    .insert([
      {
        chat_id,
        sender_type,
        message,
        message_type,
        media_path,
        created_at: new Date().toISOString(),
      },
    ])
    .select();
  if (error) throw error;

  await supabase
    .from("chats")
    .update({
      last_message: message,
      last_message_at: new Date().toISOString(),
    })
    .eq("chat_id", chat_id);

  return inserted[0];
}

export async function getChatsForEvent({ event_id, limit = 100, offset = 0 }) {
  const { data, error } = await supabase
    .from("chats")
    .select(
      "chat_id, event_id, phone_number, person_name, last_message, created_at, last_message_at, mode",
    )
    .eq("event_id", event_id)
    .order("last_message_at", { ascending: false, nulls: "last" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
}

export async function getChatsForUser({ user_id, limit = 100, offset = 0 }) {
  const { data, error } = await supabase
    .from("chats")
    .select(
      "chat_id, user_id, phone_number, person_name, last_message, last_message_at, created_at, mode",
    )
    .eq("user_id", user_id)
    .order("last_message_at", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
}

export async function getMessagesForChat({
  chat_id,
  limit = 50,
  before = null,
}) {
  let query = supabase
    .from("messages")
    .select(
      "message_id, chat_id, sender_type, message, message_type, media_path, created_at, buttons",
    )
    .eq("chat_id", chat_id)
    .order("created_at", { ascending: false }) // ← newest first now
    .limit(limit);

  if (before) {
    query = supabase
      .from("messages")
      .select(
        "message_id, chat_id, sender_type, message, message_type, media_path, created_at",
      )
      .eq("chat_id", chat_id)
      .lt("created_at", before)
      .order("created_at", { ascending: false }) // ← newest-before-cursor first
      .limit(limit);
  }

  const { data, error } = await query;
  if (error) throw error;

  // Reverse back to chronological (oldest→newest) for display order
  const messages = (data || []).reverse();

  for (let msg of messages) {
    if (!msg.media_path) continue;

    if (
      msg.media_path.startsWith("http://") ||
      msg.media_path.startsWith("https://")
    ) {
      continue;
    }

    try {
      const { data: signed, error: signErr } = await supabase.storage
        .from("participant-docs")
        .createSignedUrl(msg.media_path, 86400);
      if (signErr) {
        console.warn(
          "⚠️ Failed to sign media URL:",
          msg.message_id,
          signErr.message,
        );
      } else if (signed?.signedUrl) {
        msg.media_path = signed.signedUrl;
      }
    } catch (err) {
      console.error("❌ createSignedUrl threw:", msg.message_id, err.message);
    }
  }

  return messages;
}
