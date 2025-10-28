import { supabase } from "../config/supabase.js";

export const getConversationByParticipant = async (participant_id) => {
  const { data, error } = await supabase
    .from("conversation_results")
    .select("*")
    .eq("participant_id", participant_id)
    .order("last_updated", { ascending: false })
    .limit(1)
    .single();

  if (error) throw error;
  return data;
};

// Get by event_id (old approach - keep for backup)
export const getCompletedCallsByEvent = async (event_id) => {
  const { data, error } = await supabase
    .from("conversation_results")
    .select("*")
    .eq("event_id", event_id)
    .eq("call_status", "completed")
    .not("call_duration", "is", null);

  if (error) throw error;
  return data || [];
};

export const updateConversationWithAPIData = async (
  conversationId,
  phoneNumber,
  callDuration,
  callStatus
) => {
  console.log(`💾 Updating conversation for ${phoneNumber}: ${conversationId}`);

  // Step 1️⃣: Get participant_id from participants table
  const { data: participantData, error: participantError } = await supabase
    .from("participants")
    .select("participant_id")
    .eq("phone_number", phoneNumber)
    .single();

  if (participantError || !participantData) {
    console.error("❌ Could not find participant:", participantError || "Not found");
    return null;
  }

  const participantId = participantData.participant_id;

  // Step 2️⃣: Update conversation_results using participant_id
  const { data, error } = await supabase
    .from("conversation_results")
    .update({
      conversation_id: conversationId,
      call_duration: callDuration,
      call_status: callStatus,
      last_updated: new Date().toISOString(),
    })
    .eq("participant_id", participantId);

  if (error) {
    console.error("❌ Error updating conversation:", error);
    throw error;
  }

  if (!data || data.length === 0) {
    console.warn(`⚠️ No matching conversation record found for participant_id ${participantId}`);
  } else {
    console.log(`✅ Updated record for ${phoneNumber} (participant_id: ${participantId})`);
  }

  return data;
};


// ✅ NEW: Get participants by event_id
export const getParticipantsByEvent = async (event_id) => {
  const { data, error } = await supabase
    .from("conversation_results")
    .select("participant_id, phone_number")
    .eq("event_id", event_id);

  if (error) throw error;
  return data || [];
};