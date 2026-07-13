// controllers/retryAutomationController.js
import { supabase } from "../config/supabase.js";
import { getEligibleParticipantIds } from "../utils/retryAutomationTargeting.js";

// Mirrors the exact predicate getEventActivityStatus already uses for
// call_batch_active — "a batch has run, and it isn't still running".
async function isBatchIdle(eventId) {
  const { data: event, error } = await supabase
    .from("events")
    .select("batch_id, batch_status")
    .eq("event_id", eventId)
    .maybeSingle();

  if (error || !event) return false;
  if (!event.batch_id) return false; // no batch has ever been run
  return !["in_progress", "pending"].includes(event.batch_status);
}

// GET /api/events/:eventId/retry-automations/eligibility
export const getAutomationEligibility = async (req, res) => {
  try {
    const { eventId } = req.params;
    const idle = await isBatchIdle(eventId);
    res.json({ success: true, canSchedule: idle });
  } catch (err) {
    console.error("getAutomationEligibility error:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to check eligibility" });
  }
};

// GET /api/events/:eventId/retry-automations
export const listAutomations = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { data, error } = await supabase
      .from("retry_automations")
      .select("*")
      .eq("event_id", eventId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error("listAutomations error:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to load automations" });
  }
};

// GET /api/events/:eventId/retry-automations/:id/runs
export const listAutomationRuns = async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from("retry_automation_runs")
      .select("*")
      .eq("automation_id", id)
      .order("ran_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error("listAutomationRuns error:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to load run history" });
  }
};

// POST /api/events/:eventId/retry-automations
// body: { mode: 'call'|'whatsapp', schedule_type: 'once'|'recurring',
//         run_at?, interval_minutes?, end_at?, max_attempts_per_participant?,
//         template_id? (Samvaadik template_name — required if mode='whatsapp'),
//         template_language? (Samvaadik language_code, default 'en') }
export const createAutomation = async (req, res) => {
  try {
    const { eventId } = req.params;
    const {
      mode,
      schedule_type,
      run_at,
      interval_minutes,
      end_at,
      max_attempts_per_participant = 1,
      template_id, // holds the Samvaadik template_name, column kept generic
      template_language = "en",
      template_body = null,
    } = req.body;

    if (!["call", "whatsapp"].includes(mode)) {
      return res
        .status(400)
        .json({ success: false, error: "mode must be 'call' or 'whatsapp'" });
    }
    if (!["once", "recurring"].includes(schedule_type)) {
      return res
        .status(400)
        .json({
          success: false,
          error: "schedule_type must be 'once' or 'recurring'",
        });
    }
    if (mode === "whatsapp" && !template_id) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "template_id (Samvaadik template name) is required for whatsapp automations",
        });
    }

    const idle = await isBatchIdle(eventId);
    if (!idle) {
      return res.status(409).json({
        success: false,
        error:
          "Automations can only be scheduled after the initial call batch has finished.",
      });
    }

    const eligibleIds = await getEligibleParticipantIds(eventId, mode);
    if (eligibleIds.length === 0) {
      return res.status(409).json({
        success: false,
        error:
          mode === "whatsapp"
            ? "Everyone has either completed their call or already responded — no one needs a WhatsApp retry right now."
            : "Everyone has already responded — no one needs a call retry right now.",
      });
    }

    const next_run_at =
      schedule_type === "once"
        ? new Date(run_at).toISOString()
        : new Date(
            Date.now() + (Number(interval_minutes) || 60) * 60000,
          ).toISOString();

    const { data, error } = await supabase
      .from("retry_automations")
      .insert({
        event_id: eventId,
        mode,
        schedule_type,
        run_at: run_at || null,
        interval_minutes: interval_minutes || null,
        next_run_at,
        end_at: end_at || null,
        max_attempts_per_participant,
        template_id: template_id || null,
        template_language: mode === "whatsapp" ? template_language : null,
        template_body: mode === "whatsapp" ? template_body : null,
        created_by: req.user?.id || req.user?.user_id || null,
        status: "scheduled",
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    console.error("createAutomation error:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to create automation" });
  }
};

// PATCH /api/events/:eventId/retry-automations/:id
// body: { status: 'paused'|'active'|'cancelled' }
export const updateAutomationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!["paused", "active", "cancelled"].includes(status)) {
      return res.status(400).json({ success: false, error: "Invalid status" });
    }
    const { data, error } = await supabase
      .from("retry_automations")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error("updateAutomationStatus error:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to update automation" });
  }
};

// DELETE /api/events/:eventId/retry-automations/:id
export const deleteAutomation = async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from("retry_automations")
      .delete()
      .eq("id", id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("deleteAutomation error:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to delete automation" });
  }
};
