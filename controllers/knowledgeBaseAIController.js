import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Reuses the same model your other Claude-powered features already run on.
// Set KB_AI_MODEL only if you want this specific endpoint on a different
// model than the rest of the app (e.g. a stronger model for this one call).
const AI_MODEL =
  process.env.KB_AI_MODEL ||
  process.env.CLAUDE_MODEL ||
  "claude-haiku-4-5-20251001";

const MAX_PROMPT_LENGTH = 2000;

const SYSTEM_PROMPT = `You are a knowledge base writer for Sutrak, an AI RSVP voice/chat agent platform.

Your job: given a short description of an event from the event host, write a clean, well-structured knowledge base document. This document is fed directly into the agent's knowledge base and is what the agent references when a guest asks a question during an RSVP call — it is reference material, not a script.

Formatting rules:
- Plain text only. No markdown headers, no asterisks, no code fences.
- Use short plain-text labels followed by a colon (e.g. "Venue:", "Date:", "Schedule:", "Dress Code:", "Parking:") — one per line or section.
- Only include sections that are relevant to this event or that the host mentioned or implied. Do not pad the document with empty or generic sections.
- If the host describes a multi-day or multi-session schedule, list each item with its day/time.
- Never invent specifics the host did not provide — no fake addresses, phone numbers, prices, or times. If a normally-expected detail (e.g. venue name) is missing, simply omit it rather than making one up.
- End with a short "Frequently Asked Questions" section covering 2-4 questions guests commonly ask (dress code, parking, plus-ones, kids, gifts, timing) — but only include a question if you can answer it from what the host actually said.
- Do not include agent greetings, call scripts, or conversational filler.
- Do not restate the questions the agent will separately ask guests (see "Fields the agent will ask" in the context below) — this document is background knowledge, not a list of things to collect.`;

function buildContextBlock({
  agent_name,
  agent_description,
  field_mode,
  event_title,
  template,
  groom_name,
  bride_name,
  smart_fields,
}) {
  const lines = [];

  lines.push(`Agent name: ${agent_name || "Untitled agent"}`);
  if (agent_description) {
    lines.push(`Agent purpose: ${agent_description}`);
  }

  if (field_mode === "classic") {
    if (template?.name) {
      lines.push(
        `Template in use: ${template.name}${
          template.category ? ` (category: ${template.category})` : ""
        }`,
      );
    }
    if (groom_name && bride_name) {
      lines.push(`Event: Wedding of ${groom_name} and ${bride_name}`);
    }
  } else {
    if (event_title) {
      lines.push(`Event title: ${event_title}`);
    }
    if (Array.isArray(smart_fields) && smart_fields.length > 0) {
      const fieldLines = smart_fields
        .filter((f) => f && f.field_label)
        .map(
          (f) =>
            `- ${f.field_label}${f.is_required ? " (required)" : " (optional)"}: ${
              f.ai_question || ""
            }`,
        )
        .join("\n");
      if (fieldLines) {
        lines.push(
          `Fields the agent will ask guests directly during the call (context only — do not restate these as FAQ):\n${fieldLines}`,
        );
      }
    }
  }

  return lines.join("\n");
}

export const generateKnowledgeBase = async (req, res) => {
  try {
    const {
      agent_name,
      agent_description,
      field_mode,
      event_title,
      template,
      groom_name,
      bride_name,
      smart_fields,
      user_prompt,
    } = req.body;

    if (!user_prompt || !user_prompt.trim()) {
      return res.status(400).json({
        success: false,
        error: "Describe the event first so the AI has something to work with.",
      });
    }

    if (user_prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({
        success: false,
        error: `Description is too long — keep it under ${MAX_PROMPT_LENGTH} characters.`,
      });
    }

    const contextBlock = buildContextBlock({
      agent_name,
      agent_description,
      field_mode,
      event_title,
      template,
      groom_name,
      bride_name,
      smart_fields,
    });

    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `${contextBlock}\n\nHost's description of the event:\n${user_prompt.trim()}`,
        },
      ],
    });

    const content = (response.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!content) {
      throw new Error("AI returned an empty response");
    }

    res.json({ success: true, data: { content } });
  } catch (err) {
    console.error(
      "Generate knowledge base error:",
      err.response?.data || err.message,
    );
    res.status(500).json({
      success: false,
      error: "Failed to generate knowledge base. Please try again.",
    });
  }
};
