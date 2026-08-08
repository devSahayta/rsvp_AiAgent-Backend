// crons/voiceTestSyncCron.js
// Runs every 30 seconds — syncs all pending/queued/processing voice test sessions
// and deducts credits once calls complete. Fully backend-driven, no frontend required.

import cron from "node-cron";
import axios from "axios";
import { supabase } from "../config/supabase.js";
import {
  logVoiceUsage,
  settleConversationCost,
} from "../models/creditLedgerModel.js";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

/**
 * Sync a single batch from ElevenLabs and deduct credits if completed.
 * Returns the final mapped status.
 */
const syncBatch = async (session) => {
  const { batch_id, test_session_id, user_id } = session;

  try {
    // ── 1. Fetch batch from ElevenLabs ──────────────────────────────────────
    const batchRes = await axios.get(
      `https://api.elevenlabs.io/v1/convai/batch-calling/${batch_id}`,
      { headers: { "xi-api-key": ELEVENLABS_API_KEY } },
    );

    const batch = batchRes.data;
    if (!batch?.recipients?.length) {
      console.warn(`[CRON] ⚠️  No recipients for batch ${batch_id}`);
      return null;
    }

    const recipient = batch.recipients[0];

    // ── 2. Map status ────────────────────────────────────────────────────────
    let mappedStatus = "processing";
    if (recipient.status === "completed") mappedStatus = "completed";
    else if (recipient.status === "failed" || recipient.status === "error")
      mappedStatus = "failed";
    else if (recipient.status === "pending" || recipient.status === "scheduled")
      mappedStatus = "queued";

    // ── 3. Fetch transcript + FULL metadata (needed for real cost settlement) ─
    let transcript = null;
    let duration = null;
    let conversationMetadata = null;

    if (recipient.conversation_id) {
      try {
        const convoRes = await axios.get(
          `https://api.elevenlabs.io/v1/convai/conversations/${recipient.conversation_id}`,
          { headers: { "xi-api-key": ELEVENLABS_API_KEY } },
        );
        transcript = convoRes.data.transcript || null;
        conversationMetadata = convoRes.data.metadata || null;
        duration = conversationMetadata?.call_duration_secs || null;
      } catch {
        console.warn(
          `[CRON] ⚠️  Could not fetch conversation for batch ${batch_id}`,
        );
      }
    }

    // ── 4. Update test session ───────────────────────────────────────────────
    const { data: updated, error: updateError } = await supabase
      .from("agent_test_sessions")
      .update({
        test_status: mappedStatus,
        conversation_id: recipient.conversation_id || null,
        duration_seconds: duration,
        test_transcript: transcript,
        completed_at: mappedStatus === "completed" ? new Date() : null,
        updated_at: new Date(),
      })
      .eq("test_session_id", test_session_id)
      .select()
      .single();

    if (updateError) {
      console.error(
        `[CRON] ❌ Failed to update session ${test_session_id}:`,
        updateError,
      );
      return null;
    }

    // ── 5. Settle real cost (@ 50% test markup) if completed and connected ───
    if (
      mappedStatus === "completed" &&
      duration > 0 &&
      user_id &&
      conversationMetadata
    ) {
      try {
        const voiceCostUsd = await logVoiceUsage({
          userId: user_id,
          eventId: null,
          conversationId: recipient.conversation_id, // shared idempotency key with syncVoiceTestStatus
          metadata: conversationMetadata,
        });

        const settlement = await settleConversationCost({
          userId: user_id,
          conversationId: recipient.conversation_id,
          eventId: null,
          conversationType: "voice",
          feature: "test_voice_agent",
          isTest: true, // 50% of production markup, per lead
          chatbotCostUsd: 0,
          voiceCostUsd,
          telephonyCostUsd: 0,
        });

        if (settlement?.alreadySettled) {
          console.log(
            `[CRON] ℹ️  Session ${test_session_id} (conv=${recipient.conversation_id}) already settled — skipping.`,
          );
        } else if (settlement) {
          // Mirror the result into the session row too, purely for display —
          // settleConversationCost/conversation_cost is the actual source of truth.
          await supabase
            .from("agent_test_sessions")
            .update({
              test_data_collected: {
                ...(updated.test_data_collected || {}),
                credits_deducted: settlement.credits,
                new_balance: settlement.newBalance,
                deducted_by: "cron",
                deducted_at: new Date().toISOString(),
              },
            })
            .eq("test_session_id", test_session_id);

          console.log(
            `[CRON] ✅ Test voice settled for session ${test_session_id}: ` +
              `-${settlement.credits} credits | balance: ${settlement.newBalance} | duration: ${duration}s`,
          );
        }
      } catch (creditError) {
        console.error(
          `[CRON] ❌ Error settling test voice cost for session ${test_session_id}:`,
          creditError.message,
        );
      }
    }

    return mappedStatus;
  } catch (err) {
    console.error(
      `[CRON] ❌ Error syncing batch ${batch_id}:`,
      err.response?.data || err.message,
    );
    return null;
  }
};

/**
 * Main cron task — finds all unsettled voice sessions and syncs them.
 */
const runVoiceTestSync = async () => {
  console.log("[CRON] 🔄 Voice test sync started...");

  try {
    // Fetch all sessions that are still pending
    const { data: pendingSessions, error } = await supabase
      .from("agent_test_sessions")
      .select("test_session_id, batch_id, user_id, created_at")
      .eq("test_type", "voice")
      .in("test_status", ["queued", "processing"])
      .not("batch_id", "is", null);

    if (error) {
      console.error("[CRON] ❌ Failed to fetch pending sessions:", error);
      return;
    }

    if (!pendingSessions?.length) {
      console.log("[CRON] ✅ No pending voice sessions.");
      return;
    }

    console.log(
      `[CRON] 📋 Found ${pendingSessions.length} pending session(s).`,
    );

    // ── Abandon sessions older than 2 hours (ElevenLabs won't update them) ──
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const now = Date.now();

    const validSessions = [];
    for (const session of pendingSessions) {
      const age = now - new Date(session.created_at).getTime();
      if (age > TWO_HOURS_MS) {
        console.warn(
          `[CRON] ⏰ Session ${session.test_session_id} is >2h old — marking as failed.`,
        );
        await supabase
          .from("agent_test_sessions")
          .update({ test_status: "failed", updated_at: new Date() })
          .eq("test_session_id", session.test_session_id);
      } else {
        validSessions.push(session);
      }
    }

    // Process valid sessions concurrently (capped at 5 at a time to avoid rate limits)
    const CONCURRENCY = 5;
    for (let i = 0; i < validSessions.length; i += CONCURRENCY) {
      const chunk = validSessions.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map((s) => syncBatch(s)));
    }

    console.log("[CRON] ✅ Voice test sync complete.");
  } catch (err) {
    console.error("[CRON] ❌ Unexpected cron error:", err.message);
  }
};

/**
 * Start the cron — call this once at server startup.
 * Schedule: every 30 seconds.
 */
export const startVoiceTestSyncCron = () => {
  console.log("[CRON] 🚀 Voice test sync cron registered (every 30s)");

  // Run immediately on startup to catch any sessions missed during downtime
  runVoiceTestSync();

  // Then every 30 seconds
  cron.schedule("*/30 * * * * *", runVoiceTestSync);
};
