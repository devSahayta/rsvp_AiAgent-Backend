// utils/assistantTools.js
// Tool definitions passed to Claude API.
// Claude reads descriptions to decide which tool to call.
// Add new tools here as Sutrak grows — no other file needs changing.

const ASSISTANT_TOOLS = [
  // ── Events ──────────────────────────────────────────────────────────────
  {
    name: "create_event",
    description:
      "Create a new event in Sutrak. Use when the user wants to create, add, or set up an event. Ask for name and date if not provided.",
    input_schema: {
      type: "object",
      properties: {
        event_name: {
          type: "string",
          description: "The name or title of the event",
        },
        event_date: {
          type: "string",
          description:
            "The date/time of the event e.g. '2026-07-20' or 'July 20'",
        },
        event_type: {
          type: "string",
          description:
            "Type of event e.g. wedding, conference, birthday (optional)",
        },
      },
      required: ["event_name", "event_date"],
    },
  },
  {
    name: "list_events",
    description:
      "List all events belonging to the current user. Use when the user asks to see, show, or list their events.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["Upcoming", "Ongoing", "Completed", "all"],
          description: "Filter by status. Defaults to all.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_event_details",
    description:
      "Get full details of a specific event including guest count and agent info. Use when user asks about a specific event.",
    input_schema: {
      type: "object",
      properties: {
        event_name: {
          type: "string",
          description: "The name of the event (partial match is fine)",
        },
        event_id: { type: "string", description: "UUID of the event if known" },
      },
      required: [],
    },
  },

  // ── Agents ───────────────────────────────────────────────────────────────
  {
    name: "list_agents",
    description:
      "List all AI agents created by the current user. Use when the user asks to see or show their agents.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_agent_details",
    description:
      "Get full details of a specific agent including smart fields, voice settings, and WhatsApp settings.",
    input_schema: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "The name of the agent (partial match is fine)",
        },
        agent_id: { type: "string", description: "UUID of the agent if known" },
      },
      required: [],
    },
  },

  // ── Guests / Participants ─────────────────────────────────────────────────
  {
    name: "get_event_guests",
    description:
      "Get the list of guests/participants for a specific event. Use when user asks about guests, attendees, or who is invited.",
    input_schema: {
      type: "object",
      properties: {
        event_name: {
          type: "string",
          description: "The name of the event (partial match is fine)",
        },
        event_id: { type: "string", description: "UUID of the event if known" },
      },
      required: [],
    },
  },

  // ── Samvaadik ─────────────────────────────────────────────────────────────
  {
    name: "get_samvaadik_status",
    description:
      "Check whether the user has connected their Samvaadik (WhatsApp) account. Use when the user asks about their WhatsApp connection, Samvaadik connection, integration status, or wants to connect/setup WhatsApp. Also use this BEFORE calling list_templates or send_template to verify the connection exists.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "list_templates",
    description:
      "List all available WhatsApp message templates from the user's connected Samvaadik account. Use when user asks to see or show templates.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "send_template",
    description:
      "Send a WhatsApp template message to all guests of a specific event via Samvaadik. Always confirm the event and template before sending.",
    input_schema: {
      type: "object",
      properties: {
        event_name: {
          type: "string",
          description:
            "The name of the event to send the template to (partial match)",
        },
        event_id: { type: "string", description: "UUID of the event if known" },
        template_name: {
          type: "string",
          description: "The exact name of the WhatsApp template to send",
        },
      },
      required: ["template_name"],
    },
  },

  // ── create_template — uncomment when your colleague finishes the Samvaadik API ──
  // {
  //   name: "create_template",
  //   description: "Create a new WhatsApp message template in Samvaadik.",
  //   input_schema: {
  //     type: "object",
  //     properties: {
  //       name: { type: "string", description: "Template name (lowercase, underscores)" },
  //       body: { type: "string", description: "The message body text" },
  //       category: { type: "string", enum: ["MARKETING", "UTILITY", "AUTHENTICATION"] },
  //     },
  //     required: ["name", "body", "category"],
  //   },
  // },
];

export default ASSISTANT_TOOLS;
