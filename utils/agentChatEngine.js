// utils/agentChatEngine.js
// Core WhatsApp turn engine for smart fields events.
// Called from whatsappController.js when event.field_mode === 'smart_fields'.
//
// Flow per turn:
//   1. Load session + smart fields
//   2. Check if all fields done → close session
//   3. If current field is document/travel_ticket → handle deterministically
//      (bypasses Claude entirely — file handling doesn't need an LLM)
//   4. Otherwise: build system prompt for current field, call Claude,
//      parse FIELD_COLLECTED signal, advance or retry
//   5. Return reply to send to guest

import axios from "axios";
import { supabase } from "../config/supabase.js";
import { buildSystemPrompt } from "./smartFieldsPromptBuilder.js";
import { handleDocumentField } from "./smartDocumentHandler.js";
import {
  lookupSessionByPhone,
  advanceSession,
  updateHistory,
  closeSession,
} from "./sessionManager.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// Field types handled deterministically, without calling Claude.
const DOCUMENT_FIELD_TYPES = new Set(["document", "travel_ticket"]);

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

function cleanReply(rawReply) {
  return rawReply.replace(/\nFIELD_COLLECTED:.*$/m, "").trim();
}

function shouldSkipField(field, collectedAnswers) {
  if (!field.condition) return false;
  const { field: condField, value: condValue } = field.condition;
  const actualValue = String(collectedAnswers[condField] || "").toLowerCase();
  const expectedValue = String(condValue).toLowerCase();
  return actualValue !== expectedValue;
}

/**
 * Build the "here's what to answer" prompt text for a field, for use when
 * we need to hand off to the next field OURSELVES (i.e. the previous turn
 * didn't go through Claude, so nothing asked it automatically the way
 * Claude does via the "move on smoothly" instruction in buildSystemPrompt).
 */
function buildFieldPrompt(field) {
  if (field.field_type === "travel_ticket") {
    return `${field.ai_question}\n\nPlease send your Arrival ticket first 📤`;
  }
  if (field.field_type === "document") {
    return `${field.ai_question} 📤`;
  }
  if (field.field_type === "choice" && field.options?.length) {
    return `${field.ai_question} (${field.options.join(" / ")})`;
  }
  return field.ai_question;
}

/**
 * Persist field_state directly (transient sub-step tracking for multi-step
 * field types like travel_ticket). Direct supabase call rather than routing
 * through sessionManager.js so that file doesn't need touching — move this
 * into sessionManager.js as `updateFieldState()` later if you'd rather keep
 * all session writes in one place.
 */
async function updateFieldState(sessionId, fieldState) {
  const { error } = await supabase
    .from("whatsapp_ai_sessions")
    .update({ field_state: fieldState })
    .eq("session_id", sessionId);
  if (error) {
    console.error("[agentChatEngine] Failed to update field_state:", error);
  }
}

export const agentChatEngine = async ({
  phoneNumber,
  userMessage,
  mediaUrl = null, // fetchable URL for OCR extraction (Samvaadik raw URL or signed WA URL)
  mediaType = null, // e.g. 'image' | 'document' | 'text'
  storagePath = null, // NEW — bucket-relative path in `participant-docs`, used as the stored document_url so Document Viewer works the same as classic
  eventId,
  participantId,
  guestName,
  event,
}) => {
  try {
    // ✅ Accumulates the Claude call this turn makes (0 or 1 entries — only
    // the standard-field branch below calls Claude; document/travel_ticket
    // fields are handled deterministically and never touch it).
    const claudeUsage = [];

    // ── 1. Load session ────────────────────────────────────────────────────
    const session = await lookupSessionByPhone(phoneNumber);

    if (!session) {
      console.warn(
        `[agentChatEngine] No active session for phone ${phoneNumber}`,
      );
      return null;
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
      return {
        reply:
          "Sorry, I'm having trouble loading your RSVP questions. Please try again shortly.",
        usage: claudeUsage,
      };
    }

    let { current_index, collected_answers, conversation_history } = session;
    const fieldState = session.field_state || {};
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

    if (current_index >= smartFields.length) {
      await closeSession(
        session.session_id,
        eventId,
        participantId,
        collected_answers,
      );
      const eventName = event?.event_name || "the event";
      return {
        reply: `Thank you ${guestName}! 🎉 Your RSVP for *${eventName}* is complete. We look forward to seeing you! If you have any questions, feel free to reach out.`,
        usage: claudeUsage,
      };
    }

    const currentField = smartFields[current_index];
    const totalFields = smartFields.filter(
      (f) => !shouldSkipField(f, collected_answers),
    ).length;

    console.log(
      `[agentChatEngine] Turn: participant=${participantId} field="${currentField.field_key}" (${currentField.field_type}) index=${current_index}/${smartFields.length}`,
    );

    if (DOCUMENT_FIELD_TYPES.has(currentField.field_type)) {
      const result = await handleDocumentField({
        field: currentField,
        mediaUrl,
        storagePath, // NEW
        userMessage, // NEW — needed for skip-intent detection
        fieldState,
        participantId,
        eventId,
        guestName,
      });

      // Real OCR/extraction cost (0 for generic `document` fields — they
      // never call autoExtractFromImage; only travel_ticket does).
      const ocrVisionUnits = result.ocrVisionUnits || 0;
      const ocrClaudeUsage = result.ocrClaudeUsage || [];

      const historyWithReply = [
        ...conversation_history,
        { role: "user", content: userMessage || "[media]" },
        { role: "assistant", content: result.reply },
      ];

      if (!result.collected) {
        // Still mid-sequence (e.g. arrival done, waiting on return) —
        // persist field_state, keep index the same.
        await updateFieldState(session.session_id, result.newFieldState);
        await updateHistory(session.session_id, historyWithReply);
        return {
          reply: result.reply,
          usage: claudeUsage,
          ocrVisionUnits,
          ocrClaudeUsage,
        };
      }

      // ── Field fully collected — advance index, clear field_state ─────────
      const newIndex = current_index + 1;
      await advanceSession(session.session_id, {
        field_key: currentField.field_key,
        value: result.value,
        newIndex,
        updatedHistory: historyWithReply,
      });
      await updateFieldState(session.session_id, {});

      let nextIndex = newIndex;
      const updatedAnswers = {
        ...collected_answers,
        [currentField.field_key]: result.value,
      };
      while (
        nextIndex < smartFields.length &&
        shouldSkipField(smartFields[nextIndex], updatedAnswers)
      ) {
        nextIndex++;
      }

      if (nextIndex >= smartFields.length) {
        await closeSession(
          session.session_id,
          eventId,
          participantId,
          updatedAnswers,
        );
        const eventName = event?.event_name || "the event";
        return {
          reply: `${result.reply}\n\nThank you ${guestName}! 🎉 Your RSVP for *${eventName}* is complete. We look forward to seeing you!`,
          usage: claudeUsage,
          ocrVisionUnits,
          ocrClaudeUsage,
        };
      }

      // NEW — since this turn never went through Claude, nothing has asked
      // the next question yet (Claude's turns handle this themselves via
      // the "move on smoothly" instruction in buildSystemPrompt; this
      // deterministic branch has to do it explicitly instead).
      const nextField = smartFields[nextIndex];
      return {
        reply: `${result.reply}\n\n${buildFieldPrompt(nextField)}`,
        usage: claudeUsage,
        ocrVisionUnits,
        ocrClaudeUsage,
      };
    }

    // ── 6. Standard fields (yes_no/number/text/choice) — existing Claude flow ──
    const updatedHistory = [
      ...conversation_history,
      { role: "user", content: userMessage },
    ];

    const systemPrompt = await buildSystemPrompt({
      eventName: event?.event_name || "the event",
      guestName,
      currentField,
      knowledgeBaseId: event?.knowledge_base_id || null,
      collectedAnswers: collected_answers,
      totalFields,
      currentIndex: current_index,
      allFields: smartFields,
    });

    const claudeResponse = await axios.post(
      ANTHROPIC_API_URL,
      {
        model: process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
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

    const usageData = claudeResponse.data?.usage;
    const modelUsed = claudeResponse.data?.model;
    if (usageData) {
      claudeUsage.push({
        model: modelUsed,
        input_tokens: usageData.input_tokens,
        output_tokens: usageData.output_tokens,
      });
    }

    const rawReply = claudeResponse.data?.content?.[0]?.text || "";
    console.log(
      `[agentChatEngine] Claude raw reply: ${rawReply.slice(0, 200)}`,
    );

    const signal = parseFieldCollected(rawReply);
    const reply = cleanReply(rawReply);

    const historyWithReply = [
      ...updatedHistory,
      { role: "assistant", content: reply },
    ];

    if (signal?.field_key && signal?.value !== undefined) {
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
        await closeSession(
          session.session_id,
          eventId,
          participantId,
          updatedAnswers,
        );
        const eventName = event?.event_name || "the event";
        const completionMsg = `${reply}\n\nThank you ${guestName}! 🎉 Your RSVP for *${eventName}* is complete. We look forward to seeing you!`;
        return { reply: completionMsg, usage: claudeUsage };
      }

      // NEW — if we just advanced INTO a document/travel_ticket field from
      // a Claude-handled field, Claude's reply (built from the OLD field's
      // prompt) won't have asked for the document — append that prompt now.
      const nextField = smartFields[nextIndex];
      if (isCurrentField && DOCUMENT_FIELD_TYPES.has(nextField.field_type)) {
        return {
          reply: `${reply}\n\n${buildFieldPrompt(nextField)}`,
          usage: claudeUsage,
        };
      }
    } else {
      console.log(
        `[agentChatEngine] ℹ️ No FIELD_COLLECTED signal — retrying field "${currentField.field_key}"`,
      );
      await updateHistory(session.session_id, historyWithReply);
    }

    return { reply, usage: claudeUsage };
  } catch (err) {
    console.error(
      "[agentChatEngine] Error:",
      err.response?.data || err.message,
    );
    return {
      reply: `Sorry ${guestName}, I'm having a technical issue right now. Please try again in a moment.`,
      usage: [], // claudeUsage is out of scope here — same edge case as generalChatEngine.js
    };
  }
};
