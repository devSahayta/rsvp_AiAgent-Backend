import {
  createTextKnowledgeBase,
  deleteElevenLabsKB,
  listElevenLabsKB,
  getAgent,
  updateAgent,
} from "../utils/elevenlabsApi.js";
import { supabase } from "../config/supabase.js";
import { error } from "pdf-lib";

export const createKnowledgeBase = async (req, res) => {
  try {
    const { user_id, name, content, field_mode = "classic" } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "Invalid credential",
      });
    }

    if (!name || !content) {
      return res.status(400).json({
        success: false,
        error: "Name and content are required",
      });
    }

    // Classic: create in ElevenLabs and store the returned ID.
    // Smart fields: skip ElevenLabs, elevenlabs_kb_id stays null.
    let elevenlabs_kb_id = null;
    if (field_mode === "classic") {
      const elKb = await createTextKnowledgeBase({ name, text: content });
      elevenlabs_kb_id = elKb.id;
    }

    const { data: kb, error } = await supabase
      .from("knowledge_bases")
      .insert({
        user_id,
        name,
        elevenlabs_kb_id,
      })
      .select()
      .single();

    if (error) throw error;

    await supabase.from("knowledge_entries").insert({
      knowledge_base_id: kb.id,
      content,
    });

    res.json({
      success: true,
      data: kb,
      message: "Knowledge base created successfully",
    });
  } catch (err) {
    console.error("❌ Create KB error:", err);
    res.status(500).json({
      success: false,
      error: err.message || "Failed to create knowledge base",
    });
  }
};

export const listKnowledgeBases = async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }

    const { data } = await supabase
      .from("knowledge_bases")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    res.json(data);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to fetch knowledge bases", error: err });
  }
};

export const getKnowledgeBase = async (req, res) => {
  try {
    const { id } = req.params;

    const { data: kb } = await supabase
      .from("knowledge_bases")
      .select(
        `
      *,
      knowledge_entries (content)
    `
      )
      .eq("id", id)
      .single();

    res.json(kb);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch knowledge bases content",
      error: error,
    });
  }
};

export const getKBContentForAgent = async (req, res) => {
  try {
    const { knowledge_base_id } = req.query;

    if (!knowledge_base_id) {
      return res.status(400).json({
        success: false,
        error: "knowledge_base_id is required",
      });
    }

    const { data: entries, error } = await supabase
      .from("knowledge_entries")
      .select("content")
      .eq("knowledge_base_id", knowledge_base_id);

    if (error) throw error;

    if (!entries || entries.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No content found for the given knowledge_base_id",
      });
    }

    const content = entries.map((e) => e.content).join("\n\n");

    res.json({ success: true, content });
  } catch (err) {
    console.error("❌ Get KB content for agent error:", err);
    res.status(500).json({
      success: false,
      error: err.message || "Failed to fetch knowledge base content",
    });
  }
};

/**
 * PUT /api/knowledge-bases/:id
 * Updates name/content in place. ElevenLabs text KB documents are immutable,
 * so for classic agents (elevenlabs_kb_id set) we create a fresh ElevenLabs
 * doc, re-point any linked classic agent(s) at it, then delete the stale doc.
 */
export const updateKnowledgeBase = async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id, name, content } = req.body;

    if (!user_id) {
      return res.status(400).json({ success: false, error: "user_id is required" });
    }
    if (!name || !content) {
      return res.status(400).json({
        success: false,
        error: "Name and content are required",
      });
    }

    const { data: kb, error: kbError } = await supabase
      .from("knowledge_bases")
      .select("*")
      .eq("id", id)
      .eq("user_id", user_id)
      .single();

    if (kbError || !kb) {
      return res.status(404).json({ success: false, error: "Knowledge base not found" });
    }

    let elevenlabs_kb_id = kb.elevenlabs_kb_id;

    if (kb.elevenlabs_kb_id) {
      const newDoc = await createTextKnowledgeBase({ name, text: content });
      const staleElevenlabsKbId = kb.elevenlabs_kb_id;
      elevenlabs_kb_id = newDoc.id;

      const { data: linkedAgents } = await supabase
        .from("agents")
        .select("agent_id, elevenlabs_agent_id")
        .eq("knowledge_base_id", id)
        .eq("field_mode", "classic");

      for (const linkedAgent of linkedAgents || []) {
        if (!linkedAgent.elevenlabs_agent_id) continue;
        try {
          const agentConfig = await getAgent(linkedAgent.elevenlabs_agent_id);
          // GET returns both legacy inline `tools` and `tool_ids`; PATCH
          // rejects having both (see agentSystemController.js createAgent()).
          delete agentConfig.conversation_config.agent.prompt.tools;
          agentConfig.conversation_config.agent.prompt.knowledge_base = [
            { type: "text", id: elevenlabs_kb_id, name, usage_mode: "auto" },
          ];
          await updateAgent({
            agentId: linkedAgent.elevenlabs_agent_id,
            payload: agentConfig,
          });
        } catch (syncErr) {
          console.error(
            `⚠️ Failed to re-point agent ${linkedAgent.agent_id} at new KB doc:`,
            syncErr.response?.data || syncErr.message,
          );
        }
      }

      try {
        await deleteElevenLabsKB(staleElevenlabsKbId);
      } catch (cleanupErr) {
        console.warn(
          "⚠️ Failed to delete stale ElevenLabs KB doc:",
          cleanupErr.response?.data || cleanupErr.message,
        );
      }
    }

    const { data: updatedKb, error: updateError } = await supabase
      .from("knowledge_bases")
      .update({ name, elevenlabs_kb_id, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (updateError) throw updateError;

    const { data: existingEntries } = await supabase
      .from("knowledge_entries")
      .select("id")
      .eq("knowledge_base_id", id);

    if (existingEntries?.length) {
      await supabase
        .from("knowledge_entries")
        .update({ content })
        .eq("id", existingEntries[0].id);

      if (existingEntries.length > 1) {
        await supabase
          .from("knowledge_entries")
          .delete()
          .in(
            "id",
            existingEntries.slice(1).map((e) => e.id),
          );
      }
    } else {
      await supabase
        .from("knowledge_entries")
        .insert({ knowledge_base_id: id, content });
    }

    res.json({
      success: true,
      data: updatedKb,
      message: "Knowledge base updated successfully",
    });
  } catch (err) {
    console.error("❌ Update KB error:", err);
    res.status(500).json({
      success: false,
      error: err.message || "Failed to update knowledge base",
    });
  }
};

export const deleteKnowledgeBase = async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }

    // 1️⃣ Get ElevenLabs KB ID
    const { data: kb, error } = await supabase
      .from("knowledge_bases")
      .select("elevenlabs_kb_id")
      .eq("id", id)
      .eq("user_id", user_id)
      .single();

    if (error || !kb) {
      return res.status(404).json({ message: "Knowledge base not found" });
    }

    // Check if KB is used by any agent
    const allKbs = await listElevenLabsKB();
    const elKb = allKbs.find((doc) => doc.id === kb.elevenlabs_kb_id);

    if (elKb?.dependent_agents?.length > 0) {
      return res.status(409).json({
        message:
          "Knowledge base is currently assigned to an agent. Unassign it before deleting.",
        dependent_agents: elKb.dependent_agents,
      });
    }

    // 2️⃣ Delete from ElevenLabs
    await deleteElevenLabsKB(kb.elevenlabs_kb_id);

    // 3️⃣ Delete knowledge entries
    await supabase
      .from("knowledge_entries")
      .delete()
      .eq("knowledge_base_id", id);

    // 4️⃣ Delete knowledge base
    await supabase
      .from("knowledge_bases")
      .delete()
      .eq("id", id)
      .eq("user_id", user_id);

    res.json({ success: true });
  } catch (err) {
    console.error(" Delete KB error:", err);
    res.status(500).json({ message: "Failed to delete knowledge base" });
  }
};
