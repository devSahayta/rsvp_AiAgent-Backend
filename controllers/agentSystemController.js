// controllers/agentController.js
import { supabase } from "../config/supabase.js";
import {
  getAgent,
  duplicateAgent,
  updateAgent,
  deleteAgent,
  addSharedVoice,
} from "../utils/elevenlabsApi.js";
/**
 * GET /api/agent-system/templates
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
 * GET /api/agent-system/templates/:template_id
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
 * Builds a dynamic ElevenLabs system prompt from smart_fields definitions.
 */
function buildSmartFieldsSystemPrompt(smartFields, eventTitle) {
  const sorted = [...smartFields].sort(
    (a, b) => (a.display_order || 0) - (b.display_order || 0),
  );

  const questionLines = sorted
    .map((f, i) => {
      let line = `${i + 1}. ${f.field_label}: ${f.ai_question}`;
      if (f.field_type === "yes_no") line += " (collect Yes or No)";
      else if (f.field_type === "number") line += " (collect a number)";
      else if (
        f.field_type === "choice" &&
        Array.isArray(f.options) &&
        f.options.length
      ) {
        line += ` (options: ${f.options.join(" / ")})`;
      }
      if (!f.is_required) line += " [optional]";
      return line;
    })
    .join("\n");

  return `You are a professional RSVP assistant calling guests for the event "${eventTitle}".

Collect the following information conversationally:
${questionLines}

Guidelines:
- Be warm, friendly, and professional
- Ask one question at a time naturally
- Skip optional questions if the guest seems busy or declines
- If the guest cannot attend, skip questions that only apply to attendees
- Thank the guest and close the call after collecting all required information`;
}

/**
 * POST /api/agent-system/create
 *
 * Classic mode  → template_id + knowledge_base_id required.
 *                 Duplicates the base ElevenLabs agent. KB stored in DB only.
 *
 * Smart fields  → knowledge_base_id + smart_fields[] required. No template_id.
 *                 Uses ELEVENLABS_DYNAMIC_AGENT_ID from env (no duplication).
 *                 Injects KB + dynamic prompt into ElevenLabs, saves first_message
 *                 and system_prompt to DB.
 */
export const createAgent = async (req, res) => {
  try {
    const {
      user_id,
      template_id,
      agent_name,
      agent_description,
      knowledge_base_id,
      event_title,
      field_mode = "classic",
      smart_fields = [],
      voice_id,
      voice_name,
      public_owner_id,
    } = req.body;

    // Common required fields
    if (!user_id || !agent_name) {
      return res.status(400).json({
        success: false,
        error: "user_id and agent_name are required",
      });
    }

    if (!["classic", "smart_fields"].includes(field_mode)) {
      return res.status(400).json({
        success: false,
        error: "field_mode must be 'classic' or 'smart_fields'",
      });
    }

    if (!knowledge_base_id) {
      return res.status(400).json({
        success: false,
        error: "knowledge_base_id is required",
      });
    }

    // Mode-specific validation
    if (field_mode === "classic" && !template_id) {
      return res.status(400).json({
        success: false,
        error: "template_id is required for classic mode",
      });
    }

    if (
      field_mode === "smart_fields" &&
      (!Array.isArray(smart_fields) || smart_fields.length === 0)
    ) {
      return res.status(400).json({
        success: false,
        error:
          "smart_fields array is required and must not be empty for smart_fields mode",
      });
    }

    // Fetch KB (required for both modes)
    const { data: kb, error: kbError } = await supabase
      .from("knowledge_bases")
      .select("*")
      .eq("id", knowledge_base_id)
      .single();

    if (kbError || !kb) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid knowledge base" });
    }

    // Voices picked from the ElevenLabs shared-voices library are only
    // browsable/previewable — they must be imported into our account's
    // voice library before they're usable in actual TTS/calls.
    let resolvedVoiceId = voice_id || null;
    let voiceImportWarning = null;
    if (voice_id && public_owner_id) {
      try {
        const imported = await addSharedVoice({
          publicOwnerId: public_owner_id,
          voiceId: voice_id,
          newName: voice_name || `voice-${voice_id}`,
        });
        resolvedVoiceId = imported.voice_id || voice_id;
      } catch (importError) {
        console.error(
          "⚠️ Failed to import shared voice into ElevenLabs account:",
          importError.response?.data || importError.message,
        );
        voiceImportWarning =
          "Selected voice could not be imported into the ElevenLabs voice library — calls will fall back to the default voice until this is resolved.";
      }
    }

    // ─── CLASSIC MODE ────────────────────────────────────────────────────────
    if (field_mode === "classic") {
      // Verify template
      const { data: template, error: templateError } = await supabase
        .from("agent_templates")
        .select("*")
        .eq("template_id", template_id)
        .single();

      if (templateError || !template) {
        return res
          .status(404)
          .json({ success: false, error: "Agent template not found" });
      }

      const baseAgentId = process.env.ELEVENLABS_AGENT_ID;
      if (!baseAgentId) {
        return res.status(500).json({
          success: false,
          error: "ELEVENLABS_AGENT_ID is not configured in environment",
        });
      }

      //1) Duplicate base ElevenLabs agent
      const duplicatedAgent = await duplicateAgent({
        agentId: baseAgentId,
        name: `${agent_name} Agent`,
      });

      //2) Get duplicated agent config
      const agentConfig = await getAgent(duplicatedAgent.agent_id);

      // ElevenLabs' GET response includes both the legacy inline `tools` array
      // and the newer `tool_ids` references for the same tools. Echoing both
      // back on PATCH is rejected ("Cannot specify both tools and tool IDs") —
      // drop the legacy inline array and keep `tool_ids`.
      delete agentConfig.conversation_config.agent.prompt.tools;

      //3) Inject TEXT knowledge base into duplicated ElevenLabs agent config (classic mode uses TEXT KB only)
      agentConfig.conversation_config.agent.prompt.knowledge_base = [
        {
          type: "text",
          id: kb.elevenlabs_kb_id,
          name: kb.name,
          usage_mode: "auto",
        },
      ];

      // Set the agent's own default voice (this is a dedicated duplicated
      // agent, so it's safe to set directly rather than only overriding per-call)
      if (resolvedVoiceId) {
        agentConfig.conversation_config.tts.voice_id = resolvedVoiceId;
      }

      //4) Update agent (PATCH)
      await updateAgent({
        agentId: duplicatedAgent.agent_id,
        payload: agentConfig,
      });

      // Save to DB — KB stored here only, no ElevenLabs config changes
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
          event_title,
          field_mode: "classic",
          voice_id: resolvedVoiceId,
          voice_name: voice_name || null,
        })
        .select(
          `*, agent_templates (name, slug, icon_url, config), knowledge_bases (id, name)`,
        )
        .single();

      if (agentError) throw agentError;

      return res
        .status(201)
        .json({ success: true, data: agent, voice_import_warning: voiceImportWarning });
    }

    // ─── SMART FIELDS MODE ───────────────────────────────────────────────────
    const dynamicAgentId = process.env.ELEVENLABS_DYNAMIC_AGENT_ID;
    if (!dynamicAgentId) {
      return res.status(500).json({
        success: false,
        error: "ELEVENLABS_DYNAMIC_AGENT_ID is not configured in environment",
      });
    }

    const first_message = req.body.first_message || null;

    // // Get config from the shared dynamic ElevenLabs agent
    // const agentConfig = await getAgent(dynamicAgentId);

    // // Extract first_message before modifying the config
    // const first_message =
    //   agentConfig?.conversation_config?.agent?.first_message || null;

    // // Inject KB into ElevenLabs agent config
    // agentConfig.conversation_config.agent.prompt.knowledge_base = [
    //   {
    //     type: "text",
    //     id: kb.elevenlabs_kb_id,
    //     name: kb.name,
    //     usage_mode: "auto",
    //   },
    // ];

    // // Build dynamic system prompt from smart_fields and inject
    // const final_system_prompt = buildSmartFieldsSystemPrompt(smart_fields, event_title);
    // agentConfig.conversation_config.agent.prompt.prompt = final_system_prompt;

    // // PATCH the dynamic ElevenLabs agent
    // await updateAgent({ agentId: dynamicAgentId, payload: agentConfig });

    // Save to DB with smart fields metadata
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .insert({
        user_id,
        template_id: null,
        agent_name,
        agent_description,
        knowledge_base_id,
        elevenlabs_agent_id: dynamicAgentId,
        status: "unassigned",
        event_title,
        field_mode: "smart_fields",
        smart_fields,
        first_message,
        // system_prompt: final_system_prompt,
        voice_id: resolvedVoiceId,
        voice_name: voice_name || null,
      })
      .select(`*, knowledge_bases (id, name)`)
      .single();

    if (agentError) throw agentError;

    return res
      .status(201)
      .json({ success: true, data: agent, voice_import_warning: voiceImportWarning });
  } catch (error) {
    const elevenLabsDetail = error.response?.data;
    console.error(
      "Error creating agent:",
      elevenLabsDetail ? JSON.stringify(elevenLabsDetail, null, 2) : error.message,
    );
    res.status(500).json({
      success: false,
      error: elevenLabsDetail?.detail?.message || error.message,
    });
  }
};

/**
 * PUT /api/agent-system/:agent_id
 *
 * Classic mode  → KB and voice are baked directly into the agent's own
 *                 dedicated duplicated ElevenLabs agent at creation time,
 *                 so changing either here re-injects them into that same
 *                 ElevenLabs agent (mirrors the inject logic in createAgent).
 *
 * Smart fields  → All agents of this mode share ELEVENLABS_DYNAMIC_AGENT_ID;
 *                 KB/voice/prompt are injected per-call via dynamic_variables
 *                 (see eventController dispatch), so this is a DB-only update.
 *
 * field_mode and template_id are immutable after creation — the former
 * determines how the agent was wired up, the latter is tied to the
 * one-time duplication that already happened.
 */
export const updateAgentDetails = async (req, res) => {
  try {
    const { agent_id } = req.params;
    const {
      agent_name,
      agent_description,
      event_title,
      knowledge_base_id,
      smart_fields,
      first_message,
      voice_id,
      voice_name,
      public_owner_id,
      field_mode,
      template_id,
    } = req.body;

    const { data: agent, error: fetchError } = await supabase
      .from("agents")
      .select("*")
      .eq("agent_id", agent_id)
      .single();

    if (fetchError || !agent) {
      return res.status(404).json({ success: false, error: "Agent not found" });
    }

    if (field_mode && field_mode !== agent.field_mode) {
      return res.status(400).json({
        success: false,
        error: "field_mode cannot be changed after creation",
      });
    }

    if (template_id && template_id !== agent.template_id) {
      return res.status(400).json({
        success: false,
        error: "template_id cannot be changed after creation",
      });
    }

    if (
      agent.field_mode === "smart_fields" &&
      smart_fields !== undefined &&
      (!Array.isArray(smart_fields) || smart_fields.length === 0)
    ) {
      return res.status(400).json({
        success: false,
        error: "smart_fields must be a non-empty array",
      });
    }

    // Validate new KB, if changing
    let kb = null;
    const kbChanged =
      knowledge_base_id !== undefined &&
      knowledge_base_id !== agent.knowledge_base_id;

    if (kbChanged) {
      const { data: kbData, error: kbError } = await supabase
        .from("knowledge_bases")
        .select("*")
        .eq("id", knowledge_base_id)
        .single();

      if (kbError || !kbData) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid knowledge base" });
      }
      kb = kbData;
    }

    // Resolve voice — import shared-library voice if a new public_owner_id is given
    let resolvedVoiceId = voice_id !== undefined ? voice_id : agent.voice_id;
    let voiceImportWarning = null;
    const voiceChanged = voice_id !== undefined && voice_id !== agent.voice_id;

    if (voiceChanged && voice_id && public_owner_id) {
      try {
        const imported = await addSharedVoice({
          publicOwnerId: public_owner_id,
          voiceId: voice_id,
          newName: voice_name || `voice-${voice_id}`,
        });
        resolvedVoiceId = imported.voice_id || voice_id;
      } catch (importError) {
        console.error(
          "⚠️ Failed to import shared voice into ElevenLabs account:",
          importError.response?.data || importError.message,
        );
        voiceImportWarning =
          "Selected voice could not be imported into the ElevenLabs voice library — keeping the previous voice until this is resolved.";
        resolvedVoiceId = agent.voice_id;
      }
    }

    // ─── CLASSIC MODE: keep the dedicated ElevenLabs duplicate in sync ──────
    if (agent.field_mode === "classic" && (kbChanged || voiceChanged)) {
      const agentConfig = await getAgent(agent.elevenlabs_agent_id);

      // See createAgent() — GET returns both legacy inline `tools` and the
      // newer `tool_ids`; PATCH rejects having both.
      delete agentConfig.conversation_config.agent.prompt.tools;

      if (kbChanged) {
        agentConfig.conversation_config.agent.prompt.knowledge_base = [
          {
            type: "text",
            id: kb.elevenlabs_kb_id,
            name: kb.name,
            usage_mode: "auto",
          },
        ];
      }

      if (voiceChanged) {
        agentConfig.conversation_config.tts.voice_id = resolvedVoiceId;
      }

      await updateAgent({
        agentId: agent.elevenlabs_agent_id,
        payload: agentConfig,
      });
    }

    // ─── Build DB update payload ─────────────────────────────────────────────
    const updatePayload = {};
    if (agent_name !== undefined) updatePayload.agent_name = agent_name;
    if (agent_description !== undefined)
      updatePayload.agent_description = agent_description;
    if (event_title !== undefined) updatePayload.event_title = event_title;
    if (kbChanged) updatePayload.knowledge_base_id = knowledge_base_id;
    if (voiceChanged) {
      updatePayload.voice_id = resolvedVoiceId;
      updatePayload.voice_name =
        voice_name !== undefined ? voice_name : agent.voice_name;
    }

    // smart_fields-only columns — no-op for classic agents
    if (agent.field_mode === "smart_fields") {
      if (smart_fields !== undefined) updatePayload.smart_fields = smart_fields;
      if (first_message !== undefined)
        updatePayload.first_message = first_message;
    }

    if (Object.keys(updatePayload).length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "No valid fields provided to update" });
    }

    const { data: updatedAgent, error: updateError } = await supabase
      .from("agents")
      .update(updatePayload)
      .eq("agent_id", agent_id)
      .select(
        `*, agent_templates (name, slug, icon_url, config), knowledge_bases (id, name)`,
      )
      .single();

    if (updateError) throw updateError;

    return res.status(200).json({
      success: true,
      data: updatedAgent,
      voice_import_warning: voiceImportWarning,
    });
  } catch (error) {
    const elevenLabsDetail = error.response?.data;
    console.error(
      "Error updating agent:",
      elevenLabsDetail ? JSON.stringify(elevenLabsDetail, null, 2) : error.message,
    );
    res.status(500).json({
      success: false,
      error: elevenLabsDetail?.detail?.message || error.message,
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
          config,
          preview_image_url
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
      .select(
        "agent_id, knowledge_base_id, agent_name, elevenlabs_agent_id, field_mode",
      )
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

    // If not a smart field agent → proceed to delete ElevenLabs agent and its knowledge base (if any)
    if (agent.field_mode === "classic") {
      // 🤖 Delete ElevenLabs agent (if exists)
      if (agent?.elevenlabs_agent_id) {
        try {
          await deleteAgent(agent.elevenlabs_agent_id);
          console.log(
            `🗑️ ElevenLabs agent deleted: ${agent.elevenlabs_agent_id}`,
          );
        } catch (agentErr) {
          console.warn(
            "⚠️ Failed to delete ElevenLabs agent:",
            agentErr.response?.data || agentErr.message,
          );
          // DO NOT throw — event deletion must continue
        }
      }
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
