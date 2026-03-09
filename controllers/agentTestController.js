// controllers/agentTestController.js - WITH CREDIT INTEGRATION
import axios from "axios";
import { supabase } from "../config/supabase.js";
import { submitTestBatchCall } from "../utils/elevenlabsApi.js";
import decideNextStep from "../utils/aiDecisionEngine.js";
import { 
  CREDIT_PRICING,
  calculateChatCredits,
  calculateVoiceCredits,
} from "../config/creditPricing.js";
import { getUserById, updateUserCredits } from "../models/userModel.js";

const ELEVENLABS_AGENT_PHONE_NUMBER_ID = process.env.ELEVENLABS_PHONE_NUMBER_ID;

/**
 * POST /api/agent-system/:agent_id/test-voice
 * Initiate test voice call
 */
export const testVoiceAgent = async (req, res) => {
  try {
    const { agent_id } = req.params;
    const { to_number, user_id } = req.body; // ✅ Need user_id for credits

    if (!to_number) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required",
      });
    }

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: "User ID is required for credit tracking",
      });
    }

    // ✅ CHECK CREDITS FIRST (estimate 1 minute minimum)
    console.log("💰 Checking credits for test voice call...");
    const user = await getUserById(user_id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const estimatedCredits = CREDIT_PRICING.TEST_VOICE_PER_MINUTE; // At least 1 minute
    
    if (user.credits < estimatedCredits) {
      return res.status(402).json({
        success: false,
        message: "Insufficient credits for test voice call",
        current_balance: user.credits,
        required_credits: estimatedCredits,
        shortfall: estimatedCredits - user.credits,
      });
    }

    console.log(`✅ Credit check passed: ${user.credits} >= ${estimatedCredits}`);

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

    if (!agent.is_active || !agent.voice_enabled) {
      return res.status(400).json({
        success: false,
        message: "Voice not enabled or agent inactive",
      });
    }

    if (!agent.elevenlabs_agent_id) {
      return res.status(400).json({
        success: false,
        message: "ElevenLabs agent not configured",
      });
    }

    if (!agent.event_title) {
      return res.status(400).json({
        success: false,
        message: "Event Title not defined",
      });
    }

    const dynamic_variables = {
      eventId: String(agent_id),
      eventName: String(agent.event_title),
    };

    /* -------------------------------------------------- */
    /* 2️⃣ Submit Batch Call (Single Test Mode) */
    /* -------------------------------------------------- */
    const elevenResponse = await submitTestBatchCall({
      agentId: agent.elevenlabs_agent_id,
      agentPhoneNumberId: ELEVENLABS_AGENT_PHONE_NUMBER_ID,
      toNumber: to_number,
      dynamicVariables: dynamic_variables,
    });

    if (!elevenResponse.success) {
      return res.status(500).json({
        success: false,
        message: "Failed to initiate ElevenLabs test batch call",
      });
    }

    /* -------------------------------------------------- */
    /* 3️⃣ Create Test Session (with user_id) */
    /* -------------------------------------------------- */
    const { data: testSession, error: testError } = await supabase
      .from("agent_test_sessions")
      .insert([
        {
          agent_id,
          user_id, // ✅ Store user_id for credit deduction later
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

/**
 * GET /api/agent-system/test-sessions/:session_id
 * Get single test session data
 */
export const getTestSession = async (req, res) => {
  try {
    const { session_id } = req.params;

    if (!session_id) {
      return res.status(400).json({
        success: false,
        message: "Session ID is required",
      });
    }

    /* -------------------------------------------------- */
    /* Fetch Test Session */
    /* -------------------------------------------------- */
    const { data: testSession, error } = await supabase
      .from("agent_test_sessions")
      .select("*")
      .eq("test_session_id", session_id)
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

/**
 * GET /api/agent-system/test-sessions
 * Get all test session data for user
 */
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
      .order("created_at", { ascending: false })
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

/**
 * POST /api/agent-system/test-sessions/:batch_id/sync
 * Sync voice test status (Batch Mode) AND deduct credits
 */
export const syncVoiceTestStatus = async (req, res) => {
  try {
    const { batch_id } = req.params;

    if (!batch_id) {
      return res.status(400).json({
        success: false,
        message: "Batch ID is required",
      });
    }

    /* -------------------------------------------------- */
    /* 1️⃣ Fetch Batch From ElevenLabs */
    /* -------------------------------------------------- */
    const response = await axios.get(
      `https://api.elevenlabs.io/v1/convai/batch-calling/${batch_id}`,
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
        },
      },
    );

    const batch = response.data;

    if (!batch || !batch.recipients || batch.recipients.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No recipients found in batch",
      });
    }

    const recipient = batch.recipients[0];

    /* -------------------------------------------------- */
    /* 2️⃣ Map Status */
    /* -------------------------------------------------- */
    let mappedStatus = "processing";
    if (recipient.status === "completed") {
      mappedStatus = "completed";
    } else if (recipient.status === "failed" || recipient.status === "error") {
      mappedStatus = "failed";
    } else if (
      recipient.status === "pending" ||
      recipient.status === "scheduled"
    ) {
      mappedStatus = "queued";
    }

    /* -------------------------------------------------- */
    /* 3️⃣ If Conversation Exists → Fetch Transcript + Duration */
    /* -------------------------------------------------- */
    let transcript = null;
    let duration = null;

    if (recipient.conversation_id) {
      try {
        const convoRes = await axios.get(
          `https://api.elevenlabs.io/v1/convai/conversations/${recipient.conversation_id}`,
          {
            headers: {
              "xi-api-key": process.env.ELEVENLABS_API_KEY,
            },
          },
        );
        const conversation = convoRes.data;
        transcript = conversation.transcript || null;
        duration = conversation.metadata?.call_duration_secs || null;

        console.log(`⏱️  Call duration: ${duration} seconds`);
      } catch (err) {
        console.warn("⚠️ Failed to fetch conversation details");
      }
    }

    /* -------------------------------------------------- */
    /* 4️⃣ Update Test Session */
    /* -------------------------------------------------- */
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
      return res.status(500).json({
        success: false,
        message: "Failed to update test session",
      });
    }

    /* -------------------------------------------------- */
    /* 5️⃣ DEDUCT CREDITS IF CALL COMPLETED */
    /* -------------------------------------------------- */
    let creditsDeducted = null;

    if (mappedStatus === "completed" && duration && duration > 0 && data.user_id) {
      try {
        console.log("💰 Deducting credits for test voice call...");

        // Calculate credits (2 credits per minute for test)
        const creditsToDeduct = calculateVoiceCredits(duration, true); // true = test mode

        console.log(`💰 Credits to deduct: ${creditsToDeduct} (${duration}s × 2/min)`);

        // Get user
        const user = await getUserById(data.user_id);

        if (user && user.credits >= creditsToDeduct) {
          // Deduct credits
          const newCredits = Number((user.credits - creditsToDeduct).toFixed(2));
          await updateUserCredits(data.user_id, newCredits);

          creditsDeducted = creditsToDeduct;

          console.log(`✅ Credits deducted: ${user.credits} → ${newCredits} (-${creditsToDeduct})`);

          // Update test session with credit info
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
        // Don't fail the whole sync if credit deduction fails
      }
    }

    return res.status(200).json({
      success: true,
      message: "Test session synced successfully (Batch Mode)",
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
    return res.status(500).json({
      success: false,
      message: "Failed to sync voice test batch",
    });
  }
};

/**
 * POST /api/agent-system/:agent_id/test-chat
 * Test chatbot in browser using existing AI Decision Engine
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

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "User ID is required for credit tracking",
      });
    }

    // ✅ CHECK CREDITS FIRST
    console.log("💰 Checking credits for test chat...");
    const user = await getUserById(user_id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
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

    console.log(`✅ Credit check passed: ${user.credits} >= ${requiredCredits}`);

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

    // Skip document states in test mode
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

    let finalResponse = aiResponse.reply;

    // ✅ DEDUCT CREDITS AFTER SUCCESSFUL RESPONSE
    let creditsDeducted = null;
    try {
      console.log("💰 Deducting credits for test chat...");
      
      const creditsToDeduct = calculateChatCredits(1, true); // true = test mode
      const newCredits = Number((user.credits - creditsToDeduct).toFixed(2));
      
      await updateUserCredits(user_id, newCredits);
      
      creditsDeducted = creditsToDeduct;
      
      console.log(`✅ Credits deducted: ${user.credits} → ${newCredits} (-${creditsToDeduct})`);
    } catch (creditError) {
      console.error("❌ Error deducting credits:", creditError);
      // Don't fail the response if credit deduction fails
    }

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
            credits_deducted: creditsDeducted,
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
              total_credits_deducted: (existingSession.test_data_collected?.total_credits_deducted || 0) + creditsDeducted,
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
      credits_deducted: creditsDeducted,
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