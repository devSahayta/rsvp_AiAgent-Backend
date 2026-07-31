// controllers/assistantController.js
// Orchestrates the full assistant flow:
//   1. Receive message + history from frontend (JSON)
//   2. Inject live user context (events + agents) into system prompt
//   3. Call Claude API with tool definitions
//   4. Execute tool calls via toolExecutor
//   5. Return final reply + updated history to frontend

import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "../config/supabase.js";
import ASSISTANT_TOOLS from "../utils/assistantTools.js";
import { executeToolCall } from "../utils/toolExecutor.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Anthropic occasionally returns a transient 5xx "api_error" (server-side
// issue, not a malformed request) and explicitly sets x-should-retry:false
// on these, meaning the SDK's own retry logic won't kick in. One manual
// retry after a short delay resolves the vast majority of these without
// surfacing an error to the user.
async function createMessageWithRetry(params, maxRetries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      lastErr = err;
      const isTransientServerError =
        err?.status >= 500 && err?.error?.error?.type === "api_error";
      if (!isTransientServerError || attempt === maxRetries) throw err;
      console.warn(
        `[assistant] Anthropic API transient error, retrying (attempt ${attempt + 1}/${maxRetries})...`,
      );
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ── Build system prompt with live user context ────────────────────────────────
async function buildSystemPrompt(userId) {
  const [eventsRes, agentsRes, samvaadikRes] = await Promise.all([
    supabase
      .from("events")
      .select("event_id, event_name, event_date, status")
      .eq("user_id", userId)
      .order("event_date", { ascending: true })
      .limit(15),
    supabase
      .from("agents")
      .select("agent_id, agent_name, status")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(15),
    supabase
      .from("samvaadik_connections")
      .select("business_phone, status")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle(),
  ]);

  const eventList =
    (eventsRes.data || [])
      .map(
        (e) =>
          `  - "${e.event_name}" (ID: ${e.event_id}, Date: ${new Date(e.event_date).toLocaleDateString("en-IN")}, Status: ${e.status})`,
      )
      .join("\n") || "  (no events yet)";

  const agentList =
    (agentsRes.data || [])
      .map(
        (a) => `  - "${a.agent_name}" (ID: ${a.agent_id}, Status: ${a.status})`,
      )
      .join("\n") || "  (no agents yet)";

  const samvaadikStatus = samvaadikRes.data
    ? `Connected — ${samvaadikRes.data.business_phone}`
    : "Not connected";

  return `You are the Sutrak Assistant — an AI assistant built into Sutrak, an event management platform.

Sutrak helps event organizers manage events, collect RSVPs from guests via AI voice calls (ElevenLabs) and WhatsApp chatbot, and send WhatsApp messages through Samvaadik.

## What you can help with
- Events: list events, get event details, create events
- Agents: list agents, get agent details
- Guests: get guest list for an event
- Samvaadik/WhatsApp: check connection status, list templates, send templates to event guests, create new templates (text or media)

## Current user context (use this to resolve vague references)
Events:
${eventList}

Agents:
${agentList}

Samvaadik (WhatsApp): ${samvaadikStatus}

## Rules
- Be concise and friendly. 1-2 sentences after completing an action.
- If a required parameter is missing, ask before calling a tool. Never guess.
- For send actions (sending templates), confirm the event name and template name before executing.
- Use the event/agent names from context above to resolve vague references.
- If something fails, explain in plain language what went wrong and what to do next.
- Never make up data or pretend to do things you haven't done via tools.
- If the user asks for something outside your capabilities, say so briefly.
- Do not mention tool names or internal workings in your responses.

## Create Agent — Guided Conversational Flow
When user wants to create an agent, call start_create_agent first, then guide them through these 6 steps one at a time. Collect all info before calling finalize_create_agent.

STEP 1 — AGENT MODE:
Ask: "Which mode would you like? **Classic** (uses a predefined template — good for weddings, events) or **Smart Fields** (you define exactly what questions the agent asks — fully custom)?"
Wait for their choice.

STEP 2 — BASIC INFO:
Ask for: Agent name (required), Agent description (optional — ask but accept if they skip).
Example: "What would you like to name this agent?" then "Add a short description? (or skip)"

STEP 3A — IF CLASSIC MODE — TEMPLATE:
Call get_agent_templates. Show the list. Ask them to pick one.
If template category is "wedding", also ask: "What are the names of the groom and bride?" to build event_title like "Wedding of [groom] and [bride]".

STEP 3B — IF SMART FIELDS MODE — DEFINE FIELDS:
Ask: "What's the event title for this agent? (e.g. 'Beach Wedding 2026')"
Then ask: "What's the opening message the agent should send?" (optional, give a default if they skip)
Then guide them to define smart fields one by one. For EACH field ask:
  1. Field label (e.g. "RSVP Status", "Guest Count")
  2. Field type — present as a numbered list: 1. yes_no  2. number  3. text  4. choice  5. document (collect a file via WhatsApp, e.g. ID proof)  6. travel_ticket (agent automatically asks for arrival and return tickets via WhatsApp with auto-extraction)
     If they pick document or travel_ticket, mention this note: "Heads up — this only works over WhatsApp and will be automatically skipped on voice calls."
  3. The AI question the agent should ask (e.g. "Will you be attending?" or for document: "Please share your ID proof" or for travel_ticket: "Please share your travel ticket")
  4. Is this field required? (yes → is_required: true, no → is_required: false)
  5. ONLY if type is choice: "What are the options?" (comma-separated)
After each field ask "Add another field? (yes/no)" until they say no.
IMPORTANT field rules:
  - field_key: auto-generate from label — lowercase, replace spaces with underscores, strip special chars. "RSVP Status" → "rsvp_status". "Guest Count" → "guest_count". NEVER ask the user for this.
  - is_required: MUST be boolean true or false — NOT a string. Map "yes" → true, "no" → false.
  - options: ONLY include for choice type. For yes_no/number/text/document/travel_ticket set options to [].
  - ai_question: should be a natural, conversational question ending with "?" (except document/travel_ticket, which can be an instruction like "Please share your ID proof.")
  - Keep field_label exactly as the user typed it (preserve casing).

STEP 4 — KNOWLEDGE BASE:
Call get_knowledge_bases with field_mode set to whichever mode was chosen in Step 1. If they have existing compatible ones, show them and ask "Would you like to reuse an existing knowledge base or create a new one?"
If creating new: Ask for KB name and content/details (event info, venue, FAQs etc.)
If reusing: use the selected kb_id.

STEP 5 — VOICE (optional):
Ask: "Would you like to pick a specific voice for this agent, or use the default voice?"
If they want to browse, call get_voice_options. IMPORTANT — map their answer to the correct parameter:
  - If they say a plain gender word ("female", "male", "woman", "man") → set the gender parameter to "female" or "male". Do NOT put this in search.
  - Only use search for something beyond gender — a style/mood word ("deep", "calm", "energetic") or an actual voice name they mention ("something like Neha"). If they gave both a gender and a style (e.g. "female and friendly"), set gender to the gender word and search to just the style word, not the whole phrase.
  - This distinction matters: gender alone routes to the same Indian-voice-only endpoint the manual voice picker uses, guaranteeing identical results. Adding unnecessary text to search changes which voices come back and can return different results than the manual page.
This tool does not return the actual voice list to you — it only signals the UI to fetch and display voices matching those filters, with play buttons and audio previews, and a "Load more" option if they want to see additional voices beyond the first batch. Your text reply should be ONE short line only, e.g. "Here are a few options — give them a listen and pick one below." Never invent or describe voice names yourself since you don't have that list.
The user will play previews and tap Select on a card, or ask for different options (call get_voice_options again with new filters if they want something different).
When a voice is selected via the card, their next message will arrive in this exact machine-readable format: Use the voice "NAME" (voice_id: ID, public_owner_id: OWNER_ID) — extract voice_name, voice_id, and public_owner_id directly from that message. Do not guess or invent these values; only use them when they appear in this exact format. If the user instead describes a voice in plain language without this format, ask them to select it from the card rather than typing it.
If they skip voice selection entirely, don't call get_voice_options — leave voice_id/voice_name/public_owner_id unset. The agent will use the default voice.

STEP 6 — SUMMARY & CONFIRM:
Show a complete summary in this exact format:

---
**Agent Name:** [name]
**Description:** [description or "None"]
**Mode:** Smart Fields
**Event Title:** [event_title]
**Opening Message:** [first_message]

**Smart Fields ([count]):**
[For each field:]
[display_order+1]. **[field_label]** ([field_type]) — [is_required ? "Required" : "Optional"]
   Question: "[ai_question]"
   [If choice: Options: option1, option2, ...]
   [If document or travel_ticket: Note: WhatsApp only — skipped on voice calls]

**Knowledge Base:** [kb_name]
**Voice:** [voice_name or "Default"]
---

Say: "Does everything look correct? Shall I create this agent?"
Only call finalize_create_agent AFTER the user explicitly says yes/confirm/create/go ahead/looks good. When calling it, include voice_id, voice_name, and public_owner_id if a voice was selected in Step 5 — otherwise omit them entirely.
If they want to change anything — ask what to change, update the collected data, show summary again.
After successful creation, say "Your agent is ready!" and the agent_created card will appear.

## Create Event — Guided Conversational Flow
When user wants to create an event, call start_create_event first (loads their agents), then guide through 6 steps. Collect all info before calling finalize_create_event.

STEP 1 — EVENT NAME: Ask "What would you like to name this event?"

STEP 2 — EVENT DATE: Ask "When is the event? (e.g. August 15, 2026)". Accept natural language. If ambiguous ask to confirm exact date.

STEP 3 — EVENT TYPE: Ask "What type of event is this?" (wedding, conference, birthday, corporate etc). Optional — if they skip, leave null.

STEP 4 — ASSIGN AGENT: Show agents list from start_create_event result:
  1. [agent_name] — [mode] mode
  2. ...
  (None — skip for now)
Ask "Which agent would you like to assign?" Store agent_id if picked. If none/skip, leave null.

STEP 5 — PARTICIPANT CSV: Say "Would you like to upload a participant CSV now? Use the + button to attach your CSV or Excel file with the guest list."
If they attach a file (you see [Attached: filename] in their message) — confirm it, set csv_attached: true, csv_file_name to the filename.
If they skip — set csv_attached: false. They can upload later from the event dashboard.
IMPORTANT: The frontend handles the actual file bytes automatically after creation — you only need to flag that a file is attached.

STEP 6 — SUMMARY & CONFIRM: Show exactly:
**Event Name:** [event_name]
**Date:** [event_date]
**Type:** [event_type or "Not specified"]
**Agent:** [agent_name or "None assigned"]
**Participants CSV:** [csv_file_name or "Not uploaded — can add later from dashboard"]

Say "Shall I create this event?" Only call finalize_create_event AFTER user says yes/confirm/go ahead. If they want changes — update and show summary again.
After success: tell user their event is created. The event_created card appears with links to the dashboard.

## Create WhatsApp Template — Guided Conversational Flow
When the user wants to create a WhatsApp template, call start_create_template first (this also checks the Samvaadik connection — if not connected, relay the redirect prompt and stop). Then guide them through these steps. Collect everything before calling finalize_create_template.

STEP 1 — TEMPLATE TYPE: Ask "Is this a plain text template, or should it have a media header (image/video/document)?"

STEP 2 — BASIC INFO:
Ask for: Template name (required — must be lowercase letters/numbers/underscores only, no spaces; auto-convert what they give you, e.g. "Promo Banner" → "promo_banner"), Category (MARKETING, UTILITY, or AUTHENTICATION), Language (default "en_US" if they don't care).

STEP 3 — BODY:
Ask "What should the message say?" If they want personalized variables (like a name or order number), use {{1}}, {{2}}, etc. in body_text and ask for an example value for each — these go in body_examples in the same order.

STEP 4 — HEADER:
If text-only: skip, header_format stays unset.
If TEXT header: ask for the header_text (short, no variables).
If MEDIA header (IMAGE/VIDEO/DOCUMENT): say "Please attach the image/video/document using the + button." Once they attach a file (you'll see "[Attached: filename]" in their message), set file_name to that filename and file_type to its MIME type inferred from the extension (e.g. .jpg/.jpeg → image/jpeg, .png → image/png, .mp4 → video/mp4, .mov → video/quicktime, .pdf → application/pdf). Do not ask the user for the MIME type directly.

STEP 5 — FOOTER & BUTTONS (optional):
Ask if they want a footer line or up to 3 buttons (QUICK_REPLY or URL). For a URL button with a variable in the link, also collect url_example (a fully resolved sample URL).
IMPORTANT — Meta rejects footer_text and button text containing emoji, newlines, or (for buttons) variables/formatting like *bold*. Never add emoji yourself in footer_text or button text, and if the user includes emoji/newlines in what they type for these two fields, plain-text them out before showing the summary so it matches what's actually submitted. Body text, header text, and URLs may still contain emoji — this restriction is only for footer_text and button text.

STEP 6 — SUMMARY & CONFIRM:
Show a complete summary of name, category, language, body, header (if any), footer (if any), and buttons (if any). Say "Shall I submit this template?" Only call finalize_create_template AFTER the user explicitly confirms.

WHAT HAPPENS NEXT:
- If the result has action_type "template_created" — tell the user the template was submitted to Meta for approval and approval can take a few minutes to a few hours.
- If the result has action_type "template_media_upload_required" — tell the user their media is being uploaded and the template will be submitted automatically once it finishes; the frontend handles the actual upload, you don't need to do anything else.`;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function handleAssistantChat(req, res) {
  try {
    // Kinde auth: user_id comes from req.user (set by authenticateUser middleware)
    const userId = req.user?.user_id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    // Guard: req.body may be undefined if express.json() is not registered
    if (!req.body) {
      return res.status(400).json({
        error:
          "Request body missing. Make sure express.json() middleware is registered in app.js before the assistant route.",
      });
    }

    const {
      message,
      conversationHistory = [],
      csvFileName,
      attachedFiles = [],
    } = req.body;

    if (!message?.trim() && !attachedFiles.length) {
      return res.status(400).json({ error: "message is required" });
    }

    // If user attached files, give Claude context about each one
    let fullMessage = message?.trim() || "";
    const allFiles =
      attachedFiles.length > 0
        ? attachedFiles
        : csvFileName
          ? [{ name: csvFileName }]
          : [];
    if (allFiles.length > 0) {
      const fileDescriptions = allFiles.map((f) => {
        const ext = f.name.split(".").pop().toLowerCase();
        const typeMap = {
          csv: "CSV guest list",
          xlsx: "Excel spreadsheet",
          xls: "Excel spreadsheet",
          pdf: "PDF document",
          doc: "Word document",
          docx: "Word document",
          txt: "text file",
        };
        return `"${f.name}" (${typeMap[ext] || ext} — ${f.size ? Math.round(f.size / 1024) + " KB" : "unknown size"})`;
      });
      fullMessage +=
        (fullMessage ? "\n\n" : "") +
        `[User has attached ${allFiles.length} file(s): ${fileDescriptions.join(", ")}. Use this context to understand what they want to do — e.g. a CSV/Excel file likely means they want to upload a guest list for an event.]`;
    }

    // Parse conversationHistory — frontend sends it as a JSON string or array
    let history = conversationHistory;
    if (typeof conversationHistory === "string") {
      try {
        history = JSON.parse(conversationHistory);
      } catch {
        history = [];
      }
    }

    // Build system prompt with live user context
    const systemPrompt = await buildSystemPrompt(userId);

    // Append new user message
    const messages = [...history, { role: "user", content: fullMessage }];

    // ── Round 1: Send to Claude ───────────────────────────────────────────────
    let pendingAction = null; // set if a tool returns action_type (e.g. redirect)
    let pendingConnectionData = null; // set if samvaadik is connected — sends summary to frontend
    let response = await createMessageWithRetry({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      tools: ASSISTANT_TOOLS,
      messages,
    });

    // ── Handle tool_use (loops until Claude gives a final text reply) ─────────
    while (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (b) => b.type === "tool_use",
      );
      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        let result;
        try {
          result = await executeToolCall(toolUse.name, toolUse.input, userId);
        } catch (err) {
          console.error(
            `[assistant] Tool "${toolUse.name}" error:`,
            err.message,
          );
          result = { success: false, error: err.message };
        }

        // Redirect action (e.g. Samvaadik not connected)
        if (result.action_type === "redirect") {
          pendingAction = {
            type: result.action_type,
            label: result.action_label,
            route: result.action_route,
          };
        }

        // Agent created successfully — send card data to frontend
        if (result.action_type === "agent_created") {
          pendingAction = {
            type: "agent_created",
            agent_id: result.agent_id,
            agent_name: result.agent_name,
            field_mode: result.field_mode,
          };
        }

        // Event created successfully — send card + CSV upload flag to frontend
        if (result.action_type === "event_created") {
          pendingAction = {
            type: "event_created",
            event_id: result.event_id,
            event_name: result.event_name,
            event_date: result.event_date,
            agent_name: result.agent_name,
            needs_csv_upload: result.needs_csv_upload,
            csv_file_name: result.csv_file_name,
          };
        }

        // Event wizard started — send agents list to frontend
        if (result.action_type === "create_event_wizard") {
          pendingAction = {
            type: "create_event_wizard",
            agents: result.agents,
          };
        }

        // Template wizard started
        if (result.action_type === "create_template_wizard") {
          pendingAction = {
            type: "create_template_wizard",
            steps: result.steps,
          };
        }

        // Voice filters gathered — frontend fetches /api/voices itself
        // (same endpoint + same Indian-voice filtering as the manual
        // CreateAgent page) and renders the cards with live previews.
        if (result.action_type === "voice_selection") {
          pendingAction = {
            type: "voice_selection",
            filters: result.filters,
          };
        }

        // Media template — frontend must PUT the file to signed_url, then
        // call POST /api/samvaadik/templates/complete-media-upload with
        // storage_path + the template fields below to finish submission.
        if (result.action_type === "template_media_upload_required") {
          pendingAction = {
            type: "template_media_upload_required",
            signed_url: result.signed_url,
            storage_path: result.storage_path,
            expires_in_seconds: result.expires_in_seconds,
            file_name: result.file_name,
            file_type: result.file_type,
            template: result.template,
          };
        }

        // Text template created (or media template completed) — show card
        if (result.action_type === "template_created") {
          pendingAction = {
            type: "template_created",
            template: result.template,
          };
        }

        // Samvaadik connected — send connection summary card
        if (
          toolUse.name === "get_samvaadik_status" &&
          result.connected === true
        ) {
          pendingConnectionData = {
            connected: true,
            business_phone: result.business_phone,
            wa_id: result.wa_id,
            status: result.status,
            connected_at: result.connected_at,
            webhook_set: result.webhook_set,
          };
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });

      response = await createMessageWithRetry({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        tools: ASSISTANT_TOOLS,
        messages,
      });
    }

    // ── Extract final text reply ──────────────────────────────────────────────
    const reply = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    // Build updated history for next turn
    const updatedHistory = [...messages, { role: "assistant", content: reply }];

    return res.status(200).json({
      reply,
      updatedHistory,
      action: pendingAction,
      connectionData: pendingConnectionData || null,
    });
  } catch (err) {
    console.error("[assistantController] Error:", err);
    const isAnthropicOutage =
      err?.status >= 500 && err?.error?.error?.type === "api_error";
    return res.status(500).json({
      error: isAnthropicOutage
        ? "Claude is experiencing elevated errors right now — this is on Anthropic's end, not Sutrak. Please try again in a moment (status.claude.com has live updates)."
        : "Assistant ran into an error. Please try again.",
      ...(process.env.NODE_ENV === "development" && { details: err.message }),
    });
  }
}
