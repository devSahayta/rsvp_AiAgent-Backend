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

    case "create_event": {
      const { event_name, event_date, event_type } = toolInput;

      // Parse date — accept natural language or ISO
      const parsedDate = new Date(event_date);
      if (isNaN(parsedDate.getTime())) {
        return {
          success: false,
          message: `I couldn't understand the date "${event_date}". Try something like "July 20, 2026" or "2026-07-20".`,
        };
      }

      const { data, error } = await supabase
        .from("events")
        .insert([
          {
            user_id: userId,
            event_name,
            event_date: parsedDate.toISOString(),
            event_type: event_type || null,
            status: "Upcoming",
          },
        ])
        .select("event_id, event_name, event_date, status")
        .single();

      if (error) throw new Error(`Failed to create event: ${error.message}`);

      return {
        success: true,
        event_id: data.event_id,
        event_name: data.event_name,
        event_date: data.event_date,
        message: `Event "${data.event_name}" created successfully.`,
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

    // ── create_template — uncomment when colleague's API is ready ──
    // case "create_template": { ... }

    default:
      return { success: false, message: `Unknown tool: ${toolName}` };
  }
}
