// utils/samvaadikClient.js
// Thin wrapper around Samvaadik's public API.
// All WhatsApp operations in Sutrak route through this file.

import axios from "axios";

const BASE_URL = process.env.SAMVAADIK_BASE_URL || "https://samvaadik.com/v1";

/**
 * Create an axios instance pre-configured with the API key.
 */
function client(apiKey) {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    timeout: 10000,
  });
}

/**
 * Validate an API key and fetch the connected WhatsApp account details.
 * GET /v1/account
 * Returns: { success, data: { wa_id, business_phone_number, waba_id, status } }
 */
export const validateAndFetchAccount = async (apiKey) => {
  const res = await client(apiKey).get("/account");
  return res.data;
};

/**
 * Update the webhook_url on the currently authenticated Samvaadik API key.
 * This tells Samvaadik where to forward incoming WhatsApp messages to Sutrak.
 * PATCH /v1/me/webhook
 */
export const updateWebhookUrl = async (apiKey, webhookUrl) => {
  const res = await client(apiKey).patch("/me/webhook", {
    webhook_url: webhookUrl,
  });
  return res.data;
};

/**
 * Send a free-text WhatsApp message (within 24h window only).
 * POST /v1/messages/text
 */
export const sendText = async (apiKey, phone, message) => {
  const res = await client(apiKey).post("/messages/text", { phone, message });
  return res.data;
};

/**
 * Send an approved WhatsApp template message (any time).
 * POST /v1/messages/template
 */
export const sendTemplate = async (
  apiKey,
  {
    phone,
    template_name,
    language = "en_US",
    parameters = [],
    header_media_id = null,
  },
) => {
  const res = await client(apiKey).post("/messages/template", {
    phone,
    template_name,
    language,
    parameters,
    ...(header_media_id && { header_media_id }),
  });
  return res.data;
};

/**
 * Send an interactive message with quick-reply buttons (within 24h window).
 * POST /v1/messages/interactive — max 3 buttons
 * buttons: [{ id: "btn_yes", title: "Yes" }, ...]
 */
export const sendInteractive = async (
  apiKey,
  { phone, body_text, buttons },
) => {
  const res = await client(apiKey).post("/messages/interactive", {
    phone,
    body_text,
    buttons,
  });
  return res.data;
};

/**
 * Fetch all approved templates for the connected WhatsApp account.
 * GET /v1/templates
 */
export const getTemplates = async (apiKey) => {
  const res = await client(apiKey).get("/templates");
  return res.data;
};
