// controllers/transcriptController.js

import axios from "axios";
import { supabase } from "../config/supabase.js";

/**
 * GET /api/events/:eventId/participants/:participantId/transcript
 * Returns conversation details + transcript from ElevenLabs
 */
export const getParticipantTranscript = async (req, res) => {
  try {
    const { eventId, participantId } = req.params;

    const { data: callLog, error: logError } = await supabase
      .from("event_call_logs")
      .select("conversation_id, call_outcome, call_duration")
      .eq("participant_id", participantId)
      .eq("event_id", eventId)
      .maybeSingle();

    if (logError) throw logError;

    if (!callLog?.conversation_id) {
      return res.status(404).json({
        success: false,
        error: "No conversation found for this participant",
        call_outcome: callLog?.call_outcome || "pending",
      });
    }

    const response = await axios.get(
      `https://api.elevenlabs.io/v1/convai/conversations/${callLog.conversation_id}`,
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } },
    );

    const data = response.data;

    const transcript = (data.transcript || []).map((turn) => ({
      role: turn.role === "agent" ? "assistant" : "user",
      message: turn.message || turn.content || "",
      time_in_call_secs: turn.time_in_call_secs ?? null,
    }));

    const duration =
      data.metadata?.call_duration_secs || callLog.call_duration || null;

    // Backfill duration if missing
    if (duration && !callLog.call_duration) {
      await supabase
        .from("event_call_logs")
        .update({
          call_duration: duration,
          updated_at: new Date().toISOString(),
        })
        .eq("event_id", eventId)
        .eq("participant_id", participantId);
    }

    // Quick stats
    const agentTurns = transcript.filter((t) => t.role === "assistant").length;
    const userTurns = transcript.filter((t) => t.role === "user").length;

    return res.status(200).json({
      success: true,
      conversation_id: callLog.conversation_id,
      call_outcome: callLog.call_outcome,
      call_duration: duration,
      has_audio: data.has_audio || false,
      transcript,
      analysis: data.analysis || null,
      stats: {
        agent_turns: agentTurns,
        user_turns: userTurns,
        total_turns: transcript.length,
        start_time: data.metadata?.start_time_unix_secs || null,
      },
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

/**
 * GET /api/events/:eventId/participants/:participantId/audio
 * Proxies the ElevenLabs audio stream to the frontend
 * (API key stays on server — never exposed to client)
 */
export const getParticipantAudio = async (req, res) => {
  try {
    const { eventId, participantId } = req.params;

    const { data: callLog, error: logError } = await supabase
      .from("event_call_logs")
      .select("conversation_id, call_outcome")
      .eq("participant_id", participantId)
      .eq("event_id", eventId)
      .maybeSingle();

    if (logError) throw logError;

    if (!callLog?.conversation_id) {
      return res
        .status(404)
        .json({ success: false, error: "No conversation found" });
    }

    // Proxy audio from ElevenLabs
    const audioResponse = await axios.get(
      `https://api.elevenlabs.io/v1/convai/conversations/${callLog.conversation_id}/audio`,
      {
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
        responseType: "stream",
      },
    );

    // Forward content-type and stream directly
    res.setHeader(
      "Content-Type",
      audioResponse.headers["content-type"] || "audio/mpeg",
    );
    res.setHeader("Cache-Control", "private, max-age=3600");
    audioResponse.data.pipe(res);
  } catch (err) {
    console.error(
      "getParticipantAudio error:",
      err.response?.data || err.message,
    );
    if (err.response?.status === 404) {
      return res
        .status(404)
        .json({ success: false, error: "Audio not available" });
    }
    return res
      .status(500)
      .json({ success: false, error: "Failed to fetch audio" });
  }
};
