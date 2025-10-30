import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;


export const sendWhatsAppMessage = async (to, participantName = null) => {
  try {
    // ✅ Only use first name, no sentences!
    const name = (participantName || "there").split(" ")[0];
    const cleanText = name.replace(/[\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();

    const res = await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: "rsvp_invite",
          language: { code: "en_US" },
          components: [
            {
              type: "body",
              parameters: [
                {
                  type: "text",
                  text: cleanText
                }
              ]
            }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.data;

  } catch (err) {
    console.error("❌ Error sending WhatsApp message:", err.response?.data || err.message);
    return { error: true };
  }
};

export const sendWhatsAppTextMessage = async (to, message) => {
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
    return res.data;
  } catch (err) {
    console.error("❌ Error sending text:", err.response?.data || err.message);
    return { error: true };
  }
};

