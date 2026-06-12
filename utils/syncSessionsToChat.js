// utils/syncSessionsToChat.js
// ─────────────────────────────────────────────────────────────────────────────
// Syncs conversation data from whatsapp_ai_sessions → chats + messages tables.
//
// Use this to:
//   1. Backfill all existing completed/active sessions (run once)
//   2. Expose as an admin endpoint so you can re-run anytime
//
// POST /admin/sync-wa-sessions  →  triggers this function
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "../config/supabase.js";
import { ensureChat, saveMessage } from "../controllers/chatController.js";

/**
 * Sync all whatsapp_ai_sessions that have conversation_history into
 * the chats + messages tables so the chat dashboard can display them.
 *
 * @param {object} opts
 * @param {string|null} opts.sessionId   - sync a single session (optional)
 * @param {boolean}     opts.dryRun      - log what would happen, don't write
 * @returns {{ synced: number, skipped: number, errors: string[] }}
 */
export async function syncSessionsToChat({
  sessionId = null,
  dryRun = false,
} = {}) {
  const results = { synced: 0, skipped: 0, errors: [] };

  // ── 1. Fetch sessions ────────────────────────────────────────────────────
  let query = supabase
    .from("whatsapp_ai_sessions")
    .select("*")
    .not("conversation_history", "eq", "[]") // skip empty sessions
    .order("created_at", { ascending: true });

  if (sessionId) {
    query = query.eq("session_id", sessionId);
  }

  const { data: sessions, error: sessErr } = await query;

  if (sessErr) {
    console.error("[syncSessionsToChat] Failed to load sessions:", sessErr);
    results.errors.push(`Load sessions: ${sessErr.message}`);
    return results;
  }

  if (!sessions?.length) {
    console.log("[syncSessionsToChat] No sessions to sync.");
    return results;
  }

  console.log(`[syncSessionsToChat] Processing ${sessions.length} session(s)…`);

  for (const session of sessions) {
    try {
      await syncOneSession(session, dryRun, results);
    } catch (err) {
      const msg = `session ${session.session_id}: ${err.message}`;
      console.error("[syncSessionsToChat] ❌", msg);
      results.errors.push(msg);
    }
  }

  console.log(
    `[syncSessionsToChat] Done. synced=${results.synced} skipped=${results.skipped} errors=${results.errors.length}`,
  );

  return results;
}

/**
 * Sync a single session.
 */
async function syncOneSession(session, dryRun, results) {
  const history = parseHistory(session.conversation_history);

  if (!history.length) {
    results.skipped++;
    return;
  }

  // ── Get the organiser's user_id from the event ───────────────────────────
  const { data: eventRow } = await supabase
    .from("events")
    .select("user_id, event_name")
    .eq("event_id", session.event_id)
    .maybeSingle();

  const userId = eventRow?.user_id || null;
  const personName = await resolvePersonName(session);

  if (dryRun) {
    console.log(`[DRY RUN] Would sync session ${session.session_id}:`, {
      phone: session.phone_number,
      event: session.event_id,
      user_id: userId,
      messages: history.length,
    });
    results.synced++;
    return;
  }

  // ── Ensure chat row exists ────────────────────────────────────────────────
  const chat = await ensureChat({
    event_id: session.event_id,
    phone_number: session.phone_number,
    person_name: personName,
    user_id: userId,
  });

  // ── Check if messages already exist for this chat ────────────────────────
  const { data: existingMsgs } = await supabase
    .from("messages")
    .select("message_id")
    .eq("chat_id", chat.chat_id)
    .limit(1);

  if (existingMsgs?.length) {
    console.log(
      `[syncSessionsToChat] ⏭  Chat ${chat.chat_id} already has messages — skipping session ${session.session_id}`,
    );
    results.skipped++;
    return;
  }

  // ── Write each message ────────────────────────────────────────────────────
  // Spread timestamps evenly between session start and last message
  const startTs = new Date(session.created_at).getTime();
  const endTs = session.last_message_at
    ? new Date(session.last_message_at).getTime()
    : startTs + history.length * 30000; // 30s apart if no end time

  const interval =
    history.length > 1 ? (endTs - startTs) / (history.length - 1) : 0;

  for (let i = 0; i < history.length; i++) {
    const turn = history[i];
    const senderType = turn.role === "user" ? "user" : "ai";
    const msgText = String(turn.content || "").trim();

    if (!msgText) continue;

    const msgTs = new Date(startTs + i * interval).toISOString();

    // Insert message directly with the calculated timestamp
    const { error: msgErr } = await supabase.from("messages").insert({
      chat_id: chat.chat_id,
      sender_type: senderType,
      message: msgText,
      message_type: "text",
      media_path: null,
      created_at: msgTs,
    });

    if (msgErr) {
      throw new Error(`saveMessage failed: ${msgErr.message}`);
    }
  }

  // ── Update chat preview with last message ─────────────────────────────────
  const lastMsg = history[history.length - 1];
  if (lastMsg) {
    await supabase
      .from("chats")
      .update({
        last_message: String(lastMsg.content || "").slice(0, 200),
        last_message_at: new Date(endTs).toISOString(),
      })
      .eq("chat_id", chat.chat_id);
  }

  console.log(
    `[syncSessionsToChat] ✅ Synced session ${session.session_id} → chat ${chat.chat_id} (${history.length} messages)`,
  );

  results.synced++;
}

/**
 * Safely parse conversation_history which may be a JSON string or already an array.
 */
function parseHistory(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Try to resolve the participant's display name from the participants table.
 */
async function resolvePersonName(session) {
  if (!session.participant_id) return null;
  const { data } = await supabase
    .from("participants")
    .select("person_name, full_name, name")
    .eq("participant_id", session.participant_id)
    .maybeSingle();

  return (
    data?.person_name?.trim() ||
    data?.full_name?.trim() ||
    data?.name?.trim() ||
    null
  );
}
