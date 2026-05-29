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
    res.status(500).json({ success: false, error: "Failed to fetch smart fields" });
  }
};

/**
 * GET /api/events/:eventId/smart-rsvp-data
 * Returns field definitions (headers) + per-participant responses (rows) for the smart dashboard.
 */
export const getSmartRsvpData = async (req, res) => {
  try {
    const { eventId } = req.params;

    const [
      { data: smartFields, error: sfError },
      { data: participants, error: pError },
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
    ]);

    if (sfError) throw sfError;
    if (pError) throw pError;

    const { data: responses, error: rError } = await supabase
      .from("event_rsvp_responses")
      .select("*")
      .eq("event_id", eventId);

    if (rError) throw rError;

    // Group responses by participant_id → { field_key: response_value }
    const byParticipant = {};
    (responses || []).forEach((r) => {
      if (!byParticipant[r.participant_id]) byParticipant[r.participant_id] = {};
      byParticipant[r.participant_id][r.field_key] = r.response_value;
    });

    const data = (participants || []).map((p) => {
      const participantResponses = byParticipant[p.participant_id] || {};
      const row = {
        id: p.participant_id,
        fullName: p.full_name,
        phoneNumber: p.phone_number,
        timestamp: p.uploaded_at,
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
    res.status(500).json({ success: false, error: "Failed to fetch smart RSVP data" });
  }
};

/**
 * POST /api/events/rsvp-responses
 * Called by ElevenLabs tool after the AI collects all smart field answers.
 *
 * Body sent by ElevenLabs tool:
 * {
 *   event_id:       "uuid",
 *   participant_id: "uuid",
 *   response_data:  '{"rsvp_status":"yes","guest_count":2,"meal_preference":"Veg"}'
 *                   (JSON string — the AI builds this from all collected field values)
 * }
 */
export const saveRsvpResponses = async (req, res) => {
  try {
    const { event_id, participant_id, response_data } = req.body;

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
        typeof response_data === "string" ? JSON.parse(response_data) : response_data;
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

    const { data, error } = await supabase
      .from("event_rsvp_responses")
      .upsert(rows, { onConflict: "event_id,participant_id,field_key" })
      .select();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error("saveRsvpResponses error:", err);
    res.status(500).json({ success: false, error: "Failed to save RSVP responses" });
  }
};
