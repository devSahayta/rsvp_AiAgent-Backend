// controllers/internalAutomationController.js
//
// Called by the scheduler via POST /internal/automations/:id/run. The
// scheduler's only job is deciding WHEN; all target-computation and
// execution logic lives here, right next to your existing retry logic.
import { supabase } from "../config/supabase.js";
import {
  retryCallsForParticipants,
  syncBatchStatusesForEvent,
} from "./eventController.js";
import { sendSamvaadikTemplateToParticipants } from "./whatsappController.js";
import { getEligibleParticipantIds } from "../utils/retryAutomationTargeting.js";

export const runAutomationById = async (req, res) => {
  const { id } = req.params;
  try {
    const { data: automation, error } = await supabase
      .from("retry_automations")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) throw error;
    if (!automation || !["scheduled", "active"].includes(automation.status)) {
      return res.json({ success: true, skipped: true });
    }

    // Refresh call status before deciding who still needs outreach — the
    // scheduler runs with no dashboard open, so nothing else would ever
    // trigger this otherwise, and a stale "pending" from a prior retry
    // shouldn't block an accurate targeting decision.
    try {
      await syncBatchStatusesForEvent(automation.event_id);
    } catch (syncErr) {
      console.warn(
        `[automation ${id}] pre-run sync failed (non-fatal):`,
        syncErr.message,
      );
    }

    const targetIds = await computeTargets(automation);
    const result = { targeted: targetIds.length, succeeded: 0, failed: 0 };
    let runStatus = "skipped";

    if (targetIds.length > 0) {
      try {
        if (automation.mode === "call") {
          await retryCallsForParticipants(automation.event_id, targetIds);
        } else {
          await sendSamvaadikTemplateToParticipants(
            automation.event_id,
            targetIds,
            automation.template_id, // stores template_name — see note in createAutomation
            automation.template_language || "en",
          );
        }
        result.succeeded = targetIds.length;
        runStatus = "success";
        await bumpAttempts(automation.id, targetIds);
      } catch (execErr) {
        console.error(`[automation ${id}] execution failed:`, execErr);
        result.failed = targetIds.length;
        runStatus = "failed";
      }
    }

    await supabase.from("retry_automation_runs").insert({
      automation_id: automation.id,
      participants_targeted: result.targeted,
      participants_succeeded: result.succeeded,
      participants_failed: result.failed,
      status: runStatus,
    });

    await scheduleNext(automation, result);

    res.json({ success: true, ...result });
  } catch (err) {
    console.error(`runAutomationById(${id}) error:`, err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// Who's eligible right now: everyone the shared targeting util says still
// needs outreach for this mode, minus anyone who's already hit the
// per-automation attempt cap.
async function computeTargets(automation) {
  const baseTargets = await getEligibleParticipantIds(
    automation.event_id,
    automation.mode,
  );
  if (baseTargets.length === 0) return [];

  const { data: attempted } = await supabase
    .from("retry_automation_attempts")
    .select("participant_id, attempts")
    .eq("automation_id", automation.id);

  const attemptsById = {};
  (attempted || []).forEach(
    (a) => (attemptsById[a.participant_id] = a.attempts),
  );

  return baseTargets.filter(
    (pid) => (attemptsById[pid] || 0) < automation.max_attempts_per_participant,
  );
}

async function bumpAttempts(automationId, participantIds) {
  for (const pid of participantIds) {
    const { data: existing } = await supabase
      .from("retry_automation_attempts")
      .select("attempts")
      .eq("automation_id", automationId)
      .eq("participant_id", pid)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("retry_automation_attempts")
        .update({
          attempts: existing.attempts + 1,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("automation_id", automationId)
        .eq("participant_id", pid);
    } else {
      await supabase.from("retry_automation_attempts").insert({
        automation_id: automationId,
        participant_id: pid,
        attempts: 1,
        last_attempt_at: new Date().toISOString(),
      });
    }
  }
}

async function scheduleNext(automation, result) {
  const done = automation.schedule_type === "once" || result.targeted === 0;
  if (done) {
    await supabase
      .from("retry_automations")
      .update({ status: "completed", updated_at: new Date().toISOString() })
      .eq("id", automation.id);
    return;
  }
  const next = new Date(
    Date.now() + (automation.interval_minutes || 60) * 60000,
  ).toISOString();
  await supabase
    .from("retry_automations")
    .update({
      status: "active",
      next_run_at: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", automation.id);
}
