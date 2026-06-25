import { supabase } from "../config/supabase.js";

// ─────────────────────────────────────────────────────────────────────────────
// ADD THIS ROUTE to your existing routes/elevenLabsToolRoutes.js
// This is the test-mode save endpoint — always returns success, never hits DB.
// ElevenLabs tool calls are redirected here during test voice calls.
// ─────────────────────────────────────────────────────────────────────────────

// Add this import at the top of your elevenLabsToolRoutes.js:
// import { supabase } from "../config/supabase.js";

// Add this route BEFORE your existing routes:

router.post("/test-save-response", async (req, res) => {
  try {
    const {
      participant_id,
      event_id,
      field_key,
      field_value,
      guest_id,
      call_outcome,
      call_notes,
    } = req.body;

    console.log(`🧪 TEST MODE save-response received:`);
    console.log(`   participant_id: ${participant_id}`);
    console.log(`   event_id: ${event_id}`);
    console.log(`   field_key: ${field_key} = ${field_value}`);
    console.log(`   call_outcome: ${call_outcome}`);

    // Try to update the test session with the collected data (best effort)
    if (event_id) {
      try {
        // Find the most recent test session for this agent/event
        const { data: session } = await supabase
          .from("agent_test_sessions")
          .select("test_session_id, test_data_collected")
          .eq("agent_id", event_id)
          .eq("test_type", "voice")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (session) {
          const existing = session.test_data_collected || {};
          const collected = existing.collected_answers || {};

          // Merge new field answer in
          if (field_key && field_value !== undefined) {
            collected[field_key] = field_value;
          }

          await supabase
            .from("agent_test_sessions")
            .update({
              test_data_collected: {
                ...existing,
                collected_answers: collected,
                call_outcome: call_outcome || existing.call_outcome,
                call_notes: call_notes || existing.call_notes,
                last_field_saved: field_key,
              },
              updated_at: new Date().toISOString(),
            })
            .eq("test_session_id", session.test_session_id);

          console.log(`✅ Test session updated with field: ${field_key}`);
        }
      } catch (dbErr) {
        // Non-fatal — test session update is best-effort
        console.warn(`⚠️ Could not update test session:`, dbErr.message);
      }
    }

    // Always return success so the ElevenLabs agent continues the conversation
    return res.json({
      success: true,
      saved: field_key || "all_fields",
      test_mode: true,
      message: "Test mode — response acknowledged",
    });
  } catch (err) {
    console.error("❌ test-save-response error:", err);
    // Even on error, return success so ElevenLabs doesn't cut the call
    return res.json({
      success: true,
      test_mode: true,
      message: "Test mode — acknowledged with error",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Also add this test-mode get-event-info endpoint (read-only, works fine but
// logs clearly so you can see it being called):
// ─────────────────────────────────────────────────────────────────────────────

router.post("/test-get-event-info", async (req, res) => {
  try {
    const { event_id, kb_id, question } = req.body;
    console.log(
      `🧪 TEST MODE get-event-info: "${question}" for event ${event_id || kb_id}`,
    );

    // Fetch KB using either event_id (agents table) or kb_id directly
    let kbContent = null;
    let eventName = "the event";

    const lookupId = event_id || kb_id;
    if (lookupId) {
      // Try agents table first (event_id = agent_id in this system)
      const { data: agent } = await supabase
        .from("agents")
        .select("event_title, knowledge_base_id")
        .eq("agent_id", lookupId)
        .maybeSingle();

      if (agent?.knowledge_base_id) {
        eventName = agent.event_title || eventName;
        const { data: kb } = await supabase
          .from("knowledge_bases")
          .select("content")
          .eq("id", agent.knowledge_base_id)
          .maybeSingle();
        kbContent = kb?.content || null;
      }

      // Fallback: try knowledge_bases directly
      if (!kbContent) {
        const { data: kb } = await supabase
          .from("knowledge_bases")
          .select("content, name")
          .eq("id", lookupId)
          .maybeSingle();
        kbContent = kb?.content || null;
        eventName = kb?.name || eventName;
      }
    }

    return res.json({
      success: true,
      event_name: eventName,
      knowledge:
        kbContent || "No knowledge base content available for this event.",
      instruction: `Using ONLY the knowledge above, answer this guest question: "${question}". If the answer is not in the knowledge, say "I don't have that detail right now, but the organizer will help you."`,
      test_mode: true,
    });
  } catch (err) {
    console.error("❌ test-get-event-info error:", err);
    return res.json({
      success: true,
      knowledge: "",
      instruction: `Answer the guest question: "${req.body?.question}". If unsure, say you'll check with the organizer.`,
      test_mode: true,
    });
  }
});
