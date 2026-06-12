// utils/sessionManager.js
// Creates, looks up, and closes whatsapp_ai_sessions rows.

import { supabase } from "../config/supabase.js";
import { sendText } from "./samvaadikClient.js";

/**
 * Look up the active WhatsApp AI session for a phone number.
 * If the guest is in multiple events (rare), returns the most recently
 * active session — same logic as the architecture doc.
 */
export const lookupSessionByPhone = async (phoneNumber) => {
  const normalised = String(phoneNumber).replace(/^\+/, "");

  const { data, error } = await supabase
    .from("whatsapp_ai_sessions")
    .select("*")
    .eq("phone_number", normalised)
    .eq("status", "active")
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[sessionManager] lookupSessionByPhone error:", error);
    return null;
  }
  return data;
};

/**
 * Create a new WhatsApp AI session for a participant.
 * Uses upsert — safe to call multiple times.
 *
 * triggered_by: "manual" | "voice_fallback" | "batch"
 */
// FIX for utils/sessionManager.js — createSession function ONLY
// Replace the existing createSession with this one.
// All other functions stay unchanged.

export const createSession = async ({
  event_id,
  participant_id,
  phone_number,
  triggered_by = "manual",
}) => {
  const normalised = String(phone_number).replace(/^\+/, "");

  // ── Never reset a completed session ──────────────────────────────────────
  const { data: existing } = await supabase
    .from("whatsapp_ai_sessions")
    .select("session_id, status")
    .eq("event_id", event_id)
    .eq("participant_id", participant_id)
    .maybeSingle();

  if (existing?.status === "completed") {
    console.log(
      `[sessionManager] ✋ Session already completed for ${participant_id} — keeping`,
    );
    return existing;
  }

  const { data, error } = await supabase
    .from("whatsapp_ai_sessions")
    .upsert(
      {
        event_id,
        participant_id,
        phone_number: normalised,
        current_index: 0,
        collected_answers: {},
        conversation_history: [],
        status: "active",
        triggered_by,
        last_message_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
      { onConflict: "event_id,participant_id" },
    )
    .select()
    .single();

  if (error) {
    console.error("[sessionManager] createSession error:", error);
    return null;
  }
  console.log(
    `[sessionManager] ✅ Session created for participant ${participant_id}`,
  );
  return data;
};
/**
 * Advance the session to the next question.
 * Saves the collected answer and increments current_index.
 */
export const advanceSession = async (
  sessionId,
  { field_key, value, newIndex, updatedHistory },
) => {
  const { data: session } = await supabase
    .from("whatsapp_ai_sessions")
    .select("collected_answers")
    .eq("session_id", sessionId)
    .single();

  const updatedAnswers = {
    ...(session?.collected_answers || {}),
    [field_key]: value,
  };

  const { error } = await supabase
    .from("whatsapp_ai_sessions")
    .update({
      current_index: newIndex,
      collected_answers: updatedAnswers,
      conversation_history: updatedHistory,
      last_message_at: new Date().toISOString(),
    })
    .eq("session_id", sessionId);

  if (error) console.error("[sessionManager] advanceSession error:", error);
};

/**
 * Update conversation history only (no index change — for retry / KB answer turns).
 */
export const updateHistory = async (sessionId, updatedHistory) => {
  const { error } = await supabase
    .from("whatsapp_ai_sessions")
    .update({
      conversation_history: updatedHistory,
      last_message_at: new Date().toISOString(),
    })
    .eq("session_id", sessionId);

  if (error) console.error("[sessionManager] updateHistory error:", error);
};

/**
 * Close the session and write all collected answers to event_rsvp_responses.
 * Also updates conversation_results.call_status = 'completed'.
 */
// ── closeSession ──────────────────────────────────────────────────────────
// Signature unchanged: (sessionId, eventId, participantId, collectedAnswers)
// Now also writes to event_rsvp_responses + conversation_results
export const closeSession = async (
  sessionId,
  eventId,
  participantId,
  collectedAnswers,
) => {
  // ── 1. Mark session completed ─────────────────────────────────────────────
  const { error: sessionErr } = await supabase
    .from("whatsapp_ai_sessions")
    .update({
      status: "completed",
      collected_answers: collectedAnswers,
      completed_at: new Date().toISOString(),
    })
    .eq("session_id", sessionId);

  if (sessionErr) {
    console.error(
      "[sessionManager] closeSession update error:",
      sessionErr.message,
    );
    return false;
  }
  console.log(`[sessionManager] ✅ Session ${sessionId} marked completed`);

  const answers = safeParseAnswers(collectedAnswers);
  const entries = Object.entries(answers);
  if (!entries.length) return true;

  // ── 2. Save to event_rsvp_responses ──────────────────────────────────────
  try {
    // Look up field definitions so we can include field_id (nullable — ok if missing)
    const { data: smartFields } = await supabase
      .from("event_smart_fields")
      .select("field_id, field_key, field_label")
      .eq("event_id", eventId);

    const fieldMap = {};
    (smartFields || []).forEach((f) => {
      fieldMap[f.field_key] = f;
    });

    const rsvpRows = entries.map(([key, value]) => ({
      event_id: eventId,
      participant_id: participantId,
      field_id: fieldMap[key]?.field_id || null,
      field_key: key,
      field_label: fieldMap[key]?.field_label || key,
      response_value: String(value ?? ""),
      collected_via: "whatsapp_chat",
      collected_at: new Date().toISOString(),
    }));

    const { error: rsvpErr } = await supabase
      .from("event_rsvp_responses")
      .upsert(rsvpRows, { onConflict: "event_id,participant_id,field_key" });

    if (rsvpErr)
      console.error(
        "[sessionManager] event_rsvp_responses error:",
        rsvpErr.message,
      );
    else
      console.log(
        `[sessionManager] ✅ Saved ${rsvpRows.length} row(s) to event_rsvp_responses`,
      );
  } catch (err) {
    console.error(
      "[sessionManager] event_rsvp_responses (non-fatal):",
      err.message,
    );
  }

  // ── 3. Update conversation_results ───────────────────────────────────────
  // conversation_results schema:
  //   rsvp_status      TEXT  CHECK ('Yes','No','Maybe')  ← must match exactly
  //   number_of_guests INTEGER
  //   notes            TEXT
  //   call_status      TEXT  (no check constraint)
  //   collected_answers JSONB  (store everything here as backup)
  try {
    // Map attendance answer → rsvp_status with CHECK constraint values
    const attended = String(answers.attendance || "")
      .toLowerCase()
      .trim();
    const yesWords = [
      "yes",
      "yess",
      "yeah",
      "yep",
      "sure",
      "y",
      "will",
      "attending",
      "going",
      "coming",
    ];
    const noWords = [
      "no",
      "nope",
      "n",
      "cant",
      "can't",
      "unable",
      "wont",
      "won't",
      "not coming",
      "not attending",
    ];
    const maybeWords = [
      "maybe",
      "perhaps",
      "possibly",
      "might",
      "not sure",
      "unsure",
    ];

    const rsvpStatus = yesWords.some((w) => attended.includes(w))
      ? "Yes"
      : noWords.some((w) => attended.includes(w))
        ? "No"
        : maybeWords.some((w) => attended.includes(w))
          ? "Maybe"
          : null; // null = don't write (avoids check-constraint violation)

    const callStatus =
      rsvpStatus === "Yes"
        ? "rsvp_done"
        : rsvpStatus === "No"
          ? "not_attending"
          : "completed";

    // Map guest_count → integer
    const guestCount =
      parseInt(answers.guest_count || answers.number_of_guests || "0") || 0;

    // Map additional_notes / notes → notes column
    const notes = answers.additional_notes || answers.notes || null;

    const updateFields = {
      call_status: callStatus,
      last_updated: new Date().toISOString(),
      event_id: eventId,
      number_of_guests: guestCount,
      collected_answers: answers, // full JSON as backup
      ...(rsvpStatus ? { rsvp_status: rsvpStatus } : {}),
      ...(notes ? { notes } : {}),
    };

    // Select-then-insert/update (no unique constraint on participant_id to upsert on)
    const { data: existingRow } = await supabase
      .from("conversation_results")
      .select("result_id")
      .eq("participant_id", participantId)
      .maybeSingle();

    if (existingRow) {
      const { error: updErr } = await supabase
        .from("conversation_results")
        .update(updateFields)
        .eq("result_id", existingRow.result_id);
      if (updErr)
        console.error(
          "[sessionManager] conversation_results update error:",
          updErr.message,
        );
      else
        console.log(
          `[sessionManager] ✅ conversation_results updated for ${participantId} (${callStatus})`,
        );
    } else {
      const { error: insErr } = await supabase
        .from("conversation_results")
        .insert({ participant_id: participantId, ...updateFields });
      if (insErr)
        console.error(
          "[sessionManager] conversation_results insert error:",
          insErr.message,
        );
      else
        console.log(
          `[sessionManager] ✅ conversation_results created for ${participantId} (${callStatus})`,
        );
    }
  } catch (err) {
    console.error(
      "[sessionManager] conversation_results (non-fatal):",
      err.message,
    );
  }

  return true;
};

// ── Helper ────────────────────────────────────────────────────────────────
function safeParseAnswers(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
