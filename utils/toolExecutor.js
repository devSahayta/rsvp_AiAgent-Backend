// utils/toolExecutor.js
// Maps Claude tool_use calls to actual Sutrak DB operations.
// Uses the REAL Sutrak schema — events, participants, agents, samvaadik_connections.
//
// HOW TO ADD A NEW TOOL:
//   1. Add definition in assistantTools.js
//   2. Add a case here
//   3. Done — nothing else changes

import { supabase } from "../config/supabase.js";
import {
  getTemplates,
  sendTemplate as samvaadikSendTemplate,
  prepareMediaUpload,
  createWhatsappTemplate,
} from "../utils/samvaadikClient.js";

/**
 * @param {string} toolName    - The tool name Claude called
 * @param {object} toolInput   - Parameters Claude extracted from user message
 * @param {string} userId      - Kinde user_id (req.user.user_id)
 * @returns {object}           - Result returned back to Claude
 */
export async function executeToolCall(toolName, toolInput, userId) {
  switch (toolName) {
    // ── Events ──────────────────────────────────────────────────────────────

    case "start_create_event": {
      // Fetch user's agents so Claude can show them for selection
      const { data: agents } = await supabase
        .from("agents")
        .select("agent_id, agent_name, field_mode, status")
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(20);

      return {
        success: true,
        action_type: "create_event_wizard",
        agents: (agents || []).map((a) => ({
          id: a.agent_id,
          name: a.agent_name,
          mode: a.field_mode,
          status: a.status,
        })),
        steps: [
          {
            step: 1,
            title: "Event Name",
            description: "What's the event called?",
          },
          {
            step: 2,
            title: "Event Date",
            description: "When is it happening?",
          },
          {
            step: 3,
            title: "Event Type",
            description: "Category (wedding, conference, etc.)",
          },
          {
            step: 4,
            title: "Assign Agent",
            description: "Pick an agent to handle calls/WhatsApp",
          },
          {
            step: 5,
            title: "Upload CSV",
            description: "Attach participant list (CSV/Excel)",
          },
          {
            step: 6,
            title: "Review & Create",
            description: "Confirm and create the event",
          },
        ],
      };
    }

    case "finalize_create_event": {
      const {
        event_name,
        event_date,
        event_type,
        agent_id,
        agent_name,
        csv_attached,
        csv_file_name,
      } = toolInput;

      // Parse date robustly
      const parsedDate = new Date(event_date);
      if (isNaN(parsedDate.getTime())) {
        return {
          success: false,
          message: `I couldn't understand the date "${event_date}". Please try a format like "August 15, 2026" or "2026-08-15".`,
        };
      }

      // Build the payload exactly as the frontend createEvent page sends it.
      // We call the existing POST /api/events endpoint so createEventWithCsv runs —
      // this handles CSV parsing, participant insert, Supabase Storage upload,
      // elevenlabs_kb_id sync, and everything else the manual UI does.
      // NOTE: The CSV file bytes live in the frontend (attachedFiles state).
      // The assistant cannot hold file bytes — so we create the event here (no CSV),
      // and the frontend's uploadCsvAfterEvent() sends the CSV in a second call.

      const backendUrl = process.env.BACKEND_URL || "http://localhost:5000";

      const payload = {
        user_id: userId,
        event_name,
        event_date: parsedDate.toISOString(),
        event_type: event_type || null,
        agent_id: agent_id || null,
      };

      // Call the real createEvent endpoint (no CSV at this stage — frontend handles that)
      const res = await fetch(`${backendUrl}/api/events/assistant-create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to create event");
      }

      const event = data.data || data.event || data;

      return {
        success: true,
        action_type: "event_created",
        event_id: event.event_id,
        event_name: event.event_name,
        event_date: new Date(event.event_date).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "long",
          year: "numeric",
        }),
        agent_name: agent_name || null,
        csv_attached: csv_attached || false,
        csv_file_name: csv_file_name || null,
        // frontend will upload CSV to POST /api/events/:eventId/upload-csv
        needs_csv_upload: csv_attached === true,
        message: `Event "${event_name}" created successfully!`,
      };
    }

    case "list_events": {
      const { status = "all" } = toolInput;

      let query = supabase
        .from("events")
        .select("event_id, event_name, event_date, status, event_type")
        .eq("user_id", userId)
        .order("event_date", { ascending: true })
        .limit(20);

      if (status !== "all") {
        query = query.eq("status", status);
      }

      const { data, error } = await query;
      if (error) throw new Error(`Failed to fetch events: ${error.message}`);

      return {
        success: true,
        count: data.length,
        events: data.map((e) => ({
          id: e.event_id,
          name: e.event_name,
          date: new Date(e.event_date).toLocaleDateString("en-IN", {
            day: "numeric",
            month: "long",
            year: "numeric",
          }),
          status: e.status,
          type: e.event_type || "Not specified",
        })),
      };
    }

    case "get_event_details": {
      const { event_name, event_id } = toolInput;

      let query = supabase
        .from("events")
        .select(
          `
          event_id, event_name, event_date, status, event_type,
          successful_calls, total_calls_dispatched, total_calls_finished,
          agents ( agent_name, agent_id )
        `,
        )
        .eq("user_id", userId);

      if (event_id) {
        query = query.eq("event_id", event_id);
      } else if (event_name) {
        query = query.ilike("event_name", `%${event_name}%`);
      } else {
        return { success: false, message: "Please specify an event name." };
      }

      const { data, error } = await query.maybeSingle();
      if (error) throw new Error(`Failed to fetch event: ${error.message}`);
      if (!data)
        return {
          success: false,
          message: `No event found matching "${event_name}".`,
        };

      // Get guest count
      const { count } = await supabase
        .from("participants")
        .select("participant_id", { count: "exact", head: true })
        .eq("event_id", data.event_id);

      return {
        success: true,
        event: {
          id: data.event_id,
          name: data.event_name,
          date: new Date(data.event_date).toLocaleDateString("en-IN", {
            day: "numeric",
            month: "long",
            year: "numeric",
          }),
          status: data.status,
          type: data.event_type || "Not specified",
          guest_count: count || 0,
          agent: data.agents ? data.agents.agent_name : "No agent assigned",
          calls_dispatched: data.total_calls_dispatched || 0,
          calls_finished: data.total_calls_finished || 0,
          successful_calls: data.successful_calls || 0,
        },
      };
    }

    // ── Agents ───────────────────────────────────────────────────────────────

    case "list_agents": {
      const { data, error } = await supabase
        .from("agents")
        .select(
          "agent_id, agent_name, agent_description, status, voice_enabled, chat_enabled, is_active, created_at",
        )
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (error) throw new Error(`Failed to fetch agents: ${error.message}`);

      return {
        success: true,
        count: data.length,
        agents: data.map((a) => ({
          id: a.agent_id,
          name: a.agent_name,
          description: a.agent_description || "No description",
          status: a.status,
          voice: a.voice_enabled ? "Yes" : "No",
          whatsapp: a.chat_enabled ? "Yes" : "No",
          active: a.is_active,
        })),
      };
    }

    case "get_agent_details": {
      const { agent_name, agent_id } = toolInput;

      let query = supabase.from("agents").select("*").eq("user_id", userId);

      if (agent_id) {
        query = query.eq("agent_id", agent_id);
      } else if (agent_name) {
        query = query.ilike("agent_name", `%${agent_name}%`);
      } else {
        return { success: false, message: "Please specify an agent name." };
      }

      const { data, error } = await query.maybeSingle();
      if (error) throw new Error(`Failed to fetch agent: ${error.message}`);
      if (!data)
        return {
          success: false,
          message: `No agent found matching "${agent_name}".`,
        };

      return {
        success: true,
        agent: {
          id: data.agent_id,
          name: data.agent_name,
          description: data.agent_description || "None",
          status: data.status,
          voice_enabled: data.voice_enabled,
          chat_enabled: data.chat_enabled,
          field_mode: data.field_mode,
          smart_fields_count: Array.isArray(data.smart_fields)
            ? data.smart_fields.length
            : 0,
          total_calls: data.total_calls,
          total_chats: data.total_chats,
          created_at: new Date(data.created_at).toLocaleDateString("en-IN"),
        },
      };
    }

    // ── Guests ───────────────────────────────────────────────────────────────

    case "get_event_guests": {
      const { event_name, event_id } = toolInput;

      // Resolve event_id from name if needed
      let resolvedEventId = event_id;
      let resolvedEventName = event_name;

      if (!resolvedEventId && event_name) {
        const { data: ev } = await supabase
          .from("events")
          .select("event_id, event_name")
          .eq("user_id", userId)
          .ilike("event_name", `%${event_name}%`)
          .maybeSingle();

        if (!ev)
          return {
            success: false,
            message: `No event found matching "${event_name}".`,
          };
        resolvedEventId = ev.event_id;
        resolvedEventName = ev.event_name;
      }

      if (!resolvedEventId) {
        return { success: false, message: "Please specify an event name." };
      }

      const { data, error } = await supabase
        .from("participants")
        .select("participant_id, full_name, email, phone_number")
        .eq("event_id", resolvedEventId)
        .limit(50);

      if (error) throw new Error(`Failed to fetch guests: ${error.message}`);

      return {
        success: true,
        event: resolvedEventName,
        total_guests: data.length,
        guests: data.map((g) => ({
          name: g.full_name,
          phone: g.phone_number || "Not provided",
          email: g.email || "Not provided",
        })),
        note: data.length === 50 ? "Showing first 50 guests." : null,
      };
    }

    // ── Samvaadik ─────────────────────────────────────────────────────────────

    case "get_samvaadik_status": {
      const { data, error } = await supabase
        .from("samvaadik_connections")
        .select("id, business_phone, wa_id, status, connected_at, webhook_set")
        .eq("user_id", userId)
        .maybeSingle();

      if (error)
        throw new Error(`Failed to check Samvaadik status: ${error.message}`);

      if (!data) {
        return {
          success: true,
          connected: false,
          // action_type tells the frontend to render a redirect button
          action_type: "redirect",
          action_label: "Connect Samvaadik",
          action_route: "/settings/samvaadik",
          message: "not_connected",
        };
      }

      return {
        success: true,
        connected: true,
        business_phone: data.business_phone,
        wa_id: data.wa_id,
        status: data.status,
        webhook_set: data.webhook_set,
        connected_at: new Date(data.connected_at).toLocaleDateString("en-IN"),
      };
    }

    case "list_templates": {
      const { data: conn } = await supabase
        .from("samvaadik_connections")
        .select("api_key, status")
        .eq("user_id", userId)
        .eq("status", "active")
        .maybeSingle();

      if (!conn) {
        return {
          success: false,
          message:
            "No active Samvaadik connection. Please connect your Samvaadik account first via Settings → Integrations.",
        };
      }

      const result = await getTemplates(conn.api_key);

      return {
        success: true,
        count: result.total || 0,
        templates: (result.data || []).map((t) => ({
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
        })),
      };
    }

    case "send_template": {
      const { event_name, event_id, template_name } = toolInput;

      // Check Samvaadik connection
      const { data: conn } = await supabase
        .from("samvaadik_connections")
        .select("api_key, status")
        .eq("user_id", userId)
        .eq("status", "active")
        .maybeSingle();

      if (!conn) {
        return {
          success: false,
          message:
            "No active Samvaadik connection. Connect your Samvaadik account first via Settings → Integrations.",
        };
      }

      // Resolve event
      let resolvedEventId = event_id;
      let resolvedEventName = event_name;

      if (!resolvedEventId && event_name) {
        const { data: ev } = await supabase
          .from("events")
          .select("event_id, event_name")
          .eq("user_id", userId)
          .ilike("event_name", `%${event_name}%`)
          .maybeSingle();

        if (!ev)
          return {
            success: false,
            message: `No event found matching "${event_name}". Please check the event name.`,
          };
        resolvedEventId = ev.event_id;
        resolvedEventName = ev.event_name;
      }

      if (!resolvedEventId) {
        return {
          success: false,
          message:
            "Please specify which event you want to send the template to.",
        };
      }

      // Get guests with phone numbers
      const { data: guests } = await supabase
        .from("participants")
        .select("participant_id, full_name, phone_number")
        .eq("event_id", resolvedEventId)
        .not("phone_number", "is", null);

      if (!guests || guests.length === 0) {
        return {
          success: false,
          message: `No guests with phone numbers found for "${resolvedEventName}". Please upload a guest list first.`,
        };
      }

      // Send via Samvaadik
      const result = await samvaadikSendTemplate(conn.api_key, {
        template_name,
        recipients: guests.map((g) => ({
          phone: g.phone_number,
          name: g.full_name,
        })),
      });

      if (!result.success) {
        return {
          success: false,
          message: `Failed to send template. Make sure "${template_name}" is an approved template in your Samvaadik account.`,
        };
      }

      return {
        success: true,
        sent_to: guests.length,
        event: resolvedEventName,
        template: template_name,
        message: `Template "${template_name}" sent to ${guests.length} guests of "${resolvedEventName}".`,
      };
    }

    // ── Template creation (Samvaadik) ───────────────────────────────────────────

    case "start_create_template": {
      const { data: conn } = await supabase
        .from("samvaadik_connections")
        .select("status")
        .eq("user_id", userId)
        .eq("status", "active")
        .maybeSingle();

      if (!conn) {
        return {
          success: true,
          action_type: "redirect",
          action_label: "Connect Samvaadik",
          action_route: "/settings/samvaadik",
          message: "not_connected",
        };
      }

      return {
        success: true,
        action_type: "create_template_wizard",
        steps: [
          {
            step: 1,
            title: "Template Type",
            description: "Text-only or media (image/video/document) header",
          },
          {
            step: 2,
            title: "Basic Info",
            description: "Name, category and language",
          },
          {
            step: 3,
            title: "Body",
            description: "Message body text and variables",
          },
          {
            step: 4,
            title: "Header / Media",
            description: "Optional header text, or attach image/video/document",
          },
          {
            step: 5,
            title: "Footer & Buttons",
            description: "Optional footer text and up to 3 buttons",
          },
          {
            step: 6,
            title: "Review & Create",
            description: "Confirm and submit to Meta for approval",
          },
        ],
        message: "wizard_started",
      };
    }

    case "finalize_create_template": {
      const {
        name,
        category,
        language = "en_US",
        body_text,
        body_examples,
        header_format,
        header_text,
        file_name,
        file_type,
        footer_text,
        buttons,
      } = toolInput;

      const { data: conn } = await supabase
        .from("samvaadik_connections")
        .select("api_key, status")
        .eq("user_id", userId)
        .eq("status", "active")
        .maybeSingle();

      if (!conn) {
        return {
          success: false,
          action_type: "redirect",
          action_label: "Connect Samvaadik",
          action_route: "/settings/samvaadik",
          message:
            "No active Samvaadik connection. Please connect your Samvaadik account first.",
        };
      }

      const isMediaHeader = ["IMAGE", "VIDEO", "DOCUMENT"].includes(
        header_format,
      );

      // ── Media template — Option A: signed-URL upload flow ────────────────
      // We can't hold the file bytes here (same constraint as CSV uploads),
      // so we only request the signed_url and hand it to the frontend. The
      // frontend PUTs the bytes directly, then calls
      // POST /api/samvaadik/templates/complete-media-upload to finish.
      if (isMediaHeader) {
        if (!file_name || !file_type) {
          return {
            success: false,
            message: `Please attach the ${header_format.toLowerCase()} file for this template before I can continue.`,
          };
        }

        const prepared = await prepareMediaUpload(conn.api_key, {
          file_name,
          file_type,
        });
        if (!prepared.success) {
          return {
            success: false,
            message: "Failed to start the media upload with Samvaadik.",
          };
        }

        return {
          success: true,
          action_type: "template_media_upload_required",
          signed_url: prepared.signed_url,
          storage_path: prepared.storage_path,
          expires_in_seconds: prepared.expires_in_seconds,
          file_name,
          file_type,
          template: {
            name,
            category,
            language,
            body_text,
            body_examples: Array.isArray(body_examples) ? body_examples : [],
            header_format,
            footer_text: footer_text || null,
            buttons: Array.isArray(buttons) ? buttons : [],
          },
          message:
            "Media upload started. Once the file finishes uploading, the template will be submitted automatically.",
        };
      }

      // ── Text-only template (no header, or header_format TEXT) ────────────
      const payload = {
        name,
        category,
        language,
        body_text,
        ...(Array.isArray(body_examples) &&
          body_examples.length > 0 && { body_examples }),
        ...(header_format === "TEXT" && {
          header_format: "TEXT",
          header_text,
        }),
        ...(footer_text && { footer_text }),
        ...(Array.isArray(buttons) && buttons.length > 0 && { buttons }),
      };

      const result = await createWhatsappTemplate(conn.api_key, payload);
      if (!result.success) {
        return {
          success: false,
          message: `Failed to create template "${name}". Make sure the name is unique and all required fields are valid.`,
        };
      }

      return {
        success: true,
        action_type: "template_created",
        template: result.data,
        message:
          result.message ||
          `Template "${name}" submitted to Meta for approval.`,
      };
    }

    // ── Agent creation tools ──────────────────────────────────────────────────

    case "start_create_agent": {
      // Just returns the step structure so Claude can guide the conversation
      return {
        success: true,
        action_type: "create_agent_wizard",
        steps: [
          {
            step: 1,
            title: "Agent Mode",
            description: "Choose Classic or Smart Fields mode",
          },
          {
            step: 2,
            title: "Basic Info",
            description: "Agent name and description",
          },
          {
            step: 3,
            title: "Smart Fields / Template",
            description:
              "Define what data to collect (smart) or pick a template (classic)",
          },
          {
            step: 4,
            title: "Knowledge Base",
            description: "Add event knowledge for the agent",
          },
          {
            step: 5,
            title: "Voice",
            description: "Optionally preview and pick a voice",
          },
          {
            step: 6,
            title: "Review & Create",
            description: "Confirm everything and create the agent",
          },
        ],
        message: "wizard_started",
      };
    }

    case "get_agent_templates": {
      const backendUrl = process.env.BACKEND_URL || "http://localhost:5000";
      const response = await fetch(`${backendUrl}/api/agent-system/templates`);
      const data = await response.json();
      if (!data.success)
        return { success: false, message: "Failed to fetch templates" };
      return {
        success: true,
        templates: (data.data || []).map((t) => ({
          template_id: t.template_id,
          name: t.name,
          category: t.category,
          description: t.description,
        })),
      };
    }

    case "get_knowledge_bases": {
      const { field_mode } = toolInput; // pass this in from assistantTools.js schema
      let query = supabase
        .from("knowledge_bases")
        .select("id, name, elevenlabs_kb_id, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(10);
      const { data: kbs, error } = await query;

      if (error)
        throw new Error(`Failed to fetch knowledge bases: ${error.message}`);
      const usable =
        field_mode === "classic"
          ? kbs.filter((k) => !!k.elevenlabs_kb_id)
          : kbs;
      return {
        success: true,
        count: usable.length,
        knowledge_bases: usable.map((k) => ({ id: k.id, name: k.name })),
      };
    }

    // ── Voice selection ─────────────────────────────────────────────────────
    // The frontend VoiceSelectionCard fetches /api/voices itself — same
    // endpoint, same params, same Indian-voice filtering the manual
    // CreateAgent page's VoiceSelector.jsx uses — so results are guaranteed
    // identical to the manual flow. This tool only passes the filters
    // Claude gathered from the conversation through to the UI.
    case "get_voice_options": {
      const { gender, search } = toolInput;
      return {
        success: true,
        action_type: "voice_selection",
        filters: {
          gender: gender || null,
          search: search || null,
        },
        message: "Voice options ready — shown below.",
      };
    }

    case "finalize_create_agent": {
      const {
        agent_name,
        agent_description = "",
        field_mode,
        template_id,
        event_title,
        first_message,
        kb_name,
        kb_content,
        kb_id,
        smart_fields = [],
        voice_id,
        voice_name,
        public_owner_id,
      } = toolInput;

      const backendUrl = process.env.BACKEND_URL || "http://localhost:5000";

      // Step A: Create or reuse knowledge base
      let knowledgeBaseId = kb_id || null;

      if (!knowledgeBaseId) {
        if (!kb_name || !kb_content) {
          return {
            success: false,
            message: "Knowledge base name and content are required.",
          };
        }

        const kbRes = await fetch(`${backendUrl}/api/knowledge-bases`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: userId,
            name: kb_name,
            content: kb_content,
            field_mode,
          }),
        });
        const kbData = await kbRes.json();
        if (!kbData.success) {
          return {
            success: false,
            message: `Failed to create knowledge base: ${kbData.error}`,
          };
        }
        knowledgeBaseId = kbData.data.id;
      }

      // Step B: Create agent
      let agentPayload = {
        user_id: userId,
        agent_name,
        agent_description,
        knowledge_base_id: knowledgeBaseId,
        field_mode,
        voice_id: voice_id || null,
        voice_name: voice_name || null,
        public_owner_id: public_owner_id || null,
      };

      if (field_mode === "classic") {
        if (!template_id)
          return {
            success: false,
            message: "Template is required for classic mode.",
          };
        agentPayload.template_id = template_id;
        agentPayload.event_title = event_title || null;
      } else {
        // smart_fields mode
        agentPayload.event_title = event_title || "";
        agentPayload.first_message =
          first_message || "Hey! How can I help you today?";
        // Normalize field shape to exactly what the DB + ElevenLabs agent expects.
        // Claude may pass 'required' but DB column is 'is_required'.
        // Ensure all keys are present and correctly named.
        const cleanFields = (smart_fields || []).map((f, i) => ({
          field_label: f.field_label || f.label || "",
          field_key: (f.field_key || f.field_label || f.label || "")
            .toLowerCase()
            .trim()
            .replace(/\s+/g, "_")
            .replace(/[^a-z0-9_]/g, ""),
          field_type: f.field_type || "text",
          ai_question: f.ai_question || f.question || "",
          is_required: f.is_required ?? f.required ?? false, // normalize required → is_required
          options: Array.isArray(f.options) ? f.options : [],
          display_order: i,
        }));
        agentPayload.smart_fields = cleanFields;
      }

      const agentRes = await fetch(`${backendUrl}/api/agent-system/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(agentPayload),
      });
      const agentData = await agentRes.json();

      if (!agentData.success) {
        return {
          success: false,
          message: `Failed to create agent: ${agentData.error}`,
        };
      }

      return {
        success: true,
        action_type: "agent_created",
        agent_id: agentData.data?.agent_id || agentData.data?.id,
        agent_name,
        field_mode,
        message: `Agent "${agent_name}" created successfully!`,
      };
    }

    default:
      return { success: false, message: `Unknown tool: ${toolName}` };
  }
}
