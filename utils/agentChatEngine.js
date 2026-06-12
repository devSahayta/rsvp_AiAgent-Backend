// utils/agentChatEngine.js
// Core WhatsApp turn engine for smart fields events.
// Called from whatsappController.js when event.field_mode === 'smart_fields'.
//
// Flow per turn:
//   1. Load session + smart fields
//   2. Check if all fields done → close session
//   3. Build system prompt for current field
//   4. Call Claude API with full conversation history
//   5. Parse FIELD_COLLECTED signal
//   6. Advance session or retry
//   7. Return reply to send to guest

import axios from "axios";
import { supabase } from "../config/supabase.js";
import { buildSystemPrompt } from "./smartFieldsPromptBuilder.js";
import {
  lookupSessionByPhone,
  advanceSession,
  updateHistory,
  closeSession,
} from "./sessionManager.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

/**
 * Parse FIELD_COLLECTED signal from Claude's raw response.
 * Returns { field_key, value } or null.
 */
function parseFieldCollected(rawReply) {
  const match = rawReply.match(/FIELD_COLLECTED:\s*(\{[^}]+\})/);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    console.warn(
      "[agentChatEngine] Failed to parse FIELD_COLLECTED JSON:",
      match[1],
    );
    return null;
  }
}

/**
 * Strip FIELD_COLLECTED signal from reply before sending to guest.
 */
function cleanReply(rawReply) {
  return rawReply.replace(/\nFIELD_COLLECTED:.*$/m, "").trim();
}

/**
 * Check if a field should be skipped based on its condition.
 * e.g. condition: { field: "attendance", value: "yes" }
 */
function shouldSkipField(field, collectedAnswers) {
  if (!field.condition) return false;

  const { field: condField, value: condValue } = field.condition;
  const actualValue = String(collectedAnswers[condField] || "").toLowerCase();
  const expectedValue = String(condValue).toLowerCase();

  // Skip if condition NOT met
  return actualValue !== expectedValue;
}

/**
 * Main engine function.
 *
 * @param {object} params
 * @param {string} params.phoneNumber    — normalised phone (no +)
 * @param {string} params.userMessage   — incoming text from guest
 * @param {string} params.eventId
 * @param {string} params.participantId
 * @param {string} params.guestName
 * @param {object} params.event          — full event row
 *
 * @returns {string} reply to send back to the guest
 */
export const agentChatEngine = async ({
  phoneNumber,
  userMessage,
  eventId,
  participantId,
  guestName,
  event,
}) => {
  try {
    // ── 1. Load session ────────────────────────────────────────────────────
    const session = await lookupSessionByPhone(phoneNumber);

    if (!session) {
      console.warn(
        `[agentChatEngine] No active session for phone ${phoneNumber}`,
      );
      return null; // caller falls back to existing decideNextStep
    }

    // ── 2. Load smart fields for this event ────────────────────────────────
    const { data: smartFields, error: sfError } = await supabase
      .from("event_smart_fields")
      .select("*")
      .eq("event_id", eventId)
      .order("display_order", { ascending: true });

    if (sfError || !smartFields?.length) {
      console.error(
        "[agentChatEngine] No smart fields found for event:",
        eventId,
      );
      return "Sorry, I'm having trouble loading your RSVP questions. Please try again shortly.";
    }

    let { current_index, collected_answers, conversation_history } = session;
    conversation_history = Array.isArray(conversation_history)
      ? conversation_history
      : [];

    // ── 3. Skip fields whose conditions aren't met ─────────────────────────
    while (
      current_index < smartFields.length &&
      shouldSkipField(smartFields[current_index], collected_answers)
    ) {
      console.log(
        `[agentChatEngine] Skipping field "${smartFields[current_index].field_key}" — condition not met`,
      );
      current_index++;
    }

    // ── 4. Check if all fields done ────────────────────────────────────────
    if (current_index >= smartFields.length) {
      // All done — close session and send completion message
      await closeSession(
        session.session_id,
        eventId,
        participantId,
        collected_answers,
      );

      const eventName = event?.event_name || "the event";
      return `Thank you ${guestName}! 🎉 Your RSVP for *${eventName}* is complete. We look forward to seeing you! If you have any questions, feel free to reach out.`;
    }

    const currentField = smartFields[current_index];
    const totalFields = smartFields.filter(
      (f) => !shouldSkipField(f, collected_answers),
    ).length;

    console.log(
      `[agentChatEngine] Turn: participant=${participantId} field="${currentField.field_key}" index=${current_index}/${smartFields.length}`,
    );

    // ── 5. Append user message to history ──────────────────────────────────
    const updatedHistory = [
      ...conversation_history,
      { role: "user", content: userMessage },
    ];

    // ── 6. Build system prompt ─────────────────────────────────────────────
    const systemPrompt = await buildSystemPrompt({
      eventName: event?.event_name || "the event",
      guestName,
      currentField,
      knowledgeBaseId: event?.knowledge_base_id || null,
      collectedAnswers: collected_answers,
      totalFields,
      currentIndex: current_index,
      allFields: smartFields, // ← pass ALL fields so Claude knows what it's allowed to ask
    });

    // ── 7. Call Claude API ─────────────────────────────────────────────────
    const claudeResponse = await axios.post(
      ANTHROPIC_API_URL,
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        system: systemPrompt,
        messages: updatedHistory,
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      },
    );

    const rawReply = claudeResponse.data?.content?.[0]?.text || "";
    console.log(
      `[agentChatEngine] Claude raw reply: ${rawReply.slice(0, 200)}`,
    );

    // ── 8. Parse FIELD_COLLECTED signal ────────────────────────────────────
    const signal = parseFieldCollected(rawReply);
    const reply = cleanReply(rawReply);

    // Append Claude reply to history
    const historyWithReply = [
      ...updatedHistory,
      { role: "assistant", content: reply },
    ];

    if (signal?.field_key && signal?.value !== undefined) {
      // ── 9a. Answer collected ──────────────────────────────────────────────
      // If signal is for the CURRENT field → advance index
      // If signal is a CORRECTION of a previous field → update answer, keep index
      const isCurrentField = signal.field_key === currentField.field_key;
      const newIndex = isCurrentField ? current_index + 1 : current_index;

      console.log(
        `[agentChatEngine] ✅ Field collected: ${signal.field_key} = "${signal.value}" → ${isCurrentField ? `advancing to index ${newIndex}` : `correction, staying at index ${current_index}`}`,
      );

      await advanceSession(session.session_id, {
        field_key: signal.field_key,
        value: signal.value,
        newIndex,
        updatedHistory: historyWithReply,
      });

      // Check if this was the last field after advancing
      let nextIndex = newIndex;
      const updatedAnswers = {
        ...collected_answers,
        [signal.field_key]: signal.value,
      };

      while (
        nextIndex < smartFields.length &&
        shouldSkipField(smartFields[nextIndex], updatedAnswers)
      ) {
        nextIndex++;
      }

      if (nextIndex >= smartFields.length) {
        // All done after this answer
        await closeSession(
          session.session_id,
          eventId,
          participantId,
          updatedAnswers,
        );
        const eventName = event?.event_name || "the event";
        const completionMsg = `${reply}\n\nThank you ${guestName}! 🎉 Your RSVP for *${eventName}* is complete. We look forward to seeing you!`;
        return completionMsg;
      }
    } else {
      // ── 9b. No answer collected — retry or KB answer, same index ─────────
      console.log(
        `[agentChatEngine] ℹ️ No FIELD_COLLECTED signal — retrying field "${currentField.field_key}"`,
      );

      await updateHistory(session.session_id, historyWithReply);
    }

    return reply;
  } catch (err) {
    console.error(
      "[agentChatEngine] Error:",
      err.response?.data || err.message,
    );
    return `Sorry ${guestName}, I'm having a technical issue right now. Please try again in a moment.`;
  }
};
