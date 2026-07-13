// utils/retryAutomationTargeting.js
import { supabase } from "../config/supabase.js";

// Base "who still needs outreach" — RSVP not collected, through any
// channel. Both call and whatsapp modes use this SAME check.
//
// Deliberately does NOT also filter on event_call_logs.recipient_status /
// conversation_results.call_status ("was the call completed"). That field
// only reflects call delivery/connection outcome, not whether the AI
// actually collected any answers before the participant hung up — a call
// can show recipient_status: "completed" with zero data collected. The
// only signal that reliably means "we have this participant's RSVP" is
// event_rsvp_responses actually having rows for them (smart_fields) / a
// real rsvp_status value (classic) — so that's the only check here.
export async function getEligibleParticipantIds(eventId, mode) {
  const { data: event } = await supabase
    .from("events")
    .select("field_mode")
    .eq("event_id", eventId)
    .maybeSingle();
  const fieldMode = event?.field_mode;

  const { data: participants } = await supabase
    .from("participants")
    .select("participant_id")
    .eq("event_id", eventId);
  const allIds = (participants || []).map((p) => p.participant_id);
  if (allIds.length === 0) return [];

  if (fieldMode === "smart_fields") {
    const { data: responses } = await supabase
      .from("event_rsvp_responses")
      .select("participant_id")
      .eq("event_id", eventId);
    const responded = new Set((responses || []).map((r) => r.participant_id));
    return allIds.filter((pid) => !responded.has(pid));
  }

  const { data: convos } = await supabase
    .from("conversation_results")
    .select("participant_id, rsvp_status")
    .eq("event_id", eventId);
  const statusById = {};
  (convos || []).forEach((c) => (statusById[c.participant_id] = c.rsvp_status));
  return allIds.filter((pid) => {
    const s = statusById[pid];
    return !s || s === "NULL" || s === "Pending";
  });
}
