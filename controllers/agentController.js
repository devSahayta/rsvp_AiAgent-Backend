import {
  getAgent,
  duplicateAgent,
  updateAgent,
  deleteAgent,
} from "../utils/elevenlabsApi.js";
import { supabase } from "../config/supabase.js";

export const getAgentConfig = async (req, res) => {
  try {
    const { agentId } = req.params;
    const agent = await getAgent(agentId);
    res.json(agent);
  } catch (err) {
    console.error(" Get agent error:", err.response?.data || err.message);
    res.status(500).json({ message: "Failed to fetch agent" });
  }
};

export const duplicateAgentForEvent = async (req, res) => {
  try {
    const { event_id, base_agent_id, knowledge_base_ids } = req.body;

    if (!event_id || !base_agent_id || !knowledge_base_ids) {
      return res.status(400).json({
        error: "event_id, base_agent_id and knowledge_base_id are required",
      });
    }

    // 1️⃣ Fetch base agent
    const baseAgent = await getAgent(base_agent_id);

    // 2️⃣ Duplicate agent
    const duplicated = await duplicateAgent({
      agentId: base_agent_id,
      name: `event-agent-${event_id}`,
    });

    // 3️⃣ Build knowledge_base array
    const knowledge_base = knowledge_base_ids.map((kb) => ({
      type: kb.type, // "file" | "text"
      id: kb.elevenlabs_kb_id,
      name: kb.name,
      usage_mode: "auto",
    }));

    // 4️⃣ Inject KB into full config
    const updatedPayload = {
      ...duplicated,
      conversation_config: {
        ...duplicated.conversation_config,
        agent: {
          ...duplicated.conversation_config.agent,
          prompt: {
            ...duplicated.conversation_config.agent.prompt,
            knowledge_base,
          },
        },
      },
    };

    // 5️⃣ PATCH full agent
    await updateAgent({
      agentId: duplicated.agent_id,
      payload: updatedPayload,
    });

    // 6️⃣ Save agent to event
    await supabase
      .from("events")
      .update({
        elevenlabs_agent_id: duplicated.agent_id,
        knowledge_base_id: knowledge_base_ids[0]?.id || null,
      })
      .eq("id", event_id);

    res.json({
      agent_id: duplicated.agent_id,
      message: "Agent duplicated and knowledge base attached",
    });
  } catch (err) {
    console.error(" Duplicate agent error:", err.response?.data || err.message);
    res.status(500).json({ message: "Failed to duplicate agent" });
  }
};

export const updateAgentKnowledgeBase = async (req, res) => {
  try {
    const { agentId } = req.params;
    const { knowledge_base } = req.body;

    const agent = await getAgent(agentId);

    const updatedPayload = {
      ...agent,
      conversation_config: {
        ...agent.conversation_config,
        agent: {
          ...agent.conversation_config.agent,
          prompt: {
            ...agent.conversation_config.agent.prompt,
            knowledge_base,
          },
        },
      },
    };

    await updateAgent({ agentId, payload: updatedPayload });

    res.json({ message: "Knowledge base updated" });
  } catch (err) {
    console.error(" Update KB error:", err.response?.data || err.message);
    res.status(500).json({ message: "Failed to update knowledge base" });
  }
};

export const deleteAgentById = async (req, res) => {
  try {
    const { agentId } = req.params;

    await deleteAgent(agentId);

    res.json({ message: "Agent deleted" });
  } catch (err) {
    console.error(" Delete agent error:", err.response?.data || err.message);
    res.status(500).json({ message: "Failed to delete agent" });
  }
};
