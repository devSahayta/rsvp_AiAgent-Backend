// utils/assistantTools.js
// Tool definitions passed to Claude API.
// Claude reads descriptions to decide which tool to call.
// Add new tools here as Sutrak grows — no other file needs changing.

const ASSISTANT_TOOLS = [
  // ── Events ──────────────────────────────────────────────────────────────
  {
    name: "start_create_event",
    description:
      "Start the guided event creation flow. Use when the user wants to create, add, or set up a new event. This initiates the step-by-step wizard to collect event name, date, agent assignment, and participant CSV.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "finalize_create_event",
    description:
      "Create the event once the user has confirmed all details. Only call this AFTER the user approves the summary. Handles event creation + participant upload in one call.",
    input_schema: {
      type: "object",
      properties: {
        event_name: { type: "string", description: "Name of the event" },
        event_date: {
          type: "string",
          description:
            "Date of the event e.g. '2026-08-15' or 'August 15 2026'",
        },
        event_type: {
          type: "string",
          description:
            "Type of event e.g. wedding, conference, birthday (optional)",
        },
        agent_id: {
          type: "string",
          description: "UUID of the agent to assign to this event (optional)",
        },
        agent_name: {
          type: "string",
          description: "Name of the selected agent (for display only)",
        },
        csv_attached: {
          type: "boolean",
          description: "Whether the user attached a CSV file for participants",
        },
        csv_file_name: {
          type: "string",
          description: "The CSV filename attached by the user (if any)",
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

  // ── Agent creation — multi-step guided flow ──────────────────────────────────
  {
    name: "start_create_agent",
    description:
      "Start the guided agent creation flow. Use when the user wants to create a new agent, build an agent, or set up a new AI agent. This initiates the step-by-step wizard.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_agent_templates",
    description:
      "Fetch available agent templates for classic mode. Use when the user has chosen classic mode and needs to pick a template.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_knowledge_bases",
    description:
      "Fetch the user's existing knowledge bases so they can reuse one instead of creating new. Use during the knowledge base step of agent creation.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "finalize_create_agent",
    description:
      "Create the agent once the user has confirmed all details in the summary. Only call this after the user explicitly approves the summary. This calls the actual API to create the agent.",
    input_schema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Name of the agent" },
        agent_description: {
          type: "string",
          description: "Description of the agent",
        },
        field_mode: {
          type: "string",
          enum: ["classic", "smart_fields"],
          description: "Agent mode",
        },
        template_id: {
          type: "string",
          description: "Template UUID for classic mode",
        },
        event_title: {
          type: "string",
          description:
            "Event title for smart_fields mode (e.g. Wedding of X and Y)",
        },
        first_message: {
          type: "string",
          description:
            "Opening message the agent sends. Optional for smart_fields mode.",
        },
        kb_name: { type: "string", description: "Name for the knowledge base" },
        kb_content: {
          type: "string",
          description: "Content/text for the knowledge base",
        },
        kb_id: {
          type: "string",
          description: "Existing knowledge base UUID if reusing one",
        },
        smart_fields: {
          type: "array",
          description: "Array of smart fields for smart_fields mode",
          items: {
            type: "object",
            properties: {
              field_label: {
                type: "string",
                description: "Human readable label e.g. 'RSVP Status'",
              },
              field_key: {
                type: "string",
                description:
                  "Snake_case key auto-derived from label e.g. 'rsvp_status'",
              },
              field_type: {
                type: "string",
                enum: ["yes_no", "number", "text", "choice"],
                description: "Type of the field",
              },
              ai_question: {
                type: "string",
                description: "The exact question the AI will ask the guest",
              },
              is_required: {
                type: "boolean",
                description: "Whether this field is mandatory",
              },
              options: {
                type: "array",
                items: { type: "string" },
                description: "Options for choice type fields",
              },
              display_order: {
                type: "number",
                description: "Order in which the field is asked (0-indexed)",
              },
            },
          },
        },
      },
      required: ["agent_name", "field_mode", "kb_name", "kb_content"],
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
