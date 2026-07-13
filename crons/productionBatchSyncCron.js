// crons/productionBatchSyncCron.js
// Runs every 30 seconds — syncs all pending/processing production batch calls
// and deducts credits once calls complete.

import cron from "node-cron";
import axios from "axios";
import { supabase } from "../config/supabase.js";
import { calculateVoiceCredits } from "../config/creditPricing.js";
import { getUserById, updateUserCredits } from "../models/userModel.js";
import { syncBatchStatusesForEvent } from "../controllers/eventController.js";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

/**
 * Sync a single production batch from ElevenLabs and deduct credits if completed.
 */
const syncProductionBatch = async (event) => {
  const { event_id, batch_id, user_id } = event;

  try {
    console.log(
      `[PROD-CRON] 🔍 Syncing batch ${batch_id} for event ${event_id}`,
    );

    // ── 1. Fetch batch from ElevenLabs ──────────────────────────────────────
    const batchRes = await axios.get(
      `https://api.elevenlabs.io/v1/convai/batch-calling/${batch_id}`,
      { headers: { "xi-api-key": ELEVENLABS_API_KEY } },
    );

    const batch = batchRes.data;
    if (!batch?.recipients?.length) {
      console.warn(`[PROD-CRON] ⚠️  No recipients for batch ${batch_id}`);
      return null;
    }

    console.log(
      `[PROD-CRON] 📊 Batch status: ${batch.status}, Recipients: ${batch.recipients.length}`,
    );

    // ── 2. Check if batch is complete ────────────────────────────────────────
    const allCompleted = batch.recipients.every(
      (r) =>
        r.status === "completed" ||
        r.status === "failed" ||
        r.status === "error",
    );

    if (!allCompleted) {
      console.log(`[PROD-CRON] ⏳ Batch ${batch_id} still in progress`);
      // Update status but don't deduct credits yet
      await supabase
        .from("events")
        .update({ batch_status: batch.status })
        .eq("event_id", event_id);
      return null;
    }

    // Refresh per-participant call_status / recipient_status now, while we
    // know for certain the batch just transitioned to completed. This is
    // the only reliable trigger point for one-time retry automations —
    // there's no "next run" afterward to catch it any other way.
    try {
      await syncBatchStatusesForEvent(event_id);
      console.log(
        `[PROD-CRON] ✅ Per-participant status synced for event ${event_id}`,
      );
    } catch (syncErr) {
      console.warn(
        `[PROD-CRON] ⚠️  Per-participant sync failed (non-fatal):`,
        syncErr.message,
      );
    }

    // ── 3. Fetch conversation durations for all recipients ────────────────────
    let totalDurationSeconds = 0;
    let successfulCalls = 0;

    for (const recipient of batch.recipients) {
      if (recipient.status === "completed" && recipient.conversation_id) {
        try {
          const convoRes = await axios.get(
            `https://api.elevenlabs.io/v1/convai/conversations/${recipient.conversation_id}`,
            { headers: { "xi-api-key": ELEVENLABS_API_KEY } },
          );

          const duration = convoRes.data.metadata?.call_duration_secs || 0;
          totalDurationSeconds += duration;
          successfulCalls++;

          console.log(
            `[PROD-CRON] 📞 Call ${recipient.conversation_id}: ${duration}s`,
          );
        } catch (err) {
          console.warn(
            `[PROD-CRON] ⚠️  Could not fetch conversation ${recipient.conversation_id}`,
          );
        }
      }
    }

    console.log(
      `[PROD-CRON] 📊 Total duration: ${totalDurationSeconds}s across ${successfulCalls} calls`,
    );

    if (totalDurationSeconds === 0) {
      console.log(
        `[PROD-CRON] ℹ️  No successful calls, skipping credit deduction`,
      );
      await supabase
        .from("events")
        .update({ batch_status: "completed" })
        .eq("event_id", event_id);
      return null;
    }

    // ── 4. Check if credits already deducted ───────────────────────────────────
    const { data: eventData } = await supabase
      .from("events")
      .select("credits_deducted")
      .eq("event_id", event_id)
      .single();

    if (eventData?.credits_deducted) {
      console.log(
        `[PROD-CRON] ℹ️  Credits already deducted for event ${event_id}, skipping`,
      );
      return null;
    }

    // ── 5. Deduct credits ───────────────────────────────────────────────────
    if (!user_id) {
      console.warn(
        `[PROD-CRON] ⚠️  No user_id for event ${event_id}, cannot deduct credits`,
      );
      return null;
    }

    const user = await getUserById(user_id);
    if (!user) {
      console.warn(`[PROD-CRON] ⚠️  User ${user_id} not found`);
      return null;
    }

    const creditsToDeduct = calculateVoiceCredits(totalDurationSeconds, false); // false = production
    const newCredits = Number((user.credits - creditsToDeduct).toFixed(2));

    if (user.credits < creditsToDeduct) {
      console.warn(
        `[PROD-CRON] ⚠️  User ${user_id} has insufficient credits. Deducting to 0.`,
      );
      await updateUserCredits(user_id, 0);
    } else {
      await updateUserCredits(user_id, newCredits);
    }

    // ── 6. Mark credits as deducted in event ────────────────────────────────
    await supabase
      .from("events")
      .update({
        batch_status: "completed",
        credits_deducted: creditsToDeduct,
        total_call_duration: totalDurationSeconds,
        successful_calls: successfulCalls,
      })
      .eq("event_id", event_id);

    console.log(
      `[PROD-CRON] ✅ Credits deducted for event ${event_id}: ` +
        `${user.credits} → ${Math.max(newCredits, 0)} (-${creditsToDeduct}) | ` +
        `duration: ${totalDurationSeconds}s across ${successfulCalls} calls`,
    );

    return creditsToDeduct;
  } catch (err) {
    console.error(
      `[PROD-CRON] ❌ Error syncing batch ${batch_id}:`,
      err.response?.data || err.message,
    );
    return null;
  }
};

/**
 * Main cron task — finds all pending production batch calls and syncs them.
 */
const runProductionBatchSync = async () => {
  console.log("[PROD-CRON] 🔄 Production batch sync started...");

  try {
    // Fetch all events with pending batches
    const { data: pendingEvents, error } = await supabase
      .from("events")
      .select("event_id, batch_id, user_id, batch_created_at, batch_status")
      .not("batch_id", "is", null)
      .in("batch_status", [
        "pending",
        "queued",
        "processing",
        "in_progress",
        "retrying",
        "completed",
      ])
      .is("credits_deducted", null); // Only events that haven't had credits deducted

    if (error) {
      console.error("[PROD-CRON] ❌ Failed to fetch pending events:", error);
      return;
    }

    if (!pendingEvents?.length) {
      console.log("[PROD-CRON] ✅ No pending production batches.");
      return;
    }

    console.log(
      `[PROD-CRON] 📋 Found ${pendingEvents.length} pending batch(es).`,
    );

    // ── Abandon batches older than 2 hours (use batch_created_at, not event created_at) ──
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const now = Date.now();

    const validEvents = [];
    for (const event of pendingEvents) {
      // Use batch_created_at if available, otherwise skip age check (batch just started)
      if (event.batch_created_at) {
        const age = now - new Date(event.batch_created_at).getTime();
        if (age > TWO_HOURS_MS) {
          console.warn(
            `[PROD-CRON] ⏰ Batch for event ${event.event_id} is >2h old — marking as failed.`,
          );
          await supabase
            .from("events")
            .update({ batch_status: "failed" })
            .eq("event_id", event.event_id);
          continue;
        }
      }
      validEvents.push(event);
    }

    // Process valid events concurrently (capped at 5 at a time)
    const CONCURRENCY = 5;
    for (let i = 0; i < validEvents.length; i += CONCURRENCY) {
      const chunk = validEvents.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map((e) => syncProductionBatch(e)));
    }

    console.log("[PROD-CRON] ✅ Production batch sync complete.");
  } catch (err) {
    console.error("[PROD-CRON] ❌ Unexpected cron error:", err.message);
  }
};

/**
 * Start the cron — call this once at server startup.
 * Schedule: every 30 seconds.
 */
export const startProductionBatchSyncCron = () => {
  console.log(
    "[PROD-CRON] 🚀 Production batch sync cron registered (every 30s)",
  );

  // Run immediately on startup
  runProductionBatchSync();

  // Then every 30 seconds
  cron.schedule("*/30 * * * * *", runProductionBatchSync);
};
