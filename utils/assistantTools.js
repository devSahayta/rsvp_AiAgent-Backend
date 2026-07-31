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
      "Fetch the user's existing knowledge bases so they can reuse one instead of creating new. Use during the knowledge base step of agent creation. Always pass the field_mode chosen earlier in this flow (classic or smart_fields) so only compatible knowledge bases are shown.",
    input_schema: {
      type: "object",
      properties: {
        field_mode: {
          type: "string",
          enum: ["classic", "smart_fields"],
          description:
            "The agent mode chosen in Step 1 of this creation flow. Classic mode requires knowledge bases registered with ElevenLabs — smart_fields mode doesn't.",
        },
      },
      required: ["field_mode"],
    },
  },
  {
    name: "get_voice_options",
    description:
      "Fetch a list of available Indian voices for the agent, with audio previews the user can listen to before choosing. Use during the voice selection step of agent creation, after the knowledge base step. Only call this if the user wants to browse/pick a specific voice — if they say 'skip' or 'use default', don't call this at all. Can be called again with different filters if the user wants to see more/different options.",
    input_schema: {
      type: "object",
      properties: {
        gender: {
          type: "string",
          enum: ["male", "female"],
          description: "Optional filter by voice gender",
        },
        search: {
          type: "string",
          description:
            "Optional search term if the user names a voice or describes a style directly (e.g. 'deep male voice', 'Neha')",
        },
      },
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
                enum: [
                  "yes_no",
                  "number",
                  "text",
                  "choice",
                  "document",
                  "travel_ticket",
                ],
                description:
                  "Type of the field. document = collect a file via WhatsApp (e.g. ID proof), skipped on voice calls. travel_ticket = agent automatically asks for arrival and return tickets via WhatsApp with auto-extraction, skipped on voice calls.",
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
        voice_id: {
          type: "string",
          description:
            "ElevenLabs voice_id of the voice the user selected via get_voice_options. Omit entirely if the user skipped voice selection.",
        },
        voice_name: {
          type: "string",
          description:
            "Display name of the selected voice (from get_voice_options results). Omit if voice was skipped.",
        },
        public_owner_id: {
          type: "string",
          description:
            "public_owner_id of the selected shared voice (from get_voice_options results). Required alongside voice_id so the voice can be imported. Omit if voice was skipped.",
        },
      },
      required: ["agent_name", "field_mode", "kb_name", "kb_content"],
    },
  },

  // ── Template creation — multi-step guided flow ───────────────────────────────
  {
    name: "start_create_template",
    description:
      "Start the guided WhatsApp template creation flow. Use when the user wants to create a new WhatsApp message template via Samvaadik. Checks the Samvaadik connection first.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "finalize_create_template",
    description:
      "Create the WhatsApp template once the user has confirmed all details in the summary. Only call this after the user explicitly approves the summary. For TEXT-only templates (no header_format, or header_format TEXT) this submits the template directly to Samvaadik. For media templates (header_format IMAGE/VIDEO/DOCUMENT) this instead starts the media upload flow — the result will ask the user to attach/confirm the media file before the template is actually submitted.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Template name — lowercase letters, numbers and underscores only, no spaces (e.g. 'promo_banner_1').",
        },
        category: {
          type: "string",
          enum: ["MARKETING", "UTILITY", "AUTHENTICATION"],
          description: "Template category",
        },
        language: {
          type: "string",
          description: "Template language code. Defaults to 'en_US'.",
        },
        body_text: {
          type: "string",
          description:
            "The message body. Use {{1}}, {{2}}, etc. for variables, e.g. 'Hi {{1}}, your order {{2}} is confirmed.'",
        },
        body_examples: {
          type: "array",
          items: { type: "string" },
          description:
            "Example values for each {{n}} variable in body_text, in order. Required when body_text contains variables.",
        },
        header_format: {
          type: "string",
          enum: ["TEXT", "IMAGE", "VIDEO", "DOCUMENT"],
          description:
            "Optional header type. Omit entirely for a plain text-body template.",
        },
        header_text: {
          type: "string",
          description: "Header text. Required only when header_format is TEXT.",
        },
        file_name: {
          type: "string",
          description:
            "Filename of the media the user attached. Required when header_format is IMAGE, VIDEO or DOCUMENT.",
        },
        file_type: {
          type: "string",
          description:
            "MIME type of the attached media, e.g. 'image/jpeg', 'video/mp4'. Required when header_format is IMAGE, VIDEO or DOCUMENT.",
        },
        footer_text: {
          type: "string",
          description: "Optional small footer text shown below the body.",
        },
        buttons: {
          type: "array",
          description: "Optional buttons, max 3.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["QUICK_REPLY", "URL"],
              },
              text: { type: "string" },
              url: {
                type: "string",
                description: "Required when type is URL. May include {{1}}.",
              },
              url_example: {
                type: "string",
                description:
                  "Required when the url contains a {{1}} variable — a fully resolved example URL.",
              },
            },
          },
        },
      },
      required: ["name", "category", "language", "body_text"],
    },
  },
];

export default ASSISTANT_TOOLS;
