import axios from 'axios';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const BASE_URL = 'https://api.elevenlabs.io/v1/convai';

export const elevenlabsApi = {
  // Get batch call with all recipients and conversation_ids
  getBatchCallInfo: async (batchId) => {
    try {
      console.log(`🔍 Fetching batch info: ${batchId}`);
      const response = await axios.get(
        `${BASE_URL}/batch-calling/${batchId}`,
        {
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
          },
        }
      );
      console.log(`✅ Batch status: ${response.data.status}`);
      return response.data;
    } catch (error) {
      console.error('❌ Error fetching batch:', error.response?.data || error.message);
      throw error;
    }
  },

  // Get list of conversations (for fetching call_duration_secs)
  listConversations: async () => {
    try {
      console.log('🔍 Fetching conversations list...');
      const response = await axios.get(
        `${BASE_URL}/conversations`,
        {
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
          },
          params: {
            page_size: 100, // Adjust as needed
          },
        }
      );
      console.log(`✅ Found ${response.data.conversations.length} conversations`);
      return response.data.conversations;
    } catch (error) {
      console.error('❌ Error listing conversations:', error.response?.data || error.message);
      throw error;
    }
  },
};
