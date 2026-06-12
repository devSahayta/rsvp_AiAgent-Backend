// utils/whatsappAgentTrigger.js
// Triggers a WhatsApp AI session for a participant.
// Called in two places:
//   1. triggerBatchCall() — immediately after batch is created
//   2. syncBatchStatuses() — when call_outcome = 'no_answer' | 'failed'

import { supabase } from "../config/supabase.js";
import { createSession } from "./sessionManager.js";
import { sendTemplate, sendText } from "./samvaadikClient.js";

/**
 * Get the Samvaadik API key for a user.
 */
async function getSamvaadikApiKey(userId) {
  const { data } = await supabase
    .from("samvaadik_connections")
    .select("api_key, status")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data || data.status !== "active") return null;
  return data.api_key;
}

/**
 * Send the opening WhatsApp message to the guest.
 * Uses a template if available, otherwise plain text.
 */
async function sendOpeningMessage(apiKey, phone, guestName, eventName) {
  const normalised = String(phone).startsWith("+") ? phone : `+${phone}`;

  try {
    // Try sending with template first if you have one configured
    // await sendTemplate(apiKey, {
    //   phone: normalised,
    //   template_name: "rsvp_initial_message",
    //   parameters: [guestName, eventName],
    // });

    // For now — plain text opening (works within 24hr window)
    await sendText(
      apiKey,
      normalised,
      `Hi ${guestName}! 👋 I'm here to help you RSVP for *${eventName}*. This will only take a minute!\n\nLet's get started.`,
    );

    console.log(
      `[whatsappAgentTrigger] ✅ Opening message sent to ${normalised}`,
    );
    return true;
  } catch (err) {
    console.error(
      "[whatsappAgentTrigger] Failed to send opening message:",
      err.response?.data || err.message,
    );
    return false;
  }
}

/**
 * Trigger WhatsApp AI session for a single participant.
 *
 * @param {object} params
 * @param {string} params.eventId
 * @param {string} params.participantId
 * @param {string} params.phoneNumber
 * @param {string} params.guestName
 * @param {string} params.eventName
 * @param {string} params.userId          — event owner's user_id (for Samvaadik key lookup)
 * @param {string} params.triggeredBy     — "batch" | "voice_fallback" | "manual"
 * @param {boolean} params.sendFirstMessage — whether to send the opening WhatsApp message
 */
export const triggerWhatsAppSession = async ({
  eventId,
  participantId,
  phoneNumber,
  guestName,
  eventName,
  userId,
  triggeredBy = "manual",
  sendFirstMessage = true,
}) => {
  try {
    const normalised = String(phoneNumber).replace(/^\+/, "");

    console.log(
      `[whatsappAgentTrigger] Triggering session for ${guestName} (${normalised}) — reason: ${triggeredBy}`,
    );

    // 1. Create/reset session
    const session = await createSession({
      event_id: eventId,
      participant_id: participantId,
      phone_number: normalised,
      triggered_by: triggeredBy,
    });

    if (!session) {
      console.error("[whatsappAgentTrigger] Failed to create session");
      return false;
    }

    // 2. Send opening message via Samvaadik
    if (sendFirstMessage) {
      const apiKey = await getSamvaadikApiKey(userId);
      if (!apiKey) {
        console.warn(
          "[whatsappAgentTrigger] No Samvaadik connection — skipping opening message",
        );
        return true; // session created, message skipped
      }

      await sendOpeningMessage(apiKey, normalised, guestName, eventName);
    }

    return true;
  } catch (err) {
    console.error("[whatsappAgentTrigger] Error:", err.message);
    return false;
  }
};

/**
 * Trigger WhatsApp sessions for all participants in a batch.
 * Called from triggerBatchCall() in eventController.js.
 */
export const triggerBatchWhatsAppSessions = async ({
  eventId,
  eventName,
  userId,
  participants,
  triggeredBy = "batch",
}) => {
  console.log(
    `[whatsappAgentTrigger] Triggering ${participants.length} WhatsApp sessions for event ${eventId}`,
  );

  let success = 0;
  let failed = 0;

  for (const p of participants) {
    const ok = await triggerWhatsAppSession({
      eventId,
      participantId: p.participant_id,
      phoneNumber: p.phone_number,
      guestName: p.full_name,
      eventName,
      userId,
      triggeredBy,
      sendFirstMessage: false, // don't spam on batch — let voice call go first
    });

    ok ? success++ : failed++;
  }

  console.log(
    `[whatsappAgentTrigger] Batch sessions: ${success} created, ${failed} failed`,
  );
  return { success, failed };
};
