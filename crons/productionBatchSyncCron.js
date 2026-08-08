// crons/productionBatchSyncCron.js
// Runs every 30 seconds — syncs all pending/processing production batch calls
// and deducts credits once calls complete.

import cron from "node-cron";
import axios from "axios";
import { supabase } from "../config/supabase.js";
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

    // ── 3. Mark this batch as processed ────────────────────────────────────
    // Real per-conversation billing already happened above, inside
    // syncBatchStatusesForEvent -> settleConversationCost. This cron's only
    // remaining job is detecting "batch fully done" and not re-processing
    // it forever. `credits_deducted` is kept as a boolean-style "done" flag
    // (not a real credit amount) purely so the pending-events query below
    // still excludes it correctly — the real numbers live in
    // conversation_cost, queryable per-conversation or summed by event_id.
    await supabase
      .from("events")
      .update({
        batch_status: "completed",
        credits_deducted: true,
      })
      .eq("event_id", event_id);

    console.log(
      `[PROD-CRON] ✅ Batch fully processed for event ${event_id} — billing already settled per-conversation above.`,
    );

    return null;
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
