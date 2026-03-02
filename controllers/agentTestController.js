// controllers/agentTestController.js
import axios from "axios";
import { supabase } from "../config/supabase.js";
import { outboundCall } from "../utils/elevenlabsApi.js";
import { sendToClaude } from "../utils/claudeClient.js";
import decideNextStep from "../utils/aiDecisionEngine.js";

const ELEVENLABS_AGENT_PHONE_NUMBER_ID = process.env.ELEVENLABS_PHONE_NUMBER_ID;

export const testVoiceAgent = async (req, res) => {
  try {
    const { agent_id } = req.params;
    const { to_number } = req.body;

    // console.log({ ELEVENLABS_AGENT_PHONE_NUMBER_ID, agent_id, to_number });

    if (!to_number) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required",
      });
    }

    /* -------------------------------------------------- */
    /* 1️⃣ Fetch Agent */
    /* -------------------------------------------------- */
    const { data: agent, error } = await supabase
      .from("agents")
      .select("*")
      .eq("agent_id", agent_id)
      .single();

    if (error || !agent) {
      return res.status(404).json({
        success: false,
        message: "Agent not found",
      });
    }

    if (!agent.is_active) {
      return res.status(400).json({
        success: false,
        message: "Agent is not active",
      });
    }

    if (!agent.voice_enabled) {
      return res.status(400).json({
        success: false,
        message: "Voice is not enabled for this agent",
      });
    }

    if (!agent.elevenlabs_agent_id) {
      return res.status(400).json({
        success: false,
        message: "ElevenLabs agent not configured",
      });
    }

    /* -------------------------------------------------- */
    /* 2️⃣ Call ElevenLabs via Utility */
    /* -------------------------------------------------- */
    const elevenResponse = await outboundCall({
      agentId: agent.elevenlabs_agent_id,
      agentPhoneNumberId: ELEVENLABS_AGENT_PHONE_NUMBER_ID,
      toNumber: to_number,
    });

    if (!elevenResponse.success) {
      return res.status(500).json({
        success: false,
        message: "Failed to initiate ElevenLabs call",
      });
    }

    /* -------------------------------------------------- */
    /* 3️⃣ Create Test Session */
    /* -------------------------------------------------- */

    const { data: agentData, error: testError } = await supabase
      .from("agent_test_sessions")
      .insert([
        {
          agent_id,
          user_id: agent.user_id,
          test_type: "voice",
          test_phone_number: to_number,
          test_status: "initiated",
          conversation_id: elevenResponse.conversation_id,
          started_at: new Date(),
          created_at: new Date(),
        },
      ])
      .select()
      .single();

    if (testError) {
      console.error("Test session insert error:", testError);
    }

    /* -------------------------------------------------- */
    /* 4️⃣ Update Agent Counters */
    /* -------------------------------------------------- */
    await supabase
      .from("agents")
      .update({
        total_tests: agent.total_tests + 1,
        total_calls: agent.total_calls + 1,
        last_used_at: new Date(),
      })
      .eq("agent_id", agent_id);

    /* -------------------------------------------------- */
    /* 5️⃣ Return Response */
    /* -------------------------------------------------- */
    return res.status(200).json({
      success: true,
      message: "Voice test initiated successfully",
      conversation_id: elevenResponse.conversation_id,
      callSid: elevenResponse.callSid,
      test_session_id: agentData.test_session_id,
    });
  } catch (err) {
    console.error("Voice test error:", err.response?.data || err.message);

    return res.status(500).json({
      success: false,
      message: "Something went wrong while testing voice agent",
    });
  }
};

//Get single test session data
export const getTestSession = async (req, res) => {
  try {
    const { session_id } = req.params;
    // const { user_id } = req.query;

    if (!session_id) {
      return res.status(400).json({
        success: false,
        message: "Session ID is required",
      });
    }

    // if (!user_id) {
    //   return res.status(400).json({
    //     success: false,
    //     message: "User ID is required",
    //   });
    // }

    /* -------------------------------------------------- */
    /* Fetch Test Session */
    /* -------------------------------------------------- */
    const { data: testSession, error } = await supabase
      .from("agent_test_sessions")
      .select("*")
      .eq("test_session_id", session_id)
      //   .eq("user_id", user_id) // 🔐 security check
      .single();

    if (error || !testSession) {
      return res.status(404).json({
        success: false,
        message: "Test session not found",
      });
    }

    /* -------------------------------------------------- */
    /* Return Response */
    /* -------------------------------------------------- */
    return res.status(200).json({
      success: true,
      data: testSession,
    });
  } catch (err) {
    console.error("Get test session error:", err.message);

    return res.status(500).json({
      success: false,
      message: "Something went wrong while fetching test session",
    });
  }
};

//get all test session data
export const getUserTestSessions = async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: "User ID is required",
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    /* -------------------------------------------------- */
    /* Fetch All Test Sessions For User */
    /* -------------------------------------------------- */
    const {
      data: testSessions,
      error,
      count,
    } = await supabase
      .from("agent_test_sessions")
      .select("*", { count: "exact" })
      .eq("user_id", user_id)
      .order("created_at", { ascending: false }) // latest first
      .range(from, to);

    if (error) {
      console.error("Fetch test sessions error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch test sessions",
      });
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

// Sync voice test status
export const syncVoiceTestStatus = async (req, res) => {
  try {
    const { conversation_id } = req.params;

    if (!conversation_id) {
      return res.status(400).json({
        success: false,
        message: "Conversation ID is required",
      });
    }

    /* -------------------------------------------------- */
    /* 1️⃣ Get Conversation From ElevenLabs */
    /* -------------------------------------------------- */
    const response = await axios.get(
      `https://api.elevenlabs.io/v1/convai/conversations/${conversation_id}`,
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
        },
      },
    );

    const conversation = response.data;

    /* -------------------------------------------------- */
    /* 2️⃣ Map Status */
    /* -------------------------------------------------- */
    let mappedStatus = "processing";

    if (conversation.status === "completed") {
      mappedStatus = "completed";
    } else if (conversation.status === "failed") {
      mappedStatus = "failed";
    }

    /* -------------------------------------------------- */
    /* 3️⃣ Update Test Session */
    /* -------------------------------------------------- */
    const { data, error } = await supabase
      .from("agent_test_sessions")
      .update({
        test_status: mappedStatus,
        completed_at: new Date(),
        duration_seconds: conversation.metadata?.call_duration_secs || null,
        test_data_collected: conversation.transcript || null,
        updated_at: new Date(),
      })
      .eq("conversation_id", conversation_id)
      .select()
      .single();

    if (error) {
      console.error("Update test session error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to update test session",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Test session synced successfully",
      data,
    });
  } catch (err) {
    console.error("Sync voice test error:", err.response?.data || err.message);

    return res.status(500).json({
      success: false,
      message: "Failed to sync voice test",
    });
  }
};

/**
 * POST /api/agent-system/:agent_id/test-chat
 * Test chatbot with FULL RSVP flow using mode flag
 */
export const testChatAgent = async (req, res) => {
  try {
    const { agent_id } = req.params;
    const { user_id, message, conversation_state } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({
        success: false,
        error: "Message is required",
      });
    }

    console.log("📞 TEST CHAT - Agent:", agent_id, "Message:", message);

    // Get agent details
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select(`
        *,
        agent_templates (name, config),
        knowledge_bases (id, name, elevenlabs_kb_id)
      `)
      .eq("agent_id", agent_id)
      .single();

    if (agentError || !agent) {
      console.error("❌ Agent not found:", agentError);
      return res.status(404).json({
        success: false,
        error: "Agent not found",
      });
    }

    console.log("✅ Agent found:", agent.agent_name);

    // Build or restore context
    let context;
    
    if (conversation_state && conversation_state.callStatus) {
      console.log("🔄 Continuing conversation from state:", conversation_state.callStatus);
      context = {
        ...conversation_state,
        userMessage: message,
      };
    } else {
      console.log("🆕 Starting fresh conversation");
      context = {
        userMessage: message,
        callStatus: "awaiting_rsvp",
        participant: {
          participant_id: "test-user-" + Date.now(),
          full_name: "Test User",
          phone: "+919999999999",
        },
        convo: {
          rsvp_status: null,
          number_of_guests: null,
          notes: null,
          proof_uploaded: false,
        },
        cache: {},
        event: {
          event_id: "test-event-" + Date.now(),
          event_name: "Test Event",
          knowledge_base_id: agent.knowledge_base_id,
        },
        incomingMediaUrl: null,
        uploadedDocuments: [],
      };
    }

    console.log("🔄 Calling aiDecisionEngine with TEST mode...");

    // Call with mode: "test"
    let aiResponse = await decideNextStep(context, { mode: "test" });

    // ✅ SKIP DOCUMENT STATES IN TEST MODE
    const documentStates = [
      "awaiting_doc_person_name",
      "awaiting_doc_role",
      "awaiting_id_proof",
      "awaiting_travel_docs_choice",
      "awaiting_travel_doc_type",
      "awaiting_travel_doc_direction",
      "awaiting_travel_doc_upload",
      "awaiting_arrival_manual_date",
      "awaiting_arrival_manual_time",
      "awaiting_return_choice",
      "awaiting_return_manual_date",
      "awaiting_return_manual_time",
      "awaiting_more_attendees",
      "awaiting_additional_attendee_name",
    ];

    if (documentStates.includes(aiResponse.nextState)) {
      console.log("📝 TEST MODE - Skipping document collection state:", aiResponse.nextState);
      
      aiResponse = {
        reply: aiResponse.reply + "\n\n📝 Note: Document collection is not available in test mode. Your RSVP has been recorded!\n\nFeel free to ask me anything about the wedding - venue, dates, dress code, schedule, etc! 😊",
        nextState: "completed",
        actions: { updateDB: false, fields: {} },
      };
    }

    console.log("✅ AI Response:", aiResponse.reply?.substring(0, 100));
    console.log("📍 Next State:", aiResponse.nextState);

    // Update context
    const updatedContext = {
      ...context,
      callStatus: aiResponse.nextState,
      convo: {
        ...context.convo,
        ...(aiResponse.actions?.fields || {}),
      },
      cache: aiResponse.actions?.cacheUpdate 
        ? { currentDoc: aiResponse.actions.cacheUpdate }
        : context.cache,
    };

    // Final response (no disclaimer needed - it's in frontend UI)
    let finalResponse = aiResponse.reply;

    // Log test session
    try {
      const { data: existingSession } = await supabase
        .from("agent_test_sessions")
        .select("test_session_id, test_transcript")
        .eq("agent_id", agent_id)
        .eq("user_id", user_id || "anonymous")
        .eq("test_type", "chat")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!existingSession) {
        await supabase.from("agent_test_sessions").insert({
          agent_id,
          user_id: user_id || "anonymous",
          test_type: "chat",
          test_status: "active",
          test_transcript: JSON.stringify([
            {
              role: "user",
              message: message,
              timestamp: new Date().toISOString(),
            },
            {
              role: "assistant",
              message: finalResponse,
              timestamp: new Date().toISOString(),
            },
          ]),
          test_data_collected: {
            current_state: aiResponse.nextState,
            rsvp_status: updatedContext.convo.rsvp_status,
            guest_count: updatedContext.convo.number_of_guests,
          },
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        });
        console.log("🆕 New test session created");
      } else {
        let transcript = [];
        try {
          transcript = JSON.parse(existingSession.test_transcript || "[]");
        } catch (e) {
          transcript = [];
        }

        transcript.push(
          {
            role: "user",
            message: message,
            timestamp: new Date().toISOString(),
          },
          {
            role: "assistant",
            message: finalResponse,
            timestamp: new Date().toISOString(),
          }
        );

        await supabase
          .from("agent_test_sessions")
          .update({
            test_transcript: JSON.stringify(transcript),
            test_data_collected: {
              current_state: aiResponse.nextState,
              rsvp_status: updatedContext.convo.rsvp_status,
              guest_count: updatedContext.convo.number_of_guests,
            },
            updated_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          })
          .eq("test_session_id", existingSession.test_session_id);

        console.log("📝 Session updated");
      }
    } catch (logError) {
      console.warn("⚠️ Failed to log test session:", logError.message);
    }

    // Return response
    res.json({
      success: true,
      response: finalResponse,
      conversation_state: updatedContext,
      metadata: {
        agent_name: agent.agent_name,
        used_kb: !!agent.knowledge_base_id,
        kb_name: agent.knowledge_bases?.name,
        current_state: aiResponse.nextState,
        rsvp_status: updatedContext.convo.rsvp_status,
        guest_count: updatedContext.convo.number_of_guests,
      },
    });

  } catch (error) {
    console.error("❌ Chat test error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to process chat message",
      details: error.message,
    });
  }
};
