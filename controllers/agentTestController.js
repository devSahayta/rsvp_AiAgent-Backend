// controllers/agentTestController.js
import axios from "axios";
import { supabase } from "../config/supabase.js";
import { submitTestBatchCall } from "../utils/elevenlabsApi.js";
import decideNextStep from "../utils/aiDecisionEngine.js";

const ELEVENLABS_AGENT_PHONE_NUMBER_ID = process.env.ELEVENLABS_PHONE_NUMBER_ID;

export const testVoiceAgent = async (req, res) => {
  try {
    const { agent_id } = req.params;
    const { to_number, eventName } = req.body;

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

    const dynamic_variables = {
      eventId: String(agent_id),
      eventName: String(eventName),
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
    /* 3️⃣ Create Test Session */
    /* -------------------------------------------------- */
    const { data: testSession, error: testError } = await supabase
      .from("agent_test_sessions")
      .insert([
        {
          agent_id,
          user_id: agent.user_id,
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
    /* 4️⃣ Update Agent Counters + Save Batch ID */
    /* -------------------------------------------------- */
    await supabase
      .from("agents")
      .update({
        total_tests: agent.total_tests + 1,
        total_calls: agent.total_calls + 1,
        last_used_at: new Date(),
        // last_batch_id: elevenResponse.batch_id, // 🔥 NEW
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
    });
  } catch (err) {
    console.error("Voice test batch error:", err);

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

// Sync voice test status (Batch Mode)
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

    // Since test = single recipient
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
    /* 3️⃣ If Conversation Exists → Fetch Transcript */
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

    return res.status(200).json({
      success: true,
      message: "Test session synced successfully (Batch Mode)",
      data,
      debug: {
        batch_status: batch.status,
        recipient_status: recipient.status,
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
 *
 * This endpoint uses your EXISTING aiDecisionEngine.js without ANY modifications!
 * It just wraps it with test-specific context that won't affect production.
 */
export const testChatAgent = async (req, res) => {
  try {
    const { agent_id } = req.params;
    const { user_id, message } = req.body;

    // Validate input
    if (!message?.trim()) {
      return res.status(400).json({
        success: false,
        error: "Message is required",
      });
    }

    console.log(
      ":telephone_receiver: TEST CHAT - Agent:",
      agent_id,
      "Message:",
      message,
    );

    // 1. Get agent details with KB
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select(
        `
          *,
          agent_templates (
          name,
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

    if (agentError || !agent) {
      console.error(":x: Agent not found:", agentError);
      return res.status(404).json({
        success: false,
        error: "Agent not found",
      });
    }

    console.log(":white_check_mark: Agent found:", agent.agent_name);
    console.log(":books: KB ID:", agent.knowledge_base_id);

    // 2. Build context for aiDecisionEngine (same structure as production)
    const context = {
      // User message
      userMessage: message,

      // Call status: Use "completed" state for Q&A mode (bypasses RSVP flow)
      callStatus: "completed",

      // Mock participant (test user)
      participant: {
        participant_id: "test-user-" + Date.now(),
        full_name: "Test User",
        phone: "+919999999999",
      },

      // Mock conversation state (empty for test)
      convo: {
        rsvp_status: null,
        number_of_guests: null,
        notes: null,
        proof_uploaded: false,
      },

      // Empty cache (no document collection in test)
      cache: {},

      // Event with KB link (CRITICAL for KB fetching)
      event: {
        event_id: "test-event-" + Date.now(),
        event_name: "Test Event",
        knowledge_base_id: agent.knowledge_base_id, // :white_check_mark: This makes KB work!
      },

      // No media in chat test
      incomingMediaUrl: null,
      uploadedDocuments: [],
    };

    console.log(
      ":arrows_counterclockwise: Calling aiDecisionEngine with context...",
    );

    // 3. Call existing AI Decision Engine
    // This will:
    // - Detect if message needs wedding info (venue, date, etc.)
    // - Fetch KB content via getWeddingInfo(event.knowledge_base_id)
    // - Use Claude API with proper prompts
    // - Return intelligent response
    const aiResponse = await decideNextStep(context);

    console.log(
      ":white_check_mark: AI Response received:",
      aiResponse.reply?.substring(0, 100),
    );

    // 4. Log or Update test interaction (Backend-managed single session)
    try {
      // 🔍 Check if an active session already exists for this user + agent
      const { data: existingSession, error: sessionFetchError } = await supabase
        .from("agent_test_sessions")
        .select("test_session_id, test_transcript")
        .eq("agent_id", agent_id)
        .eq("user_id", user_id || "anonymous")
        .eq("test_type", "chat")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(); // ✅ Important (no error if not found)

      if (sessionFetchError) {
        console.error("❌ Session fetch error:", sessionFetchError);
      }

      // 🆕 FIRST MESSAGE → Create new session (DB auto-generates UUID)
      if (!existingSession) {
        const { data: newSession, error: insertError } = await supabase
          .from("agent_test_sessions")
          .insert({
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
                message: aiResponse.reply,
                timestamp: new Date().toISOString(),
              },
            ]),
            test_data_collected: {
              conversation_started: true,
            },
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          })
          .select("test_session_id") // 🔥 Get auto-generated ID
          .single();

        if (insertError) {
          console.error("❌ Insert session error:", insertError);
        } else {
          console.log(
            "🆕 New test session created:",
            newSession.test_session_id,
          );
        }
      } else {
        // 📝 EXISTING SESSION → Append messages to transcript
        let transcript = [];

        try {
          transcript = JSON.parse(existingSession.test_transcript || "[]");
        } catch (e) {
          console.warn("⚠️ Transcript parse failed, resetting:", e.message);
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
            message: aiResponse.reply,
            timestamp: new Date().toISOString(),
          },
        );

        const { error: updateError } = await supabase
          .from("agent_test_sessions")
          .update({
            test_transcript: JSON.stringify(transcript),
            test_status: "active",
            updated_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          })
          .eq("test_session_id", existingSession.test_session_id);

        if (updateError) {
          console.error("❌ Update session error:", updateError);
        } else {
          console.log(
            "📝 Session updated (single record):",
            existingSession.test_session_id,
          );
        }
      }

      console.log("✅ Backend-managed single test session working");
    } catch (logError) {
      console.warn("⚠️ Failed to log test session:", logError.message);
    }

    // 5. Return response
    res.json({
      success: true,
      response: aiResponse.reply,
      metadata: {
        agent_name: agent.agent_name,
        used_kb: !!agent.knowledge_base_id,
        kb_name: agent.knowledge_bases?.name,
      },
    });
  } catch (error) {
    console.error(":x: Chat test error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to process chat message",
      details: error.message,
    });
  }
};
