import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ✅ NEW FUNCTION — For Initial Template Messages
export const sendInitialTemplateMessage = async (to, templateName, components) => {
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: "en_US" },
          components: components,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`✅ Message sent to ${to}`, res.data);
    return res.data;

  } catch (err) {
    console.error(`❌ WhatsApp send error for ${to}:`, err.response?.data || err.message);
    throw err;
  }
};

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
          name: "invite_rsvp",
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

export async function fetchMediaUrl(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/v17.0/${mediaId}`;
  try {
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    // resp.data contains { id, mime_type, url, ... }
    return resp.data.url; // this is the public temporary URL
  } catch (err) {
    console.error("❌ fetchMediaUrl error:", err.response?.data || err.message);
    return null;
  }
}
