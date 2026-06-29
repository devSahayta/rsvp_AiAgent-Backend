// controllers/agentTestController.js - WITH CREDIT INTEGRATION + DUAL ENGINE
import axios from "axios";
import { supabase } from "../config/supabase.js";
import { submitTestBatchCall } from "../utils/elevenlabsApi.js";
import {
  CREDIT_PRICING,
  calculateChatCredits,
  calculateVoiceCredits,
} from "../config/creditPricing.js";
import { getUserById, updateUserCredits } from "../models/userModel.js";
import {
  runClassicTestChat,
  runSmartFieldsTestChat,
} from "../utils/testChatEngine.js";

const ELEVENLABS_AGENT_PHONE_NUMBER_ID = process.env.ELEVENLABS_PHONE_NUMBER_ID;

/* ─────────────────────────────────────────────────────────────────
   POST /api/agent-system/:agent_id/test-voice
───────────────────────────────────────────────────────────────── */
export const testVoiceAgent = async (req, res) => {
  try {
    const { agent_id } = req.params;
    const { to_number, user_id } = req.body;

    if (!to_number) {
      return res
        .status(400)
        .json({ success: false, message: "Phone number is required" });
    }
    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: "User ID is required for credit tracking",
      });
    }

    // ── Check credits ──────────────────────────────────────────────
    const user = await getUserById(user_id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const estimatedCredits = CREDIT_PRICING.TEST_VOICE_PER_MINUTE;
    if (user.credits < estimatedCredits) {
      return res.status(402).json({
        success: false,
        message: "Insufficient credits for test voice call",
        current_balance: user.credits,
        required_credits: estimatedCredits,
        shortfall: estimatedCredits - user.credits,
      });
    }

    // ── Fetch Agent ────────────────────────────────────────────────
    const { data: agent, error } = await supabase
      .from("agents")
      .select("*")
      .eq("agent_id", agent_id)
      .single();

    if (error || !agent) {
      return res
        .status(404)
        .json({ success: false, message: "Agent not found" });
    }
    if (!agent.is_active || !agent.voice_enabled) {
      return res.status(400).json({
        success: false,
        message: "Voice not enabled or agent inactive",
      });
    }
    if (!agent.elevenlabs_agent_id) {
      return res
        .status(400)
        .json({ success: false, message: "ElevenLabs agent not configured" });
    }
    if (!agent.event_title) {
      return res
        .status(400)
        .json({ success: false, message: "Event Title not defined" });
    }

    // ── Build smart_fields_block (mirrors triggerBatchCall in eventController.js) ──
    // This is THE critical piece that tells the AI exactly what questions to ask,
    // in what order, and which field_key to use when saving each answer.
    // Without this, the agent has no field list and improvises (wrong questions,
    // skipped fields, invented field names).
    const isSmartFields = agent.field_mode === "smart_fields";
    let smart_fields_block = "";

    if (isSmartFields) {
      let parsedFields = [];
      try {
        parsedFields =
          typeof agent.smart_fields === "string"
            ? JSON.parse(agent.smart_fields)
            : agent.smart_fields || [];
      } catch (parseErr) {
        console.error("⚠️ Failed to parse agent.smart_fields:", parseErr);
      }

      if (Array.isArray(parsedFields) && parsedFields.length > 0) {
        const sortedFields = [...parsedFields].sort(
          (a, b) => (a.display_order ?? 0) - (b.display_order ?? 0),
        );

        smart_fields_block = sortedFields
          .map((f, i) => {
            let typeLine = `Type: ${f.field_type}`;
            if (
              f.field_type === "choice" &&
              Array.isArray(f.options) &&
              f.options.length
            ) {
              typeLine += ` | Options: ${f.options.join(", ")}`;
            }
            typeLine += ` | Required: ${f.is_required ? "Yes" : "No"}`;
            return (
              `${i + 1}. Ask: "${f.ai_question}"\n` +
              `   field_key: ${f.field_key}\n` +
              `   ${typeLine}`
            );
          })
          .join("\n\n");

        console.log(
          `📋 Built smart_fields_block with ${sortedFields.length} field(s) for test call`,
        );
      } else {
        console.warn(
          `⚠️ Agent ${agent_id} is field_mode=smart_fields but has no smart_fields configured`,
        );
      }
    }

    // Include ALL dynamic variables the ElevenLabs agent needs —
    // both first_message template vars AND tool call vars.
    // Test mode uses placeholder values for participant_id.
    const voiceName = agent.voice_name
      ? agent.voice_name.split("-")[0].trim()
      : null;

    const dynamic_variables = {
      agent_name: String(voiceName || agent.agent_name || "Agent"),
      eventId: String(agent_id),
      eventName: String(agent.event_title),
      event_name: String(agent.event_title),
      event_id: String(agent_id),
      guest_name: "Test User",
      participant_id: "test-participant",
      knowledge_base_id: String(agent.knowledge_base_id || ""),
      smart_fields_block, // ← THE missing piece — now matches production
    };

    // ── Submit Batch Call ──────────────────────────────────────────
    const elevenResponse = await submitTestBatchCall({
      agentId: agent.elevenlabs_agent_id,
      agentPhoneNumberId: ELEVENLABS_AGENT_PHONE_NUMBER_ID,
      toNumber: to_number,
      dynamicVariables: dynamic_variables,
      voiceId: agent.voice_id || null, // Optional: override agent's default voice
    });

    if (!elevenResponse.success) {
      return res.status(500).json({
        success: false,
        message: "Failed to initiate ElevenLabs test batch call",
      });
    }

    // ── Create Test Session ────────────────────────────────────────
    const { data: testSession, error: testError } = await supabase
      .from("agent_test_sessions")
      .insert([
        {
          agent_id,
          user_id,
          test_type: "voice",
          test_phone_number: to_number,
          test_status: "queued",
          batch_id: elevenResponse.batch_id,
          started_at: new Date(),
          created_at: new Date(),
        },
      ])
      .select()
      .single();

    if (testError) {
      console.error("Test session insert error:", testError);
    }

    // ── Update Agent Counters ──────────────────────────────────────
    await supabase
      .from("agents")
      .update({
        total_tests: (agent.total_tests || 0) + 1,
        total_calls: (agent.total_calls || 0) + 1,
        last_used_at: new Date(),
      })
      .eq("agent_id", agent_id);

    return res.status(200).json({
      success: true,
      message: "Voice test batch initiated successfully",
      batch_id: elevenResponse.batch_id,
      test_session_id: testSession?.test_session_id,
      note: "Credits will be deducted after call completes based on actual duration",
    });
  } catch (err) {
    console.error("Voice test batch error:", err);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while testing voice agent",
    });
  }
};

/* ─────────────────────────────────────────────────────────────────
   GET /api/agent-system/test-sessions/:session_id
───────────────────────────────────────────────────────────────── */
export const getTestSession = async (req, res) => {
  try {
    const { session_id } = req.params;
    if (!session_id) {
      return res
        .status(400)
        .json({ success: false, message: "Session ID is required" });
    }

    const { data: testSession, error } = await supabase
      .from("agent_test_sessions")
      .select("*")
      .eq("test_session_id", session_id)
      .single();

    if (error || !testSession) {
      return res
        .status(404)
        .json({ success: false, message: "Test session not found" });
    }

    return res.status(200).json({ success: true, data: testSession });
  } catch (err) {
    console.error("Get test session error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while fetching test session",
    });
  }
};

/* ─────────────────────────────────────────────────────────────────
   GET /api/agent-system/test-sessions
───────────────────────────────────────────────────────────────── */
export const getUserTestSessions = async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return res
        .status(400)
        .json({ success: false, message: "User ID is required" });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const {
      data: testSessions,
      error,
      count,
    } = await supabase
      .from("agent_test_sessions")
      .select("*", { count: "exact" })
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) {
      console.error("Fetch test sessions error:", error);
      return res
        .status(500)
        .json({ success: false, message: "Failed to fetch test sessions" });
    }

    return res.status(200).json({
      success: true,
      count: testSessions.length,
      page,
      total: count,
      data: testSessions,
    });
  } catch (err) {
    console.error("Get user test sessions error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while fetching test sessions",
    });
  }
};

/* ─────────────────────────────────────────────────────────────────
   POST /api/agent-system/test-sessions/:batch_id/sync
───────────────────────────────────────────────────────────────── */
export const syncVoiceTestStatus = async (req, res) => {
  try {
    const { batch_id } = req.params;
    if (!batch_id) {
      return res
        .status(400)
        .json({ success: false, message: "Batch ID is required" });
    }

    // Fetch from ElevenLabs
    const response = await axios.get(
      `https://api.elevenlabs.io/v1/convai/batch-calling/${batch_id}`,
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } },
    );

    const batch = response.data;
    if (!batch?.recipients?.length) {
      return res
        .status(404)
        .json({ success: false, message: "No recipients found in batch" });
    }

    const recipient = batch.recipients[0];

    // Map status
    let mappedStatus = "processing";
    if (recipient.status === "completed") mappedStatus = "completed";
    else if (recipient.status === "failed" || recipient.status === "error")
      mappedStatus = "failed";
    else if (recipient.status === "pending" || recipient.status === "scheduled")
      mappedStatus = "queued";

    // Fetch conversation transcript + duration
    let transcript = null;
    let duration = null;

    if (recipient.conversation_id) {
      try {
        const convoRes = await axios.get(
          `https://api.elevenlabs.io/v1/convai/conversations/${recipient.conversation_id}`,
          { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } },
        );
        const conversation = convoRes.data;
        transcript = conversation.transcript || null;
        duration = conversation.metadata?.call_duration_secs || null;
        console.log(`⏱️ Call duration: ${duration} seconds`);
      } catch {
        console.warn("⚠️ Failed to fetch conversation details");
      }
    }

    // Update test session
    const { data, error } = await supabase
      .from("agent_test_sessions")
      .update({
        test_status: mappedStatus,
        conversation_id: recipient.conversation_id || null,
        duration_seconds: duration,
        test_transcript: transcript,
        completed_at: mappedStatus === "completed" ? new Date() : null,
        updated_at: new Date(),
      })
      .eq("batch_id", batch_id)
      .select()
      .single();

    if (error) {
      console.error("Update test session error:", error);
      return res
        .status(500)
        .json({ success: false, message: "Failed to update test session" });
    }

    // Deduct credits if call completed
    let creditsDeducted = null;
    if (
      mappedStatus === "completed" &&
      duration &&
      duration > 0 &&
      data.user_id
    ) {
      try {
        const creditsToDeduct = calculateVoiceCredits(duration, true);
        const user = await getUserById(data.user_id);

        if (user && user.credits >= creditsToDeduct) {
          const newCredits = Number(
            (user.credits - creditsToDeduct).toFixed(2),
          );
          await updateUserCredits(data.user_id, newCredits);
          creditsDeducted = creditsToDeduct;
          console.log(
            `✅ Credits deducted: ${user.credits} → ${newCredits} (-${creditsToDeduct})`,
          );

          await supabase
            .from("agent_test_sessions")
            .update({
              test_data_collected: {
                ...data.test_data_collected,
                credits_deducted: creditsToDeduct,
                previous_balance: user.credits,
                new_balance: newCredits,
              },
            })
            .eq("test_session_id", data.test_session_id);
        } else {
          console.warn(`⚠️ Insufficient credits for user ${data.user_id}`);
        }
      } catch (creditError) {
        console.error("❌ Error deducting credits:", creditError);
      }
    }

    return res.status(200).json({
      success: true,
      message: "Test session synced successfully",
      data,
      credits_deducted: creditsDeducted,
      debug: {
        batch_status: batch.status,
        recipient_status: recipient.status,
        duration_seconds: duration,
      },
    });
  } catch (err) {
    console.error(
      "Sync voice test batch error:",
      err.response?.data || err.message,
    );
    return res
      .status(500)
      .json({ success: false, message: "Failed to sync voice test batch" });
  }
};

/* ─────────────────────────────────────────────────────────────────
   POST /api/agent-system/:agent_id/test-chat
   Routes to the correct engine based on agent.field_mode
───────────────────────────────────────────────────────────────── */
export const testChatAgent = async (req, res) => {
  try {
    const { agent_id } = req.params;
    const { user_id, message, conversation_state } = req.body;

    if (!message?.trim()) {
      return res
        .status(400)
        .json({ success: false, error: "Message is required" });
    }
    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "User ID is required for credit tracking",
      });
    }

    // ── Check credits ──────────────────────────────────────────────
    console.log("💰 Checking credits for test chat...");
    const user = await getUserById(user_id);
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const requiredCredits = CREDIT_PRICING.TEST_CHAT_PER_MESSAGE;
    if (user.credits < requiredCredits) {
      return res.status(402).json({
        success: false,
        error: "Insufficient credits for test chat",
        current_balance: user.credits,
        required_credits: requiredCredits,
        shortfall: requiredCredits - user.credits,
      });
    }
    console.log(
      `✅ Credit check passed: ${user.credits} >= ${requiredCredits}`,
    );

    // ── Fetch Agent ────────────────────────────────────────────────
    console.log(`📞 TEST CHAT - Agent: ${agent_id}, Message: ${message}`);
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select(
        `
        *,
        agent_templates (name, config),
        knowledge_bases (id, name, elevenlabs_kb_id)
      `,
      )
      .eq("agent_id", agent_id)
      .single();

    if (agentError || !agent) {
      console.error("❌ Agent not found:", agentError);
      return res.status(404).json({ success: false, error: "Agent not found" });
    }
    console.log(
      `✅ Agent found: ${agent.agent_name} (field_mode: ${agent.field_mode || "classic"})`,
    );

    // ── Route to correct engine ────────────────────────────────────
    const fieldMode = agent.field_mode || "classic";
    let reply, nextState, updatedState;

    console.log(`🔄 Running ${fieldMode} test chat engine...`);

    if (fieldMode === "smart_fields") {
      // ── Smart Fields Engine ──────────────────────────────────────
      const result = await runSmartFieldsTestChat({
        agent,
        userMessage: message.trim(),
        conversationState: conversation_state,
      });
      reply = result.reply;
      nextState = result.nextState;
      updatedState = result.updatedState;
    } else {
      // ── Classic Engine ───────────────────────────────────────────
      const result = await runClassicTestChat({
        agent,
        userMessage: message.trim(),
        conversationState: conversation_state,
      });
      reply = result.reply;
      nextState = result.nextState;
      updatedState = result.updatedState;
    }

    console.log(`✅ Reply: ${reply?.substring(0, 100)}`);
    console.log(`📍 Next State: ${nextState}`);

    // ── Deduct credits ─────────────────────────────────────────────
    let creditsDeducted = null;
    try {
      console.log("💰 Deducting credits for test chat...");
      const creditsToDeduct = calculateChatCredits(1, true);
      const newCredits = Number((user.credits - creditsToDeduct).toFixed(2));
      await updateUserCredits(user_id, newCredits);
      creditsDeducted = creditsToDeduct;
      console.log(
        `✅ Credits deducted: ${user.credits} → ${newCredits} (-${creditsToDeduct})`,
      );
    } catch (creditError) {
      console.error("❌ Error deducting credits:", creditError);
    }

    // ── Log test session ───────────────────────────────────────────
    try {
      const { data: existingSession } = await supabase
        .from("agent_test_sessions")
        .select("test_session_id, test_transcript, test_data_collected")
        .eq("agent_id", agent_id)
        .eq("user_id", user_id)
        .eq("test_type", "chat")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const newMessages = [
        { role: "user", message, timestamp: new Date().toISOString() },
        {
          role: "assistant",
          message: reply,
          timestamp: new Date().toISOString(),
        },
      ];

      if (!existingSession) {
        await supabase.from("agent_test_sessions").insert({
          agent_id,
          user_id,
          test_type: "chat",
          test_status: "active",
          test_transcript: JSON.stringify(newMessages),
          test_data_collected: {
            current_state: nextState,
            field_mode: fieldMode,
            collected_answers: updatedState?.convo || {},
            credits_deducted: creditsDeducted,
          },
          started_at: new Date().toISOString(),
          completed_at:
            nextState === "completed" ? new Date().toISOString() : null,
        });
        console.log("🆕 New test session created");
      } else {
        let transcript = [];
        try {
          transcript = JSON.parse(existingSession.test_transcript || "[]");
        } catch {
          transcript = [];
        }
        transcript.push(...newMessages);

        const prevTotal =
          existingSession.test_data_collected?.total_credits_deducted || 0;

        await supabase
          .from("agent_test_sessions")
          .update({
            test_transcript: JSON.stringify(transcript),
            test_status: nextState === "completed" ? "completed" : "active",
            test_data_collected: {
              current_state: nextState,
              field_mode: fieldMode,
              collected_answers: updatedState?.convo || {},
              total_credits_deducted: prevTotal + (creditsDeducted || 0),
            },
            updated_at: new Date().toISOString(),
            completed_at:
              nextState === "completed" ? new Date().toISOString() : null,
          })
          .eq("test_session_id", existingSession.test_session_id);
        console.log("📝 Session updated");
      }
    } catch (logError) {
      console.warn("⚠️ Failed to log test session:", logError.message);
    }

    // ── Return response ────────────────────────────────────────────
    return res.json({
      success: true,
      response: reply,
      conversation_state: updatedState,
      credits_deducted: creditsDeducted,
      metadata: {
        agent_name: agent.agent_name,
        field_mode: fieldMode,
        current_state: nextState,
        collected_answers: updatedState?.convo || {},
        used_kb: !!agent.knowledge_base_id,
        kb_name: agent.knowledge_bases?.name,
      },
    });
  } catch (error) {
    console.error("❌ Chat test error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to process chat message",
      details: error.message,
    });
  }
};
