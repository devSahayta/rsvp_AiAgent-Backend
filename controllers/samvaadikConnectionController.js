// controllers/samvaadikConnectionController.js

import { supabase } from "../config/supabase.js";
import {
  validateAndFetchAccount,
  updateWebhookUrl,
  getTemplates,
  processMediaUpload,
  createWhatsappTemplate,
} from "../utils/samvaadikClient.js";

import axios from "axios";

// Sutrak's own webhook endpoint — Samvaadik will forward incoming messages here
const SUTRAK_WEBHOOK_URL =
  process.env.SUTRAK_WEBHOOK_URL || "https://sutrak.ai/api/whatsapp/webhook";

/* ─── POST /api/samvaadik/connect ─────────────────────────────────────────── */
/**
 * 1. Validate the API key against Samvaadik GET /v1/account
 * 2. Update the webhook URL on the key (PATCH /v1/me/webhook)
 * 3. Save connection to samvaadik_connections table
 *
 */
export const connectSamvaadik = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const { api_key } = req.body;
    if (!api_key?.trim()) {
      return res.status(400).json({ error: "api_key is required" });
    }

    const trimmedKey = api_key.trim();

    // ── Step 1: Validate key + fetch account info ──────────────────────────
    let accountData;
    try {
      const result = await validateAndFetchAccount(trimmedKey);
      if (!result.success) throw new Error("Invalid response from Samvaadik");
      accountData = result.data;
      console.log(
        "✅ Samvaadik key validated. Account:",
        accountData.business_phone_number,
      );
    } catch (err) {
      console.error(
        "Samvaadik key validation failed:",
        err.response?.data || err.message,
      );
      return res.status(400).json({
        error: "Invalid Samvaadik API key. Please check and try again.",
        details: err.response?.data?.error || err.message,
      });
    }

    // ── Step 2: Update webhook URL on the Samvaadik key ───────────────────
    let webhookSet = false;
    try {
      await updateWebhookUrl(trimmedKey, SUTRAK_WEBHOOK_URL);
      webhookSet = true;
      console.log(
        "✅ Webhook URL updated on Samvaadik key:",
        SUTRAK_WEBHOOK_URL,
      );
    } catch (err) {
      console.error(
        "Webhook update failed:",
        err.response?.data || err.message,
      );
      // Don't block connection if webhook update fails — log it, set webhookSet = false
      // User can re-connect to retry
      console.warn("⚠️ Connection will be saved but webhook_set = false");
    }

    // ── Step 3: Save to DB ─────────────────────────────────────────────────
    const { data, error } = await supabase
      .from("samvaadik_connections")
      .upsert(
        {
          user_id,
          api_key: trimmedKey,
          wa_id: accountData.wa_id || null,
          business_phone: accountData.business_phone_number || null,
          waba_id: accountData.waba_id || null,
          status: "active",
          webhook_set: webhookSet,
          connected_at: new Date().toISOString(),
          last_verified_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      )
      .select(
        "id, business_phone, wa_id, waba_id, status, webhook_set, connected_at",
      )
      .single();

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: webhookSet
        ? "Samvaadik connected successfully. Webhook configured."
        : "Samvaadik connected but webhook update failed. Try reconnecting.",
      data,
    });
  } catch (err) {
    console.error("connectSamvaadik error:", err);
    return res.status(500).json({ error: "Failed to connect Samvaadik" });
  }
};

/* ─── GET /api/samvaadik/status ───────────────────────────────────────────── */
/**
 * Returns the current connection status for the authenticated user.
 */
export const getSamvaadikStatus = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const { data, error } = await supabase
      .from("samvaadik_connections")
      .select(
        "id, business_phone, wa_id, waba_id, status, webhook_set, connected_at, last_verified_at",
      )
      .eq("user_id", user_id)
      .maybeSingle();

    if (error) throw error;

    return res.status(200).json({
      success: true,
      connected: !!data && data.status === "active",
      data: data || null,
    });
  } catch (err) {
    console.error("getSamvaadikStatus error:", err);
    return res.status(500).json({ error: "Failed to get connection status" });
  }
};

/* ─── POST /api/samvaadik/verify ──────────────────────────────────────────── */
/**
 * Re-verify an existing connection is still valid.
 * Re-attempts webhook update if it failed previously.
 */
export const verifySamvaadikConnection = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const { data: conn, error: fetchErr } = await supabase
      .from("samvaadik_connections")
      .select("api_key, webhook_set")
      .eq("user_id", user_id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!conn)
      return res.status(404).json({ error: "No Samvaadik connection found" });

    // Re-validate key
    let accountData;
    try {
      const result = await validateAndFetchAccount(conn.api_key);
      if (!result.success) throw new Error("Key invalid");
      accountData = result.data;
    } catch {
      // Key is no longer valid — mark disconnected
      await supabase
        .from("samvaadik_connections")
        .update({ status: "disconnected" })
        .eq("user_id", user_id);
      return res
        .status(400)
        .json({ error: "API key is no longer valid. Please reconnect." });
    }

    // Re-attempt webhook update if it failed previously
    let webhookSet = conn.webhook_set;
    if (!webhookSet) {
      try {
        await updateWebhookUrl(conn.api_key, SUTRAK_WEBHOOK_URL);
        webhookSet = true;
      } catch {
        console.warn("Webhook re-attempt failed");
      }
    }

    await supabase
      .from("samvaadik_connections")
      .update({
        status: "active",
        webhook_set: webhookSet,
        last_verified_at: new Date().toISOString(),
      })
      .eq("user_id", user_id);

    return res.status(200).json({
      success: true,
      message: "Connection verified",
      data: {
        business_phone: accountData.business_phone_number,
        webhook_set: webhookSet,
      },
    });
  } catch (err) {
    console.error("verifySamvaadikConnection error:", err);
    return res.status(500).json({ error: "Verification failed" });
  }
};

/* ─── DELETE /api/samvaadik/disconnect ────────────────────────────────────── */
/**
 * Remove the Samvaadik connection for the authenticated user.
 */
export const disconnectSamvaadik = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const { error } = await supabase
      .from("samvaadik_connections")
      .delete()
      .eq("user_id", user_id);

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: "Disconnected from Samvaadik",
    });
  } catch (err) {
    console.error("disconnectSamvaadik error:", err);
    return res.status(500).json({ error: "Failed to disconnect" });
  }
};

/* ─── GET /api/samvaadik/templates ────────────────────────────────────────── */
/**
 * Fetch approved templates from Samvaadik for the connected account.
 * Used by Sutrak to populate template dropdowns without duplicating template management.
 */
export const getSamvaadikTemplates = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const { data: conn, error: fetchErr } = await supabase
      .from("samvaadik_connections")
      .select("api_key, status")
      .eq("user_id", user_id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!conn || conn.status !== "active") {
      return res
        .status(400)
        .json({ error: "No active Samvaadik connection found" });
    }

    const result = await getTemplates(conn.api_key);

    return res.status(200).json({
      success: true,
      total: result.total || 0,
      data: result.data || [],
    });
  } catch (err) {
    console.error("getSamvaadikTemplates error:", err);
    return res.status(500).json({ error: "Failed to fetch templates" });
  }
};

export const getSamvaadikTemplateInfo = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const { wt_id } = req.params;

    const { data: conn, error: connErr } = await supabase
      .from("samvaadik_connections")
      .select("api_key, status")
      .eq("user_id", user_id)
      .maybeSingle();

    if (connErr) throw connErr;
    if (!conn || conn.status !== "active")
      return res.status(400).json({ error: "No active Samvaadik connection" });

    const result = await axios.get(
      `${process.env.SAMVAADIK_BASE_URL}/templates/${wt_id}`,
      { headers: { "X-API-Key": conn.api_key } },
    );

    return res.status(200).json(result.data);
  } catch (err) {
    console.error(
      "getSamvaadikTemplate error:",
      err.response?.data || err.message,
    );
    return res.status(500).json({ error: "Failed to fetch template" });
  }
};

export const proxyTemplateMedia = async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "url param required" });

    const decoded = decodeURIComponent(url);

    // Security: only allow WhatsApp CDN domains
    const parsed = new URL(decoded);
    const allowed = [
      "scontent.whatsapp.net",
      "mmg.whatsapp.net",
      "cdn.whatsapp.net",
    ];
    if (!allowed.some((h) => parsed.hostname.endsWith(h))) {
      return res.status(403).json({ error: "Disallowed media host" });
    }

    const response = await axios.get(decoded, {
      responseType: "stream",
      timeout: 15000,
      headers: {
        // WhatsApp CDN requires a WhatsApp-like User-Agent
        "User-Agent": "WhatsApp/2.23.20.0 A",
        Accept: "image/*, video/*, */*",
      },
    });

    res.setHeader(
      "Content-Type",
      response.headers["content-type"] || "image/jpeg",
    );
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    response.data.pipe(res);
  } catch (err) {
    const status = err.response?.status;
    console.error("proxyTemplateMedia error:", status, err.message);

    // CDN URL expired (410) or not found (404) — return an SVG placeholder
    // so the <img> tag doesn't break layout with a broken image icon
    if (status === 410 || status === 404 || status === 403) {
      return res
        .status(200)
        .setHeader("Content-Type", "image/svg+xml")
        .send(
          '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="160" viewBox="0 0 300 160">' +
            '<rect width="300" height="160" fill="#1a1a22" rx="8"/>' +
            '<text x="50%" y="45%" text-anchor="middle" fill="#3f3f46" font-size="13" font-family="system-ui" dy=".3em">📷</text>' +
            '<text x="50%" y="62%" text-anchor="middle" fill="#3f3f46" font-size="11" font-family="system-ui">Preview unavailable</text>' +
            "</svg>",
        );
    }

    return res.status(502).json({ error: "Failed to proxy media" });
  }
};

export const getSamvaadikTemplate = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const { wt_id } = req.params;

    const { data: conn, error: connErr } = await supabase
      .from("samvaadik_connections")
      .select("api_key, status")
      .eq("user_id", user_id)
      .maybeSingle();

    if (connErr) throw connErr;
    if (!conn || conn.status !== "active")
      return res.status(400).json({ error: "No active Samvaadik connection" });

    const result = await axios.get(
      `${process.env.SAMVAADIK_BASE_URL}/templates/${wt_id}`,
      { headers: { "X-API-Key": conn.api_key } },
    );

    return res.status(200).json(result.data);
  } catch (err) {
    console.error(
      "getSamvaadikTemplate error:",
      err.response?.data || err.message,
    );
    return res.status(500).json({ error: "Failed to fetch template" });
  }
};

// ── Add to samvaadikRoutes.js ─────────────────────────────────────────────────
// import { getSamvaadikTemplate } from "../controllers/samvaadikConnectionController.js";
// router.get("/templates/:wt_id", getSamvaadikTemplate);
// NOTE: add ABOVE the existing router.get("/templates", getSamvaadikTemplates)

// ── Also add to samvaadikConnectionController.js ─────────────────────────────

// GET /api/samvaadik/templates/:wt_id/media
// Fetches fresh media URL from Samvaadik (which gets it from Meta Graph API)
export const getSamvaadikTemplateMedia = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const { wt_id } = req.params;

    const { data: conn } = await supabase
      .from("samvaadik_connections")
      .select("api_key, status")
      .eq("user_id", user_id)
      .maybeSingle();

    if (!conn || conn.status !== "active")
      return res.status(400).json({ error: "No active Samvaadik connection" });

    // Call Samvaadik's media-stream endpoint — returns actual image bytes
    const response = await axios.get(
      `${process.env.SAMVAADIK_BASE_URL}/templates/${wt_id}/media-stream`,
      {
        headers: { "X-API-Key": conn.api_key },
        responseType: "stream",
        timeout: 20000,
      },
    );

    // Forward content-type and stream bytes to frontend
    const contentType = response.headers["content-type"] || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    response.data.pipe(res);
  } catch (err) {
    console.error(
      "getSamvaadikTemplateMedia error:",
      err.response?.data || err.message,
    );
    // Return SVG placeholder so <img> doesn't break
    return res
      .status(200)
      .setHeader("Content-Type", "image/svg+xml")
      .send(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="160" viewBox="0 0 300 160">' +
          '<rect width="300" height="160" fill="#1a1a22" rx="8"/>' +
          '<text x="50%" y="45%" text-anchor="middle" fill="#3f3f46" font-size="22" dy=".3em">📷</text>' +
          '<text x="50%" y="65%" text-anchor="middle" fill="#3f3f46" font-size="11" font-family="system-ui">Preview unavailable</text>' +
          "</svg>",
      );
  }
};

/* ─── POST /api/samvaadik/templates/complete-media-upload ────────────────── */
/**
 * Final step of the media-template assistant flow (Option A — signed URL).
 * The frontend already PUT the raw file bytes straight to the signed_url
 * returned by finalize_create_template — this only carries the storage_path,
 * not the bytes. Here we:
 *   1. Exchange storage_path for a Meta media_id + header_handle (process-upload)
 *   2. Submit the template (name/category/body/etc + header_handle/media_id)
 * Called directly by the frontend once the upload PUT succeeds — not through
 * the assistant chat loop, same pattern as the event CSV upload.
 */
export const completeTemplateMediaUpload = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const {
      storage_path,
      file_name,
      file_type,
      name,
      category,
      language,
      body_text,
      body_examples,
      header_format,
      footer_text,
      buttons,
    } = req.body;

    if (!storage_path || !file_name || !file_type) {
      return res.status(400).json({
        error: "storage_path, file_name and file_type are required",
      });
    }
    if (!name || !category || !body_text) {
      return res
        .status(400)
        .json({ error: "name, category and body_text are required" });
    }

    const { data: conn, error: connErr } = await supabase
      .from("samvaadik_connections")
      .select("api_key, status")
      .eq("user_id", user_id)
      .maybeSingle();

    if (connErr) throw connErr;
    if (!conn || conn.status !== "active")
      return res.status(400).json({ error: "No active Samvaadik connection" });

    const processed = await processMediaUpload(conn.api_key, {
      storage_path,
      file_name,
      file_type,
    });
    console.log("Media upload processed:", processed);
    if (!processed.success) {
      return res.status(502).json({
        error: "Failed to process uploaded media",
        details: processed,
      });
    }

    console.log(
      processed.media_id,
      processed.header_handle,
      processed.header_format,
      name,
      category,
      body_text,
      footer_text,
      buttons,
    );

    const templateResult = await createWhatsappTemplate(conn.api_key, {
      name,
      category,
      language: language || "en_US",
      body_text,
      ...(Array.isArray(body_examples) &&
        body_examples.length > 0 && { body_examples }),
      header_format: header_format || processed.header_format,
      header_handle: processed.header_handle,
      media_id: processed.media_id,
      ...(footer_text && { footer_text }),
      ...(Array.isArray(buttons) && buttons.length > 0 && { buttons }),
    });

    console.log("Template creation result:", templateResult);

    if (!templateResult.success) {
      return res.status(502).json({
        error: "Failed to create template",
        details: templateResult,
      });
    }

    return res.status(200).json({
      success: true,
      data: templateResult.data,
      message: templateResult.message,
    });
  } catch (err) {
    console.error(
      "completeTemplateMediaUpload error:",
      err.response?.data || err.message,
    );
    return res.status(500).json({ error: "Failed to create media template" });
  }
};

export const syncWebhooksForAllUsers = async (req, res) => {
  try {
    const webhookUrl = process.env.SUTRAK_WEBHOOK_URL;
    if (!webhookUrl)
      return res.status(500).json({ error: "SUTRAK_WEBHOOK_URL not set" });

    const { data: connections } = await supabase
      .from("samvaadik_connections")
      .select("id, user_id, api_key")
      .eq("status", "active");

    if (!connections?.length) return res.json({ success: true, synced: 0 });

    let synced = 0,
      failed = 0;
    for (const conn of connections) {
      try {
        await updateWebhookUrl(conn.api_key, webhookUrl);
        await supabase
          .from("samvaadik_connections")
          .update({
            webhook_set: true,
            last_verified_at: new Date().toISOString(),
          })
          .eq("id", conn.id);
        synced++;
        console.log(`[syncWebhooks] ✅ user ${conn.user_id}`);
      } catch (err) {
        failed++;
        console.error(`[syncWebhooks] ❌ user ${conn.user_id}:`, err.message);
      }
    }

    return res.json({ success: true, webhook_url: webhookUrl, synced, failed });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
