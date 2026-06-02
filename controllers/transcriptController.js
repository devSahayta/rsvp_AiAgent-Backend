// transcriptController.js
// Add this function and wire to:
// GET /api/events/:eventId/participants/:participantId/transcript
// In eventRoutes.js: router.get("/:eventId/participants/:participantId/transcript", getParticipantTranscript);

import axios from "axios";
import { supabase } from "../config/supabase.js";

export const getParticipantTranscript = async (req, res) => {
  try {
    const { eventId, participantId } = req.params;

    // 1. Get conversation_id from conversation_results
    const { data: convo, error: convoError } = await supabase
      .from("conversation_results")
      .select("conversation_id, call_status, call_duration")
      .eq("participant_id", participantId)
      .eq("event_id", eventId)
      .maybeSingle();

    if (convoError) throw convoError;

    if (!convo?.conversation_id) {
      return res.status(404).json({
        success: false,
        error: "No conversation found for this participant",
        call_status: convo?.call_status || "pending",
      });
    }

    // 2. Fetch transcript from ElevenLabs
    const response = await axios.get(
      `https://api.elevenlabs.io/v1/convai/conversations/${convo.conversation_id}`,
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } },
    );

    const data = response.data;

    // 3. Clean transcript — normalise role names
    const transcript = (data.transcript || []).map((turn) => ({
      role: turn.role === "agent" ? "assistant" : "user",
      message: turn.message || turn.content || "",
      time_in_call_secs: turn.time_in_call_secs ?? null,
    }));

    return res.status(200).json({
      success: true,
      conversation_id: convo.conversation_id,
      call_status: data.status,
      call_duration:
        data.metadata?.call_duration_secs || convo.call_duration || null,
      transcript,
      analysis: data.analysis || null,
    });
  } catch (err) {
    console.error(
      "getParticipantTranscript error:",
      err.response?.data || err.message,
    );

    if (err.response?.status === 404) {
      return res.status(404).json({
        success: false,
        error:
          "Transcript not available yet. The call may still be processing.",
      });
    }
    return res
      .status(500)
      .json({ success: false, error: "Failed to fetch transcript" });
  }
};
