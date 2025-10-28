import { updateUserCredits, getUserById } from "../models/userModel.js";
import { 
  getConversationByParticipant, 
  getCompletedCallsByEvent,
  updateConversationWithAPIData,
  getParticipantsByEvent 
} from "../models/conversationModel.js";

import { elevenlabsApi } from "../utils/elevenlabsApi.js";

// ✅ Utility to round credits to 2 decimal places (both for display & DB)
const formatCredits = (value) => Number(parseFloat(value || 0).toFixed(2));

/**
 * 🔹 Reduce credits using ElevenLabs batch API data
 */
export const reduceCreditsUsingElevenLabsAPI = async (req, res) => {
  try {
    console.log("📦 Credit reduction using ElevenLabs API");
    const { user_id, batch_id } = req.body;

    if (!user_id || !batch_id) {
      return res.status(400).json({ error: "user_id and batch_id are required" });
    }

    console.log("🔍 Step 1: Fetching batch info from ElevenLabs...");
    const batchInfo = await elevenlabsApi.getBatchCallInfo(batch_id);

    console.log(`📊 Batch Status: ${batchInfo.status}`);
    console.log(`📊 Total Recipients: ${batchInfo.recipients.length}`);

    if (batchInfo.status !== "completed") {
      return res.status(400).json({
        error: "Batch not completed yet",
        current_status: batchInfo.status,
        message: "Please wait for all calls to complete",
      });
    }

    console.log("🔍 Step 2: Fetching all conversations...");
    const allConversations = await elevenlabsApi.listConversations();

    const conversationMap = {};
    allConversations.forEach((conv) => {
      conversationMap[conv.conversation_id] = conv;
    });

    const validRecipients = batchInfo.recipients.filter((r) => r.conversation_id);
    console.log(`✅ Found ${validRecipients.length} recipients with a conversation_id`);

    if (validRecipients.length === 0) {
      return res.status(404).json({ error: "No completed calls found in this batch" });
    }

    let totalCreditsToDeduct = 0;
    const breakdown = [];

    for (const recipient of validRecipients) {
      const conversationId = recipient.conversation_id;
      const conversation = conversationMap[conversationId];

      if (!conversation) {
        console.warn(`⚠️ Conversation ${conversationId} not found in list`);
        continue;
      }

      const durationSecs = conversation.call_duration_secs || 0;
      const minutes = durationSecs / 60;
      const credits = minutes * 1;

      if (durationSecs > 0) {
        totalCreditsToDeduct += credits;
      }

      const status =
        conversation.status ||
        recipient.status ||
        (durationSecs === 0 ? "initiated" : "completed");

      breakdown.push({
        conversation_id: conversationId,
        phone_number: recipient.phone_number,
        duration_seconds: durationSecs,
        duration_minutes: formatCredits(minutes),
        credits_used: formatCredits(credits),
        status,
      });

      try {
        await updateConversationWithAPIData(
          conversationId,
          recipient.phone_number,
          durationSecs,
          status
        );
      } catch (error) {
        console.error(`❌ Error updating conversation ${conversationId}:`, error);
      }
    }

    console.log(`💰 Total credits to deduct (raw): ${totalCreditsToDeduct}`);
    totalCreditsToDeduct = formatCredits(totalCreditsToDeduct); // ✅ Round it here

    if (totalCreditsToDeduct === 0) {
      return res.status(400).json({ error: "No valid call durations found" });
    }

    const user = await getUserById(user_id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.credits < totalCreditsToDeduct) {
      return res.status(400).json({
        error: "Insufficient credits",
        required: formatCredits(totalCreditsToDeduct),
        available: formatCredits(user.credits),
        shortfall: formatCredits(totalCreditsToDeduct - user.credits),
      });
    }

    // ✅ Round both before DB update
    const newCredits = formatCredits(user.credits - totalCreditsToDeduct);
    const prevCredits = formatCredits(user.credits);

    await updateUserCredits(user_id, newCredits);

    console.log(`✅ Credits updated: ${prevCredits} → ${newCredits}`);

    return res.status(200).json({
      message: "Credits reduced successfully using ElevenLabs API",
      batch_id,
      batch_status: batchInfo.status,
      total_calls: validRecipients.length,
      total_deducted: formatCredits(totalCreditsToDeduct),
      previous_balance: prevCredits,
      new_balance: newCredits,
      breakdown,
    });
  } catch (error) {
    console.error("❌ Error in credit reduction:", error);
    return res.status(500).json({
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

/**
 * 🔹 Reduce credits for all completed calls in a batch/event
 */
export const reduceCreditsForBatch = async (req, res) => {
  try {
    console.log("📦 Batch credit reduction - Received body:", req.body);
    const { user_id, event_id } = req.body;

    if (!user_id || !event_id) {
      return res.status(400).json({ error: "user_id and event_id are required" });
    }

    const completedCalls = await getCompletedCallsByEvent(event_id);
    console.log("📊 Found calls:", completedCalls.length);

    if (completedCalls.length === 0) {
      return res.status(404).json({ error: "No completed calls found for this event" });
    }

    let totalCreditsToDeduct = 0;
    const callBreakdown = [];

    for (const call of completedCalls) {
      if (call.call_duration && call.call_duration > 0) {
        const minutes = call.call_duration / 60;
        const credits = minutes * 1;
        totalCreditsToDeduct += credits;

        callBreakdown.push({
          participant_id: call.participant_id,
          duration_seconds: call.call_duration,
          duration_minutes: formatCredits(minutes),
          credits_used: formatCredits(credits),
        });
      }
    }

    totalCreditsToDeduct = formatCredits(totalCreditsToDeduct);
    const user = await getUserById(user_id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.credits < totalCreditsToDeduct) {
      return res.status(400).json({
        error: "Insufficient credits for batch",
        required: formatCredits(totalCreditsToDeduct),
        available: formatCredits(user.credits),
        shortfall: formatCredits(totalCreditsToDeduct - user.credits),
      });
    }

    const newCredits = formatCredits(user.credits - totalCreditsToDeduct);
    const prevCredits = formatCredits(user.credits);

    await updateUserCredits(user_id, newCredits);

    console.log(`✅ Credits updated: ${prevCredits} → ${newCredits}`);

    return res.status(200).json({
      message: "Batch credits reduced successfully",
      total_calls: completedCalls.length,
      total_deducted: totalCreditsToDeduct,
      previous_balance: prevCredits,
      new_balance: newCredits,
      breakdown: callBreakdown,
    });
  } catch (error) {
    console.error("❌ Error reducing batch credits:", error);
    return res.status(500).json({ error: error.message });
  }
};

/**
 * 🔹 Reduce credits after a single completed call
 */
export const reduceCreditsAfterCall = async (req, res) => {
  try {
    console.log("📩 Single call credit reduction - Received body:", req.body);
    const { user_id, participant_id } = req.body;

    if (!user_id || !participant_id) {
      return res.status(400).json({ error: "user_id and participant_id are required" });
    }

    const conversation = await getConversationByParticipant(participant_id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    if (conversation.call_status !== "completed") {
      return res.status(400).json({ error: "Call not completed yet" });
    }

    const { call_duration } = conversation;
    if (!call_duration || call_duration === 0) {
      return res.status(400).json({ error: "Invalid call duration" });
    }

    const minutes = call_duration / 60;
    const creditsToDeduct = formatCredits(minutes * 1);

    const user = await getUserById(user_id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.credits < creditsToDeduct) {
      return res.status(400).json({
        error: "Insufficient credits",
        required: creditsToDeduct,
        available: formatCredits(user.credits),
      });
    }

    const newCredits = formatCredits(user.credits - creditsToDeduct);
    const prevCredits = formatCredits(user.credits);

    await updateUserCredits(user_id, newCredits);

    return res.status(200).json({
      message: "Credits reduced successfully",
      deducted: creditsToDeduct,
      previous_balance: prevCredits,
      new_balance: newCredits,
    });
  } catch (error) {
    console.error("❌ Error reducing credits:", error);
    return res.status(500).json({ error: error.message });
  }
};
