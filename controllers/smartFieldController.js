import { supabase } from "../config/supabase.js";

/**
 * GET /api/events/:eventId/smart-fields
 * Returns the smart field definitions for an event (column headers for the dashboard).
 */
export const getEventSmartFields = async (req, res) => {
  try {
    const { eventId } = req.params;

    const { data, error } = await supabase
      .from("event_smart_fields")
      .select("*")
      .eq("event_id", eventId)
      .order("display_order", { ascending: true });

    if (error) throw error;

    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error("getEventSmartFields error:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch smart fields" });
  }
};

/**
 * GET /api/events/:eventId/smart-rsvp-data
 * Returns field definitions (headers) + per-participant responses + call log data.
 */
export const getSmartRsvpData = async (req, res) => {
  try {
    const { eventId } = req.params;

    const [
      { data: smartFields, error: sfError },
      { data: participants, error: pError },
      { data: responses, error: rError },
      { data: callLogs, error: clError },
    ] = await Promise.all([
      supabase
        .from("event_smart_fields")
        .select("*")
        .eq("event_id", eventId)
        .order("display_order", { ascending: true }),
      supabase
        .from("participants")
        .select("participant_id, full_name, phone_number, uploaded_at")
        .eq("event_id", eventId),
      supabase
        .from("event_rsvp_responses")
        .select("participant_id, field_key, response_value")
        .eq("event_id", eventId),
      supabase
        .from("event_call_logs")
        .select("participant_id, conversation_id, call_duration, call_outcome, called_at")
        .eq("event_id", eventId),
    ]);

    if (sfError) throw sfError;
    if (pError) throw pError;
    if (rError) throw rError;
    if (clError) throw clError;

    // Group responses by participant_id → { field_key: response_value }
    const byParticipant = {};
    (responses || []).forEach((r) => {
      if (!byParticipant[r.participant_id]) byParticipant[r.participant_id] = {};
      byParticipant[r.participant_id][r.field_key] = r.response_value;
    });

    // Map call logs by participant_id
    const callLogByParticipant = {};
    (callLogs || []).forEach((log) => {
      callLogByParticipant[log.participant_id] = log;
    });

    const data = (participants || []).map((p) => {
      const participantResponses = byParticipant[p.participant_id] || {};
      const callLog = callLogByParticipant[p.participant_id] || {};

      const row = {
        id: p.participant_id,
        fullName: p.full_name,
        phoneNumber: p.phone_number,
        timestamp: p.uploaded_at,
        conversation_id: callLog.conversation_id || null,
        call_duration: callLog.call_duration ?? null,
        call_outcome: callLog.call_outcome || null,
        called_at: callLog.called_at || null,
      };

      (smartFields || []).forEach((f) => {
        row[f.field_key] = participantResponses[f.field_key] ?? null;
      });

      return row;
    });

    res.json({
      success: true,
      fields: smartFields || [],
      data,
    });
  } catch (err) {
    console.error("getSmartRsvpData error:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch smart RSVP data" });
  }
};

/**
 * POST /api/events/rsvp-responses
 * Called by ElevenLabs tool after the AI collects all smart field answers.
 *
 * Body sent by ElevenLabs tool:
 * {
 *   event_id:        "uuid",
 *   participant_id:  "uuid",
 *   response_data:   '{"rsvp_status":"yes","guest_count":2}' (JSON string),
 *   conversation_id: "conv_xxx",   // optional
 *   call_duration:   22            // optional, seconds
 * }
 */
export const saveRsvpResponses = async (req, res) => {
  console.log("saveRsvpResponses called with body:", req.body);
  try {
    const {
      event_id,
      participant_id,
      response_data,
      conversation_id,
      call_duration,
    } = req.body;

    if (!event_id || !participant_id || !response_data) {
      return res.status(400).json({
        success: false,
        error: "event_id, participant_id and response_data are required",
      });
    }

    // Parse response_data — ElevenLabs sends it as a JSON string
    let parsedData;
    try {
      parsedData =
        typeof response_data === "string"
          ? JSON.parse(response_data)
          : response_data;
    } catch {
      return res.status(400).json({
        success: false,
        error: "response_data is not valid JSON",
      });
    }

    // Fetch smart field definitions to resolve field_id and field_label
    const { data: smartFields, error: sfError } = await supabase
      .from("event_smart_fields")
      .select("field_id, field_key, field_label")
      .eq("event_id", event_id);

    if (sfError) throw sfError;

    // Build a lookup map: field_key → { field_id, field_label }
    const fieldMap = {};
    (smartFields || []).forEach((f) => {
      fieldMap[f.field_key] = { field_id: f.field_id, field_label: f.field_label };
    });

    // Build one upsert row per key in response_data
    const rows = Object.entries(parsedData).map(([field_key, response_value]) => ({
      event_id,
      participant_id,
      field_id: fieldMap[field_key]?.field_id || null,
      field_key,
      field_label: fieldMap[field_key]?.field_label || null,
      response_value: String(response_value ?? ""),
      collected_via: "voice",
    }));

    if (rows.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // 1) Upsert RSVP responses
    const { data, error } = await supabase
      .from("event_rsvp_responses")
      .upsert(rows, { onConflict: "event_id,participant_id,field_key" })
      .select();

    if (error) throw error;

    // 2) Upsert call log — insert or update based on event_id + participant_id
    const { data: existingLog } = await supabase
      .from("event_call_logs")
      .select("call_log_id")
      .eq("event_id", event_id)
      .eq("participant_id", participant_id)
      .maybeSingle();

    if (existingLog) {
      await supabase
        .from("event_call_logs")
        .update({
          conversation_id: conversation_id || null,
          call_duration: call_duration ?? null,
          call_outcome: "completed",
          updated_at: new Date().toISOString(),
        })
        .eq("call_log_id", existingLog.call_log_id);
    } else {
      await supabase.from("event_call_logs").insert({
        event_id,
        participant_id,
        conversation_id: conversation_id || null,
        call_duration: call_duration ?? null,
        call_outcome: "completed",
      });
    }

    console.log("RSVP responses saved:", data);
    res.json({ success: true, data });
  } catch (err) {
    console.error("saveRsvpResponses error:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to save RSVP responses" });
  }
};
