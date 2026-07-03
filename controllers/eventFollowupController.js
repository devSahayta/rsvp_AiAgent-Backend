// controllers/eventFollowupController.js
import { supabase } from "../config/supabase.js";
import { getScheduledMessageStatus } from "../utils/samvaadikClient.js";

const ALLOWED_TRIGGERS = ["always", "answered", "unanswered"];

// Samvaadik's message status is more granular (scheduled/sent/delivered/read/failed)
// than event_followup_dispatches.status allows (CHECK: pending/scheduled/sent/failed/skipped).
// Map down to the persisted bucket — the raw value is still returned (not persisted)
// in the sync response so the dashboard can show the finer label right after a sync.
function mapProviderStatus(raw) {
  const v = String(raw || "").toLowerCase();
  if (["sent", "delivered", "read"].includes(v)) return "sent";
  if (v === "failed") return "failed";
  if (["scheduled", "pending"].includes(v)) return "scheduled";
  return null;
}

/**
 * POST /api/events/:eventId/followup-rule
 * Create or update the single follow-up rule for an event (one rule per event).
 * message_type is always "template" — WhatsApp requires an approved template
 * for a system-initiated send (see event_followup_rules.message_type CHECK).
 * media_id (for image/video/document header templates) is the media id
 * Samvaadik associates with that specific template — resolved client-side
 * via GET /api/samvaadik/templates/:wt_id before the rule is saved.
 */
export const upsertFollowupRule = async (req, res) => {
  try {
    const { eventId } = req.params;
    const {
      is_active = true,
      trigger_on,
      wt_id,
      variable_mapping = {},
      media_id = null,
      delay_minutes = 0,
    } = req.body;

    if (!wt_id) {
      return res.status(400).json({ error: "wt_id is required" });
    }
    if (!ALLOWED_TRIGGERS.includes(trigger_on)) {
      return res.status(400).json({
        error: `trigger_on must be one of: ${ALLOWED_TRIGGERS.join(", ")}`,
      });
    }

    const { data: event, error: eventErr } = await supabase
      .from("events")
      .select("event_id")
      .eq("event_id", eventId)
      .maybeSingle();

    if (eventErr) throw eventErr;
    if (!event) return res.status(404).json({ error: "Event not found" });

    const { data, error } = await supabase
      .from("event_followup_rules")
      .upsert(
        {
          event_id: eventId,
          is_active,
          trigger_on,
          message_type: "template",
          wt_id,
          variable_mapping,
          media_id,
          delay_minutes,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "event_id" },
      )
      .select()
      .single();

    if (error) throw error;

    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("upsertFollowupRule error:", err);
    return res.status(500).json({ error: "Failed to save follow-up rule" });
  }
};

/**
 * GET /api/events/:eventId/followup-rule
 * Returns the follow-up rule for an event, or null if none configured.
 */
export const getFollowupRule = async (req, res) => {
  try {
    const { eventId } = req.params;

    const { data, error } = await supabase
      .from("event_followup_rules")
      .select("*")
      .eq("event_id", eventId)
      .maybeSingle();

    if (error) throw error;

    return res.status(200).json({ success: true, data: data || null });
  } catch (err) {
    console.error("getFollowupRule error:", err);
    return res.status(500).json({ error: "Failed to fetch follow-up rule" });
  }
};

/**
 * GET /api/events/:eventId/followup-status
 * DB-only — returns the last-synced follow-up dispatch per participant for
 * an event. Fast; does not call Samvaadik. Use the /sync endpoint to refresh.
 */
export const getFollowupStatusForEvent = async (req, res) => {
  try {
    const { eventId } = req.params;

    const { data, error } = await supabase
      .from("event_followup_dispatches")
      .select(
        "id, participant_id, status, error_message, scheduled_at, sent_at, samvaadik_message_id",
      )
      .eq("event_id", eventId);

    if (error) throw error;

    return res.status(200).json({ success: true, data: data || [] });
  } catch (err) {
    console.error("getFollowupStatusForEvent error:", err);
    return res.status(500).json({ error: "Failed to fetch follow-up status" });
  }
};

/**
 * POST /api/events/:eventId/followup-status/sync
 * Live-checks Samvaadik for every dispatch that has a samvaadik_message_id
 * and isn't already terminal (failed/skipped), updates the persisted status,
 * and returns the fresh list — including the raw Samvaadik status
 * (provider_status) which is NOT persisted (see mapProviderStatus above).
 */
export const syncFollowupStatus = async (req, res) => {
  try {
    const { eventId } = req.params;

    const { data: event, error: eventErr } = await supabase
      .from("events")
      .select("event_id, user_id")
      .eq("event_id", eventId)
      .maybeSingle();

    if (eventErr) throw eventErr;
    if (!event) return res.status(404).json({ error: "Event not found" });

    const { data: dispatches, error: dispatchErr } = await supabase
      .from("event_followup_dispatches")
      .select(
        "id, participant_id, status, error_message, scheduled_at, sent_at, samvaadik_message_id",
      )
      .eq("event_id", eventId);

    if (dispatchErr) throw dispatchErr;

    const pending = (dispatches || []).filter(
      (d) => d.samvaadik_message_id && !["failed", "skipped"].includes(d.status),
    );

    if (pending.length === 0) {
      return res.status(200).json({ success: true, data: dispatches || [] });
    }

    const { data: conn } = await supabase
      .from("samvaadik_connections")
      .select("api_key, status")
      .eq("user_id", event.user_id)
      .maybeSingle();

    if (!conn || conn.status !== "active") {
      return res.status(200).json({ success: true, data: dispatches || [] });
    }

    const byId = {};
    (dispatches || []).forEach((d) => (byId[d.id] = { ...d }));

    for (const dispatch of pending) {
      try {
        const result = await getScheduledMessageStatus(
          conn.api_key,
          dispatch.samvaadik_message_id,
        );
        const raw = result?.data?.status;
        const mapped = mapProviderStatus(raw);

        const updates = {};
        if (mapped && mapped !== dispatch.status) updates.status = mapped;
        if (result?.data?.sent_at) updates.sent_at = result.data.sent_at;
        if (raw === "failed" && result?.data?.error_message) {
          updates.error_message = result.data.error_message;
        }

        if (Object.keys(updates).length > 0) {
          await supabase
            .from("event_followup_dispatches")
            .update(updates)
            .eq("id", dispatch.id);
        }

        byId[dispatch.id] = {
          ...byId[dispatch.id],
          ...updates,
          provider_status: raw || null,
        };
      } catch (err) {
        console.warn(
          `[syncFollowupStatus] status check failed for dispatch ${dispatch.id}:`,
          err.response?.data || err.message,
        );
      }
    }

    return res.status(200).json({ success: true, data: Object.values(byId) });
  } catch (err) {
    console.error("syncFollowupStatus error:", err);
    return res.status(500).json({ error: "Failed to sync follow-up status" });
  }
};
