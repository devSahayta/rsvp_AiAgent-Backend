// utils/followupDispatcher.js
// Schedules the per-event follow-up WhatsApp template message (event_followup_rules)
// after a participant's call ends, and records the attempt in event_followup_dispatches.
// Called from smartFieldController.saveRsvpResponses (answered) and
// eventController.syncBatchStatuses (unanswered). Must never throw — both call
// sites are inside handlers that need to return a response regardless of
// whether the follow-up send succeeded.

import { supabase } from "../config/supabase.js";
import { scheduleTemplateMessage } from "./samvaadikClient.js";

function normalizePhone(phone) {
  let p = String(phone || "").replace(/\D/g, "");
  if (p && !p.startsWith("91")) p = "91" + p;
  return p;
}

/**
 * Resolve a variable_mapping like {"1":"participant.full_name","2":"event.event_name","3":"static:Hi"}
 * into a positional object {"1":"Raj","2":"Summer Wedding","3":"Hi"}.
 */
function resolveVariables(variableMapping, { participant, event }) {
  const resolved = {};
  for (const [position, source] of Object.entries(variableMapping || {})) {
    if (typeof source !== "string") continue;
    if (source.startsWith("static:")) {
      resolved[position] = source.slice("static:".length);
    } else if (source === "participant.full_name") {
      resolved[position] = participant?.full_name || "";
    } else if (source === "event.event_name") {
      resolved[position] = event?.event_name || "";
    } else {
      resolved[position] = "";
    }
  }
  return resolved;
}

function triggerMatches(triggerOn, answered) {
  if (triggerOn === "always") return true;
  if (triggerOn === "answered") return answered === true;
  if (triggerOn === "unanswered") return answered === false;
  return false;
}

/**
 * @param {object} params
 * @param {string} params.eventId
 * @param {string} params.participantId
 * @param {string} params.callLogId
 * @param {boolean} params.answered
 */
export const dispatchEventFollowup = async ({
  eventId,
  participantId,
  callLogId,
  answered,
}) => {
  try {
    if (!eventId || !participantId || !callLogId) return;

    console.log(
      `[followupDispatcher] dispatchEventFollowup: eventId=${eventId}, participantId=${participantId}, callLogId=${callLogId}, answered=${answered}`,
    );

    const { data: rule } = await supabase
      .from("event_followup_rules")
      .select("*")
      .eq("event_id", eventId)
      .eq("is_active", true)
      .maybeSingle();

    if (!rule || !triggerMatches(rule.trigger_on, answered)) return;

    // Idempotency — event_followup_dispatches.call_log_id is UNIQUE.
    const { data: existing } = await supabase
      .from("event_followup_dispatches")
      .select("id")
      .eq("call_log_id", callLogId)
      .maybeSingle();

    if (existing) return;

    const [{ data: participant }, { data: event }] = await Promise.all([
      supabase
        .from("participants")
        .select("participant_id, full_name, phone_number")
        .eq("participant_id", participantId)
        .maybeSingle(),
      supabase
        .from("events")
        .select("event_id, event_name, user_id")
        .eq("event_id", eventId)
        .maybeSingle(),
    ]);

    if (!participant?.phone_number || !event) return;

    const resolvedVariables = resolveVariables(rule.variable_mapping, {
      participant,
      event,
    });
    const scheduledAt = new Date(
      Date.now() + (rule.delay_minutes || 0) * 60000,
    ).toISOString();

    const { data: dispatch, error: dispatchErr } = await supabase
      .from("event_followup_dispatches")
      .insert({
        event_id: eventId,
        participant_id: participantId,
        call_log_id: callLogId,
        rule_id: rule.id,
        status: "pending",
        resolved_variables: resolvedVariables,
        media_id: rule.media_id || null,
        scheduled_at: scheduledAt,
      })
      .select()
      .single();

    if (dispatchErr) throw dispatchErr;

    console.log(
      `[followupDispatcher] dispatchEventFollowup: scheduling follow-up for participant ${participantId} at ${scheduledAt}`,
    );

    console.log({ dispatch, resolvedVariables, scheduledAt });

    const { data: conn } = await supabase
      .from("samvaadik_connections")
      .select("api_key, status")
      .eq("user_id", event.user_id)
      .maybeSingle();

    if (!conn || conn.status !== "active") {
      await supabase
        .from("event_followup_dispatches")
        .update({
          status: "skipped",
          error_message: "No active Samvaadik connection for event owner",
        })
        .eq("id", dispatch.id);
      return;
    }

    try {
      const result = await scheduleTemplateMessage(conn.api_key, {
        phone: normalizePhone(participant.phone_number),
        contact_name: participant.full_name,
        wt_id: rule.wt_id,
        scheduled_at: scheduledAt,
        template_variables: resolvedVariables,
        media_id: rule.media_id || undefined,
      });

      console.log({ result });

      await supabase
        .from("event_followup_dispatches")
        .update({
          status: "scheduled",
          samvaadik_message_id: result?.data?.sm_id || result?.id || null,
        })
        .eq("id", dispatch.id);
    } catch (sendErr) {
      await supabase
        .from("event_followup_dispatches")
        .update({
          status: "failed",
          error_message:
            sendErr.response?.data?.error || sendErr.message || "Send failed",
        })
        .eq("id", dispatch.id);
    }
  } catch (err) {
    console.error(
      "[followupDispatcher] dispatchEventFollowup error:",
      err.message,
    );
  }
};
