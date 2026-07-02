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
 * Schedule an approved WhatsApp template message for future delivery.
 * POST /v1/messages/schedule
 * NOTE: wt_id here is the Samvaadik whatsapp_templates table UUID, fetched
 * via getTemplates() — it is NOT Sutrak's own whatsapp_templates.wt_id.
 */
export const scheduleTemplateMessage = async (
  apiKey,
  {
    phone,
    contact_name,
    wt_id,
    scheduled_at,
    timezone,
    template_variables,
    media_id,
  },
) => {
  const res = await client(apiKey).post("/messages/schedule", {
    phone,
    contact_name,
    wt_id,
    scheduled_at,
    ...(timezone && { timezone }),
    ...(template_variables && { template_variables }),
    ...(media_id && { media_id }),
  });
  return res.data;
};

/**
 * Fetch the current status of a previously scheduled template message.
 * GET /v1/messages/schedule/:sm_id
 * Returns: { success, data: { sm_id, status, sent_at, failed_at, error_message, ... } }
 */
export const getScheduledMessageStatus = async (apiKey, sm_id) => {
  const res = await client(apiKey).get(`/messages/schedule/${sm_id}`);
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

/**
 * Step 1 of the media template flow — get a signed URL to upload media to.
 * POST /v1/media/prepare-upload
 * Returns: { success, signed_url, storage_path, expires_in_seconds }
 */
export const prepareMediaUpload = async (apiKey, { file_name, file_type }) => {
  const res = await client(apiKey).post("/media/prepare-upload", {
    file_name,
    file_type,
  });
  return res.data;
};

/**
 * Step 2 of the media template flow — after the caller has PUT the file
 * binary to the signed_url, exchange the storage_path for a Meta media_id
 * + header_handle.
 * POST /v1/media/process-upload
 * Returns: { success, media_id, header_handle, header_format }
 */
export const processMediaUpload = async (
  apiKey,
  { storage_path, file_name, file_type },
) => {
  const res = await client(apiKey).post("/media/process-upload", {
    storage_path,
    file_name,
    file_type,
  });
  return res.data;
};

// Meta rejects footer/button text containing emoji, newlines, variables or
// WhatsApp formatting markers (*, _, ~, `) — strip them defensively since
// this text often comes from free-form user input.
const EMOJI_REGEX =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu;

function stripEmojiAndNewlines(text) {
  return text
    .replace(EMOJI_REGEX, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeButtonText(text) {
  return stripEmojiAndNewlines(text)
    .replace(/\{\{\s*\d+\s*\}\}/g, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Submit a new WhatsApp template (text or media) to Meta for approval.
 * POST /v1/templates
 */
export const createWhatsappTemplate = async (apiKey, payload) => {
  const sanitized = { ...payload };
  if (sanitized.footer_text) {
    sanitized.footer_text = stripEmojiAndNewlines(sanitized.footer_text);
  }
  if (Array.isArray(sanitized.buttons)) {
    sanitized.buttons = sanitized.buttons.map((b) => ({
      ...b,
      text: sanitizeButtonText(b.text),
    }));
  }
  const res = await client(apiKey).post("/templates", sanitized);
  return res.data;
};
