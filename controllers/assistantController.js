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
- Samvaadik/WhatsApp: check connection status, list templates, send templates to event guests

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
- Use the event/agent names from context above to resolve vague references ("my wedding" → match against the list).
- If something fails, explain in plain language what went wrong and what to do next.
- Never make up data or pretend to do things you haven't done via tools.
- If the user asks for something outside your capabilities, say so briefly.
- Do not mention tool names or internal workings in your responses.`;
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
    let response = await anthropic.messages.create({
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

        // If the tool returned a redirect action (not connected) — send button to frontend
        if (result.action_type === "redirect") {
          pendingAction = {
            type: result.action_type,
            label: result.action_label,
            route: result.action_route,
          };
        }

        // If Samvaadik is connected — send connection summary to frontend for the card
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

      response = await anthropic.messages.create({
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

    return res
      .status(200)
      .json({
        reply,
        updatedHistory,
        action: pendingAction,
        connectionData: pendingConnectionData || null,
      });
  } catch (err) {
    console.error("[assistantController] Error:", err);
    return res.status(500).json({
      error: "Assistant ran into an error. Please try again.",
      ...(process.env.NODE_ENV === "development" && { details: err.message }),
    });
  }
}
