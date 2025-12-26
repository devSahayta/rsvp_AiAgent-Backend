import {
  createTextKnowledgeBase,
  deleteElevenLabsKB,
  listElevenLabsKB,
} from "../utils/elevenlabsApi.js";
import { supabase } from "../config/supabase.js";
import { error } from "pdf-lib";

export const createKnowledgeBase = async (req, res) => {
  try {
    const { user_id, name, content } = req.body;

    if (!user_id) {
      return res.status(400).json({ message: "Invalid credential" });
    }

    if (!name || !content) {
      return res.status(400).json({ message: "Name and content are required" });
    }

    const elKb = await createTextKnowledgeBase({ name, text: content });

    const { data: kb, error } = await supabase
      .from("knowledge_bases")
      .insert({
        user_id,
        name,
        elevenlabs_kb_id: elKb.id,
      })
      .select()
      .single();

    if (error) throw error;

    await supabase.from("knowledge_entries").insert({
      knowledge_base_id: kb.id,
      content,
    });

    res.json(kb);
  } catch (err) {
    console.error("❌ Create KB error:", err);
    res.status(500).json({ message: "Failed to create knowledge base" });
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
