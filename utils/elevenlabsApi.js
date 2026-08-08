//utils/elevenlabsApi.js

import axios from "axios";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const BASE_URL = "https://api.elevenlabs.io/v1/convai";
const ROOT_URL = "https://api.elevenlabs.io/v1";

const headers = {
  "xi-api-key": ELEVENLABS_API_KEY,
  "Content-Type": "application/json",
};

export const elevenlabsApi = {
  // Get batch call with all recipients and conversation_ids
  getBatchCallInfo: async (batchId) => {
    try {
      console.log(`🔍 Fetching batch info: ${batchId}`);
      const response = await axios.get(`${BASE_URL}/batch-calling/${batchId}`, {
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      });
      console.log(`✅ Batch status: ${response.data.status}`);
      return response.data;
    } catch (error) {
      console.error(
        "❌ Error fetching batch:",
        error.response?.data || error.message,
      );
      throw error;
    }
  },

  // Get list of conversations (for fetching call_duration_secs)
  listConversations: async () => {
    try {
      console.log("🔍 Fetching conversations list...");
      const response = await axios.get(`${BASE_URL}/conversations`, {
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
        params: {
          page_size: 100, // Adjust as needed
        },
      });
      console.log(
        `✅ Found ${response.data.conversations.length} conversations`,
      );
      return response.data.conversations;
    } catch (error) {
      console.error(
        "❌ Error listing conversations:",
        error.response?.data || error.message,
      );
      throw error;
    }
  },

  // Get full details for one conversation — includes real cost (cost_fiat in USD)
  getConversationDetails: async (conversationId) => {
    try {
      const response = await axios.get(
        `${BASE_URL}/conversations/${conversationId}`,
        {
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY,
          },
        },
      );
      return response.data;
    } catch (error) {
      console.error(
        `❌ Error fetching conversation details for ${conversationId}:`,
        error.response?.data || error.message,
      );
      throw error;
    }
  },
};

export const listElevenLabsKB = async () => {
  const res = await axios.get(`${BASE_URL}/knowledge-base`, { headers });
  return res.data.documents;
};

export const createTextKnowledgeBase = async ({ name, text }) => {
  const res = await axios.post(
    `${BASE_URL}/knowledge-base/text`,
    { name, text },
    { headers },
  );

  return res.data; // { id, name }
};

export const getKnowledgeBaseContent = async (kbId) => {
  const res = await axios.get(`${BASE_URL}/knowledge-base/${kbId}/content`, {
    headers,
  });
  return res.data;
};

export const deleteElevenLabsKB = async (kbId) => {
  await axios.delete(`${BASE_URL}/knowledge-base/${kbId}`, { headers });
  // ElevenLabs returns 204 No Content
  return true;
};

// Import a public shared-library voice into our ElevenLabs account's voice
// library. Required before that voice_id can be used in TTS/conversational
// calls — shared-voices results are only browsable/previewable until added.
export const addSharedVoice = async ({ publicOwnerId, voiceId, newName }) => {
  const res = await axios.post(
    `${ROOT_URL}/voices/add/${publicOwnerId}/${voiceId}`,
    { new_name: newName },
    { headers },
  );
  return res.data; // { voice_id }
};

// Get agent config
export const getAgent = async (agentId) => {
  const res = await axios.get(`${BASE_URL}/agents/${agentId}`, { headers });
  return res.data;
};

// Duplicate agent
export const duplicateAgent = async ({ agentId, name }) => {
  const res = await axios.post(
    `${BASE_URL}/agents/${agentId}/duplicate`,
    { name },
    { headers },
  );
  return res.data; // returns new agent object
};

// Update agent (FULL payload required)
export const updateAgent = async ({ agentId, payload }) => {
  const res = await axios.patch(`${BASE_URL}/agents/${agentId}`, payload, {
    headers,
  });
  return res.data;
};

// Delete agent
export const deleteAgent = async (agentId) => {
  await axios.delete(`${BASE_URL}/agents/${agentId}`, { headers });
  return true; // 204
};

// Outbound voice call (Test Voice Agent)
export const outboundCall = async ({
  agentId,
  agentPhoneNumberId,
  toNumber,
}) => {
  try {
    console.log("📞 Initiating ElevenLabs outbound call...");

    const response = await axios.post(
      `${BASE_URL}/twilio/outbound-call`,
      {
        agent_id: agentId,
        agent_phone_number_id: agentPhoneNumberId,
        to_number: toNumber,
      },
      { headers },
    );

    console.log("✅ ElevenLabs call initiated:", response.data);

    return response.data;
  } catch (error) {
    console.error(
      "❌ ElevenLabs outbound call error:",
      error.response?.data || error.message,
    );
    throw error;
  }
};

// Batch voice call (Single Test Mode)
export const submitTestBatchCall = async ({
  agentId,
  agentPhoneNumberId,
  toNumber,
  dynamicVariables = {},
  voiceId = null, // Optional: override agent's default voice
}) => {
  try {
    console.log("📞 Initiating ElevenLabs TEST batch call...");

    // Format phone to E.164
    let formattedPhone = String(toNumber).trim();
    if (!formattedPhone.startsWith("+")) {
      formattedPhone = "+" + formattedPhone;
    }

    const scheduledUnix = Math.floor(Date.now() / 1000) + 10;

    const payload = {
      call_name: `test-${Date.now()}`,
      agent_id: agentId,
      agent_phone_number_id: agentPhoneNumberId,
      whatsapp_params: null,
      scheduled_time_unix: scheduledUnix,
      recipients: [
        {
          id: "test-user",
          phone_number: formattedPhone,
          conversation_initiation_client_data: {
            conversation_config_override: {
              agent: {
                prompt: null,
                first_message: null,
                language: null,
              },
              tts: {
                voice_id: voiceId,
              },
            },
            dynamic_variables: dynamicVariables,
          },
        },
      ],
    };

    console.log("📦 TEST BATCH PAYLOAD:");
    console.log(JSON.stringify(payload, null, 2));

    const response = await fetch(
      "https://api.elevenlabs.io/v1/convai/batch-calling/submit",
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    const data = await response.json();

    console.log("📥 ElevenLabs Test Batch Response:", data);

    if (!response.ok) {
      return { success: false, error: data };
    }

    return {
      success: true,
      batch_id: data.id,
      batch_status: data.status,
      full_response: data,
    };
  } catch (error) {
    console.error("❌ Test Batch Call Error:", error);
    return { success: false, error };
  }
};
