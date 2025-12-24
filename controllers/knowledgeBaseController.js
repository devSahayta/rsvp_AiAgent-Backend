import { createTextKnowledgeBase } from "../utils/elevenlabsApi.js";
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
    res
      .status(500)
      .json({
        message: "Failed to fetch knowledge bases content",
        error: error,
      });
  }
};
