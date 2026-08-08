// utils/testChatEngine.js
// Handles test-mode conversations for BOTH classic and smart_fields agents.
// Does NOT require a real phone number, WhatsApp session, or DB participant row.
// State is passed in and out via conversationState (kept on the frontend).

import axios from "axios";
import { supabase } from "../config/supabase.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

/* ─────────────────────────────────────────────────────────────────
   Shared Claude caller with retry
───────────────────────────────────────────────────────────────── */
async function callClaude({ system, messages, maxTokens = 600 }) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`🔄 Claude API attempt ${attempt}/${MAX_RETRIES}...`);
      const res = await axios.post(
        ANTHROPIC_API_URL,
        {
          model: process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
          max_tokens: maxTokens,
          system,
          messages,
        },
        {
          headers: {
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          timeout: 30000,
        },
      );
      console.log(`✅ Claude API success on attempt ${attempt}`);
      return {
        text: res.data?.content?.[0]?.text || "",
        usage: res.data?.usage || null,
        model: res.data?.model || null,
      };
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 529 || status === 429 || status === 503;
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = attempt * 2000;
        console.warn(`⚠️ Claude ${status} — retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      console.error(
        `❌ Claude API error (attempt ${attempt}):`,
        err.response?.data || err.message,
      );
      throw err;
    }
  }
}

/* ─────────────────────────────────────────────────────────────────
   Fetch Knowledge Base content
───────────────────────────────────────────────────────────────── */
async function fetchKBContent(knowledgeBaseId) {
  if (!knowledgeBaseId) return null;
  try {
    const { data: entries, error } = await supabase
      .from("knowledge_entries")
      .select("*")
      .eq("knowledge_base_id", knowledgeBaseId)
      .order("created_at", { ascending: true });

    if (error || !entries?.length) return null;

    // Tolerant of either shape your knowledge_entries rows might use —
    // a single `content` blob, or `question`/`answer` pairs — since your
    // codebase currently has both patterns in different files.
    return entries
      .map((e) => {
        if (e.content) return e.content;
        if (e.question || e.answer)
          return `Q: ${e.question || ""}\nA: ${e.answer || ""}`;
        return null;
      })
      .filter(Boolean)
      .join("\n\n---\n\n");
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────
   CLASSIC MODE ENGINE
   Mimics the classic RSVP flow but without the broken
   decideNextStep JSON parsing — uses plain Claude instead.
   States: greeting → rsvp → guest_count → notes → completed
───────────────────────────────────────────────────────────────── */
export async function runClassicTestChat({
  agent,
  userMessage,
  conversationState,
}) {
  const eventName = agent.event_title || "the event";
  const state = conversationState?.callStatus || "greeting";
  const history = conversationState?.history || [];
  const convo = conversationState?.convo || {};

  const kbContent = await fetchKBContent(agent.knowledge_base_id);

  // Build system prompt
  const systemPrompt = `You are an AI event assistant for "${eventName}".
${agent.system_prompt ? `\nCustom instructions:\n${agent.system_prompt}` : ""}
${kbContent ? `\nEvent knowledge base:\n${kbContent}` : ""}

You are running in TEST MODE. Your job is to:
1. Greet the guest warmly on first contact
2. Ask if they will be attending (RSVP yes/no/maybe)
3. If yes, ask how many guests they're bringing
4. Collect any notes or special requirements
5. Answer any event questions using the knowledge base

Current conversation state: ${state}
Already collected: ${JSON.stringify(convo)}

RULES:
- Be warm, friendly, concise
- If guest asks about the event (venue, time, dress code, schedule), answer from the knowledge base
- Document uploads (ID proof, travel docs) are NOT available in test mode — skip those
- Keep replies short (2-4 sentences max)
- Do NOT output JSON, do NOT output state labels, just reply naturally as the assistant

After your reply, on a NEW LINE output exactly:
NEXT_STATE: <state>

Where <state> is one of:
- greeting (just greeted, waiting for first reply)
- awaiting_rsvp (asked for RSVP status, waiting)  
- awaiting_guest_count (asked for guest count, waiting)
- awaiting_notes (asked for notes, waiting)
- completed (all done)
- answering_question (answering an event question, then return to previous state)

And if you extracted a value, on another NEW LINE:
EXTRACTED: {"field": "value"}

Where field can be: rsvp_status, guest_count, notes`;

  // Build message history for Claude
  const claudeMessages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  // For first message (greeting), inject a trigger
  const isFirstMessage = history.length === 0;
  if (isFirstMessage) {
    claudeMessages[claudeMessages.length - 1] = {
      role: "user",
      content: `[Guest has just opened the chat]\nGuest says: ${userMessage}`,
    };
  }

  const claudeResult = await callClaude({
    system: systemPrompt,
    messages: claudeMessages,
    maxTokens: 400,
  });
  const rawReply = claudeResult.text;
  const claudeUsage = [];
  if (claudeResult.usage) {
    claudeUsage.push({
      model: claudeResult.model,
      input_tokens: claudeResult.usage.input_tokens,
      output_tokens: claudeResult.usage.output_tokens,
    });
  }

  // Parse NEXT_STATE and EXTRACTED from reply
  const nextStateMatch = rawReply.match(/NEXT_STATE:\s*(\S+)/);
  const extractedMatch = rawReply.match(/EXTRACTED:\s*(\{[^}]+\})/);

  let nextState = nextStateMatch?.[1] || state;
  let extracted = {};

  if (extractedMatch) {
    try {
      extracted = JSON.parse(extractedMatch[1]);
    } catch {
      // ignore parse errors
    }
  }

  // Clean reply — remove the signal lines
  const cleanReply = rawReply
    .replace(/\nNEXT_STATE:.*$/m, "")
    .replace(/\nEXTRACTED:.*$/m, "")
    .trim();

  // Update convo with extracted data
  const updatedConvo = { ...convo, ...extracted };

  // Build updated history
  const updatedHistory = [
    ...history,
    { role: "user", content: userMessage },
    { role: "assistant", content: cleanReply },
  ];

  // Keep history trimmed to last 20 messages to avoid token bloat
  const trimmedHistory = updatedHistory.slice(-20);

  const updatedState = {
    callStatus: nextState,
    history: trimmedHistory,
    convo: updatedConvo,
    field_mode: "classic",
  };

  return { reply: cleanReply, nextState, updatedState, usage: claudeUsage };
}

/* ─────────────────────────────────────────────────────────────────
   SMART FIELDS ENGINE
   Walks through agent.smart_fields one by one, collecting answers.
   State is tracked in conversationState (no DB session needed).
───────────────────────────────────────────────────────────────── */

function shouldSkipField(field, collectedAnswers) {
  if (!field.condition) return false;
  const { field: condField, value: condValue } = field.condition;
  const actual = String(collectedAnswers[condField] || "")
    .toLowerCase()
    .trim();
  const expected = String(condValue).toLowerCase().trim();
  return actual !== expected;
}

function parseFieldCollected(rawReply) {
  const match = rawReply.match(/FIELD_COLLECTED:\s*(\{[^}]+\})/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export async function runSmartFieldsTestChat({
  agent,
  userMessage,
  conversationState,
}) {
  const eventName = agent.event_title || "the event";
  const smartFields = agent.smart_fields || [];

  // ✅ Accumulates every callClaude call this turn makes — up to 2
  // (the completion/Q&A branch and the main field-collection branch are
  // mutually exclusive per turn, so realistically this is 0 or 1, but
  // kept as an array for the same pattern used everywhere else).
  const claudeUsage = [];

  if (!smartFields.length) {
    return {
      reply: `Hi! I'm your assistant for "${eventName}". However, no questions have been configured yet. Please contact the organizer.`,
      nextState: "completed",
      updatedState: { callStatus: "completed", field_mode: "smart_fields" },
      usage: claudeUsage,
    };
  }

  const history = conversationState?.history || [];
  const collectedAnswers = conversationState?.convo || {};
  let currentIndex = conversationState?.currentIndex ?? 0;

  // Advance past skipped fields
  while (
    currentIndex < smartFields.length &&
    shouldSkipField(smartFields[currentIndex], collectedAnswers)
  ) {
    console.log(
      `[testChatEngine] Skipping field "${smartFields[currentIndex].field_key}" — condition not met`,
    );
    currentIndex++;
  }

  const kbContent = await fetchKBContent(agent.knowledge_base_id);

  // ── All fields done ────────────────────────────────────────────
  if (currentIndex >= smartFields.length) {
    const completionReply = `Thank you! 🎉 Your responses for *${eventName}* have been recorded in test mode.\n\nHere's what was collected:\n${Object.entries(
      collectedAnswers,
    )
      .map(([k, v]) => `• ${k}: ${v}`)
      .join("\n")}\n\nFeel free to ask any questions about the event!`;

    // If user asks a question even after completion, answer it
    const isQuestion =
      userMessage.trim().endsWith("?") ||
      /\b(what|when|where|who|how|why|is|are|can|tell me|do you)\b/i.test(
        userMessage,
      );

    if (isQuestion && kbContent) {
      const claudeResult = await callClaude({
        system: `You are an assistant for "${eventName}". Answer guest questions using this knowledge base:\n\n${kbContent}\n\nBe concise and friendly.`,
        messages: [{ role: "user", content: userMessage }],
        maxTokens: 300,
      });
      const answerReply = claudeResult.text;
      if (claudeResult.usage) {
        claudeUsage.push({
          model: claudeResult.model,
          input_tokens: claudeResult.usage.input_tokens,
          output_tokens: claudeResult.usage.output_tokens,
        });
      }

      return {
        reply: answerReply,
        nextState: "completed",
        updatedState: {
          callStatus: "completed",
          currentIndex,
          history: [
            ...history,
            { role: "user", content: userMessage },
            { role: "assistant", content: answerReply },
          ].slice(-20),
          convo: collectedAnswers,
          field_mode: "smart_fields",
        },
        usage: claudeUsage,
      };
    }

    return {
      reply: completionReply,
      nextState: "completed",
      updatedState: {
        callStatus: "completed",
        currentIndex,
        history,
        convo: collectedAnswers,
        field_mode: "smart_fields",
      },
      usage: claudeUsage, // empty — no Claude call in this branch
    };
  }

  const currentField = smartFields[currentIndex];
  const totalVisible = smartFields.filter(
    (f) => !shouldSkipField(f, collectedAnswers),
  ).length;
  const answeredCount = Object.keys(collectedAnswers).length;

  console.log(
    `[testChatEngine] Smart fields — field "${currentField.field_key}" (${currentIndex + 1}/${smartFields.length})`,
  );

  // ── Build field-collection prompt ──────────────────────────────
  const choicesBlock = currentField.choices?.length
    ? `Valid choices: ${currentField.choices.join(", ")}`
    : "";

  const systemPrompt = `You are an AI assistant collecting information for "${eventName}" via a test chat.
${kbContent ? `\nEvent knowledge base:\n${kbContent}\n` : ""}
You are currently collecting field: "${currentField.field_label}"
Field type: ${currentField.field_type}
${choicesBlock}
Question to ask: "${currentField.ai_question}"
Required: ${currentField.is_required ? "Yes" : "No"}

Progress: ${answeredCount}/${totalVisible} questions answered
Already collected: ${JSON.stringify(collectedAnswers)}

RULES:
1. If this is the first message (no history), greet the user and ask the current field's question
2. If the guest has answered, validate and extract the answer, then ask the next field OR confirm completion
3. If the guest asks an event question (venue, time, etc.), answer from the knowledge base, THEN re-ask the current field
4. For choice fields: accept flexible input (e.g. "yep" → "yes", "2 people" → "2")
5. Be warm, friendly, and concise
6. Do NOT repeat questions unnecessarily
7. This is TEST MODE — no document uploads

After your reply, on a NEW LINE write:
FIELD_COLLECTED: {"field_key": "value"}

ONLY write FIELD_COLLECTED if the guest actually provided a valid answer for "${currentField.field_key}".
If they didn't answer or the answer is invalid, do NOT write FIELD_COLLECTED.

Example:
User: "Yes I'll be there"
Your reply: Great! How many guests are you bringing?
FIELD_COLLECTED: {"attendance": "yes"}`;

  const claudeMessages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  // First message — add context hint
  if (history.length === 0) {
    claudeMessages[claudeMessages.length - 1] = {
      role: "user",
      content: `[FIRST MESSAGE — greet the guest and ask the first question]\nGuest says: ${userMessage}`,
    };
  }

  const claudeResult = await callClaude({
    system: systemPrompt,
    messages: claudeMessages,
    maxTokens: 400,
  });
  const rawReply = claudeResult.text;
  if (claudeResult.usage) {
    claudeUsage.push({
      model: claudeResult.model,
      input_tokens: claudeResult.usage.input_tokens,
      output_tokens: claudeResult.usage.output_tokens,
    });
  }

  const fieldCollected = parseFieldCollected(rawReply);
  const cleanReply = rawReply.replace(/\nFIELD_COLLECTED:.*$/m, "").trim();

  let newCollectedAnswers = { ...collectedAnswers };
  let newIndex = currentIndex;

  if (fieldCollected) {
    console.log(
      `[testChatEngine] Field collected:`,
      JSON.stringify(fieldCollected),
    );
    newCollectedAnswers = { ...newCollectedAnswers, ...fieldCollected };
    newIndex = currentIndex + 1;

    // Advance past conditions that no longer apply
    while (
      newIndex < smartFields.length &&
      shouldSkipField(smartFields[newIndex], newCollectedAnswers)
    ) {
      newIndex++;
    }
  }

  const nextState =
    newIndex >= smartFields.length
      ? "completed"
      : `collecting_${smartFields[newIndex]?.field_key || "field"}`;

  const updatedHistory = [
    ...history,
    { role: "user", content: userMessage },
    { role: "assistant", content: cleanReply },
  ].slice(-20);

  const updatedState = {
    callStatus: nextState,
    currentIndex: newIndex,
    history: updatedHistory,
    convo: newCollectedAnswers,
    field_mode: "smart_fields",
  };

  return { reply: cleanReply, nextState, updatedState, usage: claudeUsage };
}
