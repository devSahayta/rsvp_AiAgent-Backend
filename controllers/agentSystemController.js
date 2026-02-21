// controllers/agentController.js
import { supabase } from "../config/supabase.js";
import {
  getAgent,
  duplicateAgent,
  updateAgent,
  deleteAgent,
} from "../utils/elevenlabsApi.js";
/**
 * GET /api/agents/templates
 * Get all available agent templates
 */
export const getAgentTemplates = async (req, res) => {
  try {
    const { data: templates, error } = await supabase
      .from("agent_templates")
      .select("*")
      .eq("is_active", true)
      .eq("is_public", true)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data: templates,
    });
  } catch (error) {
    console.error("Error fetching agent templates:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

/**
 * GET /api/agents/templates/:template_id
 * Get single agent template with full details
 */
export const getAgentTemplate = async (req, res) => {
  try {
    const { template_id } = req.params;

    const { data: template, error } = await supabase
      .from("agent_templates")
      .select("*")
      .eq("template_id", template_id)
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: template,
    });
  } catch (error) {
    console.error("Error fetching agent template:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

/**
 * POST /api/agents/create
 * Create new agent from template
 */
export const createAgent = async (req, res) => {
  const BASE_AGENTS = {
    wedding: "agent_4101k6yqrwh1e2ysgw5fvtzbb0qw",
  };

  try {
    const {
      user_id,
      template_id,
      agent_name,
      agent_description,
      knowledge_base_id,
    } = req.body;

    // Validate required fields
    if (!user_id || !template_id || !agent_name) {
      return res.status(400).json({
        success: false,
        error: "user_id, template_id, and agent_name are required",
      });
    }

    // Verify template exists
    const { data: template, error: templateError } = await supabase
      .from("agent_templates")
      .select("*")
      .eq("template_id", template_id)
      .single();

    if (templateError || !template) {
      return res.status(404).json({
        success: false,
        error: "Agent template not found",
      });
    }

    //A) Fetch KB from DB
    const { data: kb, error: kbError } = await supabase
      .from("knowledge_bases")
      .select("*")
      .eq("id", knowledge_base_id)
      .single();

    if (kbError || !kb) {
      return res.status(400).json({ error: "Invalid knowledge base" });
    }

    //B) Duplicate agent
    const baseAgentId = "agent_4101k6yqrwh1e2ysgw5fvtzbb0qw";

    if (!baseAgentId) {
      return res.status(400).json({ error: "Invalid Event Type" });
    }

    const duplicatedAgent = await duplicateAgent({
      agentId: baseAgentId,
      name: `${agent_name} Agent`,
    });

    //C) Get duplicated agent config
    const agentConfig = await getAgent(duplicatedAgent.agent_id);

    //D) Inject TEXT knowledge base
    agentConfig.conversation_config.agent.prompt.knowledge_base = [
      {
        type: "text",
        id: kb.elevenlabs_kb_id,
        name: kb.name,
        usage_mode: "auto",
      },
    ];

    //E) Update agent (PATCH)
    await updateAgent({
      agentId: duplicatedAgent.agent_id,
      payload: agentConfig,
    });

    // Create agent
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .insert({
        user_id,
        template_id,
        agent_name,
        agent_description,
        knowledge_base_id,
        elevenlabs_agent_id: duplicatedAgent.agent_id,
        status: "unassigned",
      })
      .select(
        `
        *,
        agent_templates (
          name,
          slug,
          icon_url,
          config
        ),
        knowledge_bases (
          id,
          name
        )
      `,
      )
      .single();

    if (agentError) throw agentError;

    res.status(201).json({
      success: true,
      data: agent,
    });
  } catch (error) {
    console.error("Error creating agent:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

/**
 * GET /api/agents/user/:user_id
 * Get all agents for a user
 */
export const getUserAgents = async (req, res) => {
  try {
    const { user_id } = req.params;

    const { data: agents, error } = await supabase
      .from("agents")
      .select(
        `
        *,
        agent_templates (
          name,
          slug,
          icon_url,
          category
        ),
        knowledge_bases (
          name
        )
      `,
      )
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data: agents,
    });
  } catch (error) {
    console.error("Error fetching user agents:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

/**
 * GET /api/agents/:agent_id
 * Get single agent details
 */
export const getAgentDetails = async (req, res) => {
  try {
    const { agent_id } = req.params;

    const { data: agent, error } = await supabase
      .from("agents")
      .select(
        `
        *,
        agent_templates (
          name,
          slug,
          description,
          category,
          icon_url,
          cover_image_url,
          config
        ),
        knowledge_bases (
          id,
          name,
          elevenlabs_kb_id
        )
      `,
      )
      .eq("agent_id", agent_id)
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: agent,
    });
  } catch (error) {
    console.error("Error fetching agent details:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

/**
 * DELETE /api/agents/:agent_id
 * Rule:
 * - If linked to events → SHOW WARNING (DO NOT DELETE)
 * - If not linked → Safe delete (Agent + KB cleanup)
 */
export const deleteAgentComplete = async (req, res) => {
  try {
    const { agent_id } = req.params;

    if (!agent_id) {
      return res.status(400).json({
        success: false,
        error: "agent_id is required",
      });
    }

    // 1️⃣ Check if agent exists
    const { data: agent, error: agentFetchError } = await supabase
      .from("agents")
      .select("agent_id, knowledge_base_id, agent_name")
      .eq("agent_id", agent_id)
      .single();

    if (agentFetchError || !agent) {
      return res.status(404).json({
        success: false,
        error: "Agent not found",
      });
    }

    // 2️⃣ Check if agent is linked to any events (VERY IMPORTANT - DO THIS BEFORE ANY DELETE)
    const { data: linkedEvents, error: eventCheckError } = await supabase
      .from("events")
      .select("event_id, event_name")
      .eq("agent_id", agent_id);

    if (eventCheckError) throw eventCheckError;

    const linkedEventCount = linkedEvents?.length || 0;

    // 🚨 3️⃣ MAIN RULE: IF LINKED → DO NOT DELETE
    if (linkedEventCount > 0) {
      return res.status(200).json({
        success: false,
        warning: true,
        message: `Are you sure to delete this agent? It is linked with ${linkedEventCount} event(s).`,
        data: {
          agent_name: agent.agent_name,
          linked_events_count: linkedEventCount,
          linked_events: linkedEvents,
        },
      });
    }

    // 4️⃣ Safe to delete Knowledge Base (ONLY if NOT linked)
    if (agent.knowledge_base_id) {
      const kbId = agent.knowledge_base_id;

      // 4a️⃣ Delete knowledge entries first (child table)
      const { error: entriesDeleteError } = await supabase
        .from("knowledge_entries")
        .delete()
        .eq("knowledge_base_id", kbId);

      if (entriesDeleteError) throw entriesDeleteError;

      // 4b️⃣ Delete knowledge base
      const { error: kbDeleteError } = await supabase
        .from("knowledge_bases")
        .delete()
        .eq("id", kbId);

      if (kbDeleteError) throw kbDeleteError;
    }

    // 5️⃣ Finally delete the agent (since it is NOT linked)
    const { error: agentDeleteError } = await supabase
      .from("agents")
      .delete()
      .eq("agent_id", agent_id);

    if (agentDeleteError) throw agentDeleteError;

    return res.status(200).json({
      success: true,
      message: "Agent deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting agent:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}; 