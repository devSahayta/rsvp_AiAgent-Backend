// controllers/whatsappController.js - WITH PRODUCTION CREDIT DEDUCTION + SMART FIELDS AGENT

import dotenv from "dotenv";
dotenv.config();
import axios from "axios";

import {
  sendInitialTemplateMessage,
  sendWhatsAppTextMessage,
  fetchMediaUrl,
} from "../utils/whatsappClient.js";
import decideNextStep from "../utils/aiDecisionEngine.js";
import { agentChatEngine } from "../utils/agentChatEngine.js";
import { supabase } from "../config/supabase.js";
import * as chatCtrl from "./chatController.js";
import { autoExtractFromImage } from "../utils/autoExtractor.js";
import {
  CREDIT_PRICING,
  calculateChatCredits,
  MIN_CHAT_CREDIT_HOLD,
  formatCredits,
} from "../config/creditPricing.js";
import { getUserById, updateUserCredits } from "../models/userModel.js";
import {
  settleChatFromUsage,
  logOcrUsage,
} from "../models/creditLedgerModel.js";
import { generalChatEngine } from "../utils/generalChatEngine.js";

import {
  saveUploadRow,
  saveTravelItinerary,
} from "../utils/documentStorage.js";

// Computes + logs the combined Vision + Claude cost of a document
// extraction attempt, returns the USD total to feed into settleChatFromUsage's
// ocrCostUsd param. Returns 0 (no-op) if nothing was actually extracted.
async function computeAndLogOcrCost({
  userId,
  conversationId,
  participantId,
  eventId,
  visionUnits,
  claudeUsage,
  documentType,
}) {
  const hasVision = visionUnits && visionUnits > 0;
  const hasClaudeUsage = claudeUsage && claudeUsage.length > 0;
  if (!hasVision && !hasClaudeUsage) return 0;

  const claude = claudeUsage?.[0] || {};
  return await logOcrUsage({
    userId,
    conversationId,
    participantId,
    eventId,
    visionUnits: visionUnits || 0,
    claudeInputTokens: claude.input_tokens || 0,
    claudeOutputTokens: claude.output_tokens || 0,
    claudeModel: claude.model || "claude-haiku-4-5-20251001",
    documentType: documentType || "travel_ticket",
  });
}

const convoCache = new Map();
const BUCKET_NAME = process.env.SUPABASE_BUCKET || "participant-docs";
const TEMPLATE_URL = process.env.TEMPLATE_BASE_URL;

// ← ADD THIS LINE
const batchJobs = new Map();

function updateJob(batchId, patch) {
  const job = batchJobs.get(batchId) || {};
  batchJobs.set(batchId, { ...job, ...patch });
}

function updateParticipant(batchId, participantId, patch) {
  const job = batchJobs.get(batchId) || { participants: {} };
  const participants = {
    ...(job.participants || {}),
    [participantId]: { ...(job.participants?.[participantId] || {}), ...patch },
  };
  batchJobs.set(batchId, { ...job, participants });
}

// Persistent conversation cache for Samvaadik classic-mode doc collection
// (mirrors the same pattern used in handleIncomingMessage)
const samvaadikConvoCache = new Map();

function ensureSamvaadikCache(pid) {
  if (!samvaadikConvoCache.has(pid)) {
    samvaadikConvoCache.set(pid, {
      currentDoc: { name: null, role: null, type: null },
    });
  }
  return samvaadikConvoCache.get(pid);
}

/* ---------------------------
   Fetch Template
   --------------------------- */
async function fetchTemplateFromSystem(templateName) {
  const userId = "kp_c7f2725ff7a74158bb7eae3060d6f1de";
  const url = `${TEMPLATE_URL}?user_id=${userId}&templateName=${templateName}`;
  try {
    const { data } = await axios.get(url);
    return data.template;
  } catch (err) {
    console.error("⚠️ Failed to fetch WA template:", err.response?.data || err);
    return null;
  }
}

/* ---------------------------
   ✅ Resolve user_id from event or WA account
   --------------------------- */
async function getUserIdForEvent(waAccounts, eventId) {
  try {
    if (eventId) {
      const { data: eventRow } = await supabase
        .from("events")
        .select("user_id")
        .eq("event_id", eventId)
        .maybeSingle();

      if (eventRow?.user_id) return eventRow.user_id;
    }

    if (waAccounts?.length > 0) return waAccounts[0].user_id;

    return null;
  } catch (err) {
    console.error("[CREDITS] ❌ Error resolving user_id:", err.message);
    return null;
  }
}

/* ---------------------------
   ✅ Deduct production chat credits
   Called after every successful AI reply sent via WhatsApp.
   Never blocks message flow — graceful degradation on failure.
   --------------------------- */
async function deductProductionChatCredits(userId, context = {}) {
  try {
    if (!userId) {
      console.warn("[CREDITS] ⚠️ No user_id — skipping deduction");
      return null;
    }

    const user = await getUserById(userId);
    if (!user) {
      console.warn(`[CREDITS] ⚠️ User ${userId} not found`);
      return null;
    }

    const creditsToDeduct = calculateChatCredits(1, false); // production = 2 credits/msg

    if (user.credits <= 0) {
      console.warn(`[CREDITS] ⚠️ User ${userId} already at 0 credits`);
      return { creditsDeducted: 0, newBalance: 0, wasInsufficient: true };
    }

    // Floor at 0 — never go negative
    const newCredits =
      user.credits < creditsToDeduct
        ? 0
        : Number((user.credits - creditsToDeduct).toFixed(2));

    await updateUserCredits(userId, newCredits);

    console.log(
      `[CREDITS] ✅ Deducted for user ${userId}: ` +
        `${user.credits} → ${newCredits} (-${creditsToDeduct}) | ` +
        `ctx: pid=${context.participant_id} event=${context.event_id}`,
    );

    return {
      creditsDeducted: creditsToDeduct,
      newBalance: newCredits,
      wasInsufficient: user.credits < creditsToDeduct,
    };
  } catch (err) {
    console.error("[CREDITS] ❌ Deduction error:", err.message);
    return null; // never block message flow
  }
}

/* ---------------------------
   Cache Helpers
   --------------------------- */
function ensureCache(participant) {
  const pid = participant.participant_id;
  if (!convoCache.has(pid)) {
    const initial = {
      call_status: "awaiting_rsvp",
      currentDoc: { name: null, role: null, type: null },
      pendingDocs: [],
      lastUpdated: new Date(),
    };
    convoCache.set(pid, initial);
    return initial;
  }
  return convoCache.get(pid);
}

async function ensureConversationRow(pid, eventId) {
  const { data: existing } = await supabase
    .from("conversation_results")
    .select("*")
    .eq("participant_id", pid)
    .maybeSingle();

  if (!existing) {
    const { data: newRow, error } = await supabase
      .from("conversation_results")
      .insert({
        participant_id: pid,
        event_id: eventId,
        call_status: "awaiting_rsvp",
        last_updated: new Date().toISOString(),
      })
      .select()
      .maybeSingle();

    if (error) {
      console.error("❌ Error creating conversation row:", error);
      throw error;
    }
    console.log("✅ Created new conversation row:", newRow);
    return newRow;
  }

  if (!existing.event_id && eventId) {
    const { error: updateError } = await supabase
      .from("conversation_results")
      .update({ event_id: eventId })
      .eq("participant_id", pid);

    if (updateError) console.error("❌ Error updating event_id:", updateError);
    else {
      console.log("✅ Updated event_id for existing conversation");
      existing.event_id = eventId;
    }
  }

  return existing;
}

async function uploadRemoteToBucket(
  mediaUrl,
  participantId,
  eventId,
  origFilename = null,
) {
  try {
    if (!mediaUrl) return null;

    const resp = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    });

    if (!resp.ok) {
      console.error("❌ Failed to fetch WhatsApp media:", resp.status);
      return null;
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    const ts = Date.now();
    const safeName = origFilename
      ? origFilename.replace(/\s+/g, "_")
      : `document_${ts}`;

    const storagePath = `${participantId}/${eventId}/${ts}_${safeName}`;
    console.log("📦 Uploading private file:", storagePath);

    const { error } = await supabase.storage
      .from("participant-docs")
      .upload(storagePath, buffer, {
        contentType:
          resp.headers.get("content-type") || "application/octet-stream",
        upsert: false,
      });

    if (error) {
      console.error("❌ Supabase Upload Error:", error);
      return null;
    }

    return storagePath;
  } catch (err) {
    console.error("❌ uploadRemoteToBucket error:", err);
    return null;
  }
}

/* ---------------------------
   Webhook Verification
   --------------------------- */
export const verifyWebhook = (req, res) => {
  const verify_token = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === verify_token) {
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
};

/* ---------------------------
   🔥 MAIN INCOMING MESSAGE HANDLER
   --------------------------- */
export const handleIncomingMessage = async (req, res) => {
  console.log("🔹 FULL WHATSAPP PAYLOAD:", JSON.stringify(req.body, null, 2));

  const value = req.body.entry?.[0]?.changes?.[0]?.value;
  const wabaId = req.body.entry?.[0]?.id;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!wabaId || !phoneNumberId) {
    console.error("❌ Missing WABA ID or phone_number_id");
    return res.sendStatus(200);
  }

  // ── Delivery receipt status updates ─────────────────────────────────────
  if (value?.statuses) {
    for (const statusObj of value.statuses) {
      const waMessageId = statusObj.id;
      const status = statusObj.status; // sent | delivered | read
      const timestamp = new Date(Number(statusObj.timestamp) * 1000);

      console.log("📌 WA Status Update:", waMessageId, status);

      const updateData = { status };
      if (status === "sent") updateData.sent_at = timestamp;
      if (status === "delivered") updateData.delivered_at = timestamp;
      if (status === "read") updateData.read_at = timestamp;

      const { error } = await supabase
        .from("whatsapp_messages")
        .update(updateData)
        .eq("wa_message_id", waMessageId);

      if (error) console.error("❌ Failed to update message status:", error);
    }
    return res.sendStatus(200);
  }

  if (!value?.messages) {
    console.log("⚠️ No messages field in webhook (not a user message)");
    return res.sendStatus(200);
  }

  try {
    const message = value?.messages?.[0];
    const businessNumber = process.env.WHATSAPP_BUSINESS_NUMBER;

    // ── Outgoing template echo from business number ──────────────────────
    if (message.from === businessNumber && message.type === "text") {
      const templateText = message.text?.body || "";
      const to = message.to || message.recipient_id || null;

      if (to) {
        const { data: participant } = await supabase
          .from("participants")
          .select("participant_id, full_name, event_id")
          .eq("phone_number", to)
          .maybeSingle();

        if (participant) {
          const chat = await chatCtrl.ensureChat({
            event_id: participant.event_id,
            phone_number: to,
            person_name: participant.full_name,
            user_id: userId,
          });
          await chatCtrl.saveMessage({
            chat_id: chat.chat_id,
            sender_type: "ai",
            message: templateText,
            message_type: "text",
            media_path: null,
          });
          console.log("💾 Auto-saved template message:", templateText);
        }
      }
      return res.sendStatus(200);
    }

    if (!message) return res.sendStatus(200);

    const from = message.from;
    const incomingType = message.type || "text";

    let userText = message.text?.body?.trim() ?? "";
    if (incomingType === "button") {
      userText = message?.button?.payload || message?.button?.text || userText;
    }

    let mediaId = null;
    let origFilename = null;
    if (
      incomingType === "image" ||
      incomingType === "document" ||
      incomingType === "video"
    ) {
      mediaId = message[incomingType]?.id || null;
      origFilename = message.document?.filename || null;
    }

    let mediaUrl =
      message.image?.url || message.document?.url || message.video?.url || null;

    if (!mediaUrl && mediaId && typeof fetchMediaUrl === "function") {
      try {
        mediaUrl = await fetchMediaUrl(mediaId);
      } catch (err) {
        console.warn("fetchMediaUrl failed:", err);
      }
    }

    console.log("📩 Incoming:", {
      from,
      incomingType,
      preview: (userText || "").slice(0, 120),
      mediaUrl: mediaUrl ? "YES" : "NO",
      mediaId,
    });

    // ── Resolve WA account ───────────────────────────────────────────────
    const { data: waAccounts, error: waErr } = await supabase
      .from("whatsapp_accounts")
      .select("user_id")
      .eq("waba_id", wabaId)
      .eq("phone_number_id", phoneNumberId);

    if (waErr || !waAccounts?.length) {
      console.error("❌ No WhatsApp accounts mapped", {
        wabaId,
        phoneNumberId,
      });
      return res.sendStatus(200);
    }

    // ── Find chat row ────────────────────────────────────────────────────
    // For smart fields: allow missing chat — it will be created later
    const { data: chatRow } = await supabase
      .from("chats")
      .select("chat_id, event_id, mode")
      .eq("phone_number", from)
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // For smart fields sessions, chatRow may not exist yet — that's fine
    // it gets created when the reply is logged

    // if (!chatRow) {
    //   console.warn("⚠️ No chat found for phone:", from);
    //   return res.sendStatus(200);
    // }

    // ── Find participant ─────────────────────────────────────────────────
    // First check if there's an active smart fields session for this phone
    // If yes, use that session's event to find the right participant
    const { data: activeWaSession } = await supabase
      .from("whatsapp_ai_sessions")
      .select("event_id, participant_id")
      .eq("phone_number", String(from).replace(/^\+/, ""))
      .eq("status", "active")
      .maybeSingle();

    let participant;
    if (activeWaSession?.participant_id) {
      // Use session's participant directly — correct event guaranteed
      const { data: sessionParticipant } = await supabase
        .from("participants")
        .select("*")
        .eq("participant_id", activeWaSession.participant_id)
        .maybeSingle();
      participant = sessionParticipant;
    } else {
      // Classic fallback — use chatRow event_id if available, else latest
      const { data: fallbackParticipant } = await supabase
        .from("participants")
        .select("*")
        .eq("phone_number", from)
        .eq("event_id", chatRow.event_id)
        .maybeSingle();
      participant = fallbackParticipant || null;
    }

    if (!participant) {
      console.warn(
        "⚠️ Participant not found for phone:",
        from,
        chatRow.event_id,
      );
      return res.sendStatus(200);
    }

    // ── MANUAL mode — admin handling, skip AI ────────────────────────────
    if (chatRow?.mode === "MANUAL") {
      console.log("⛔ AI paused — admin is handling this chat");

      for (const acc of waAccounts) {
        const user_id = acc.user_id;

        const { data: userChatRow } = await supabase
          .from("chats")
          .select("chat_id")
          .eq("user_id", user_id)
          .eq("phone_number", from)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!userChatRow?.chat_id) {
          console.warn("⚠️ No chat found for", { user_id, from });
          continue;
        }

        await chatCtrl.saveMessage({
          chat_id: userChatRow.chat_id,
          sender_type: "user",
          message:
            userText || (mediaUrl ? `[${message.type.toUpperCase()}]` : "TEXT"),
          message_type: message.type || "text",
          media_path: "Null",
        });

        console.log("✅ Message saved for user:", user_id);
      }
      return res.sendStatus(200);
    }

    // ── Resolve event & user for credit deduction ────────────────────────
    const eventId = participant.event_id;
    const userId = await getUserIdForEvent(waAccounts, eventId);

    console.log(
      `[CREDITS] 🔑 Resolved user_id: ${userId} for event: ${eventId}`,
    );

    // ── Credit pre-check — blocks BEFORE any engine/Claude call ──────────
    if (userId) {
      try {
        const creditUser = await getUserById(userId);
        if (creditUser && creditUser.credits < MIN_CHAT_CREDIT_HOLD) {
          console.warn(
            `[CREDITS] ⛔ User ${userId} below threshold (${creditUser.credits} < ${MIN_CHAT_CREDIT_HOLD}) — blocking reply`,
          );
          await sendWhatsAppTextMessage(
            from,
            `Sorry, we're temporarily unable to process your message. Please contact the event organizer.`,
          );
          return res.sendStatus(200);
        }
      } catch (e) {
        console.error(
          "[CREDITS] ❌ Pre-check failed — allowing through (fail open):",
          e.message,
        );
      }
    }

    // ── Load uploads & conversation state ───────────────────────────────
    const { data: uploadedDocuments } = await supabase
      .from("uploads")
      .select("*")
      .eq("participant_id", participant.participant_id);

    const displayName = participant.full_name?.trim() || "Guest";
    const pid = participant.participant_id;

    let convo = await ensureConversationRow(pid, eventId);
    const cache = ensureCache(participant);
    const callStatus =
      cache.call_status || convo.call_status || "awaiting_rsvp";

    // ── Upload media to bucket ───────────────────────────────────────────
    let storedMediaPath = null;
    let publicUrl = null;

    if (mediaUrl) {
      try {
        console.log("📤 Uploading media to bucket...");
        const uploadedPath = await uploadRemoteToBucket(
          mediaUrl,
          pid,
          eventId,
          origFilename || `${displayName.replace(/\s+/g, "_")}_${incomingType}`,
        );

        storedMediaPath = uploadedPath;
        console.log("✅ Media stored at:", storedMediaPath);

        const { data: signedData, error: signedError } = await supabase.storage
          .from("participant-docs")
          .createSignedUrl(storedMediaPath, 3600);

        if (signedError) {
          console.error("❌ Failed to generate signed URL:", signedError);
        } else {
          publicUrl = signedData.signedUrl;
          console.log("🌐 Signed URL generated:", publicUrl);
        }
      } catch (err) {
        console.error("❌ Failed to upload media to bucket:", err);
        storedMediaPath = null;
      }
    }

    // ── Auto-extract travel documents ────────────────────────────────────
    const TRAVEL_DOC_STATES = ["awaiting_travel_doc_upload"];
    const shouldExtract =
      TRAVEL_DOC_STATES.includes(callStatus) &&
      publicUrl &&
      (incomingType === "image" || incomingType === "document");

    let extractionResult = null;
    let classicOcrVisionUnits = 0;
    let classicOcrClaudeUsage = [];
    if (shouldExtract) {
      console.log(
        "🤖 Running automatic travel doc extraction (state: " +
          callStatus +
          ")",
      );

      extractionResult = await autoExtractFromImage({ documentUrl: publicUrl });
      console.log("📤 Extraction result:", extractionResult);
      classicOcrVisionUnits = extractionResult?.visionUnits || 0;
      classicOcrClaudeUsage = extractionResult?.claudeUsage
        ? [extractionResult.claudeUsage]
        : [];

      if (extractionResult?.success && extractionResult.extractedData) {
        const data = extractionResult.extractedData;
        let formattedMessage = `🛫 Travel Details Extracted:\n`;
        formattedMessage += `Date: ${data.date ?? "N/A"}\n`;
        formattedMessage += `Time: ${data.time ?? "N/A"}\n`;
        formattedMessage += `From: ${data.from_location ?? "N/A"}\n`;
        formattedMessage += `To: ${data.to_location ?? "N/A"}\n`;
        formattedMessage += `Transport No: ${data.transport_number ?? "N/A"}\n`;
        formattedMessage += `PNR: ${data.pnr ?? "N/A"}\n`;
        formattedMessage += `Passenger: ${data.passenger_name ?? "N/A"}`;
        await sendWhatsAppTextMessage(from, formattedMessage);
      } else {
        console.warn(
          "⚠️ Extraction failed or no data:",
          extractionResult?.error,
        );
      }
    } else {
      console.log(
        "ℹ️ Skipping extraction (state: " +
          callStatus +
          ", has media: " +
          !!publicUrl +
          ")",
      );
    }

    // ── Load full event (needed for both engines) ────────────────────────
    const { data: fullEvent } = await supabase
      .from("events")
      .select("event_id, event_name, knowledge_base_id, field_mode, agent_id")
      .eq("event_id", eventId)
      .single();

    // ── ROUTE: smart fields agent OR classic decideNextStep ──────────────
    const isSmartFields =
      fullEvent?.field_mode === "smart_fields" && !!fullEvent?.agent_id;

    if (isSmartFields) {
      // ── NEW: AgentChatEngine (smart fields WhatsApp bot) ─────────────
      console.log(
        "[whatsappController] 🤖 Smart fields mode — routing to agentChatEngine",
      );

      let agentReply = null;
      let agentUsage = [];
      let agentOcrVisionUnits = 0;
      let agentOcrClaudeUsage = [];
      try {
        const result = await agentChatEngine({
          phoneNumber: from,
          userMessage: userText || "",
          mediaUrl: publicUrl || null,
          mediaType: incomingType,
          storagePath: storedMediaPath || null,
          eventId,
          participantId: participant.participant_id,
          guestName: displayName,
          event: fullEvent,
        });
        if (result !== null) {
          agentReply = result.reply;
          agentUsage = result.usage || [];
          agentOcrVisionUnits = result.ocrVisionUnits || 0;
          agentOcrClaudeUsage = result.ocrClaudeUsage || [];
        }
      } catch (agentErr) {
        console.error("[whatsappController] agentChatEngine error:", agentErr);
        agentReply = null;
      }

      // agentReply === null means no active session — fall through to classic
      if (agentReply !== null) {
        // ── Send reply via Samvaadik if connected, else fallback ─────────
        try {
          const { data: conn } = await supabase
            .from("samvaadik_connections")
            .select("api_key, status")
            .eq("user_id", userId)
            .maybeSingle();

          if (conn?.status === "active") {
            const { sendText } = await import("../utils/samvaadikClient.js");
            const normalised = String(from).startsWith("+") ? from : `+${from}`;
            await sendText(conn.api_key, normalised, agentReply);
            console.log(
              "[whatsappController] ✅ Smart fields reply sent via Samvaadik",
            );
          } else {
            await sendWhatsAppTextMessage(from, agentReply);
            console.log(
              "[whatsappController] ✅ Smart fields reply sent via direct WA",
            );
          }
        } catch (sendErr) {
          console.error(
            "[whatsappController] ❌ Failed to send smart fields reply:",
            sendErr.message,
          );
          await sendWhatsAppTextMessage(from, agentReply);
        }

        // ── ✅ Settle real token-based cost (classic mode / decideNextStep) ──
        const classicOcrCostUsd = await computeAndLogOcrCost({
          userId,
          conversationId: `${pid}:ocr:${Date.now()}`,
          participantId: pid,
          eventId,
          visionUnits: classicOcrVisionUnits,
          claudeUsage: classicOcrClaudeUsage,
        });

        // ── Settle credits (real token cost if Claude ran this turn) ─────
        const smartOcrCostUsd = await computeAndLogOcrCost({
          userId,
          conversationId: `${pid}:ocr:${Date.now()}`,
          participantId: pid,
          eventId,
          visionUnits: agentOcrVisionUnits,
          claudeUsage: agentOcrClaudeUsage,
        });

        const settlement = await settleChatFromUsage({
          userId,
          conversationId: `${pid}:${Date.now()}`,
          eventId,
          usageArray: agentUsage,
          feature: "whatsapp_smart_fields",
          ocrCostUsd: smartOcrCostUsd,
        });

        if (settlement) {
          console.log(
            `[CREDITS] 💰 Settled: -${settlement.credits} credits | ` +
              `balance: ${settlement.newBalance}`,
          );
        } else {
          // decision.usage was empty (e.g. AI call failed and fell back to a
          // canned reply with no Claude cost) — nothing to charge for.
          console.log(
            `[CREDITS] ℹ️ No Claude usage this turn — nothing charged`,
          );
        }

        // ── Save to chat logs ────────────────────────────────────────────
        const chat = await chatCtrl.ensureChat({
          event_id: eventId,
          phone_number: from,
          person_name: displayName,
          user_id: userId,
        });
        await chatCtrl.saveMessage({
          chat_id: chat.chat_id,
          sender_type: "user",
          message:
            userText ||
            (mediaUrl
              ? `[${incomingType?.toUpperCase() || "MEDIA"}]`
              : "[MESSAGE]"),
          message_type:
            incomingType === "text" ? "text" : incomingType || "text",
          media_path: mediaUrl || null,
        });
        await chatCtrl.saveMessage({
          chat_id: chat.chat_id,
          sender_type: "ai",
          message: agentReply,
          message_type: "text",
          media_path: null,
        });

        return res.sendStatus(200);
      }

      // agentReply === null → no active session → fall through to decideNextStep
      console.log(
        "[whatsappController] No active WA session — falling through to decideNextStep",
      );
    }

    // ── EXISTING: Classic AI Decision Engine (decideNextStep) ────────────
    // This section is completely unchanged from the original
    let decision;
    try {
      decision = await decideNextStep({
        userMessage: userText || "",
        callStatus,
        participant,
        convo,
        cache,
        event: fullEvent || { event_name: "Event" },
        incomingMediaUrl: storedMediaPath || null,
        uploadedDocuments,
      });
    } catch (aiErr) {
      console.error("❌ AI error (decideNextStep):", aiErr);
      await sendWhatsAppTextMessage(
        from,
        `${displayName}, sorry — I'm having trouble processing that right now. Could you try again in a moment?`,
      );
      return res.sendStatus(200);
    }

    if (!decision || typeof decision !== "object") {
      console.warn("AI returned invalid decision object:", decision);
      await sendWhatsAppTextMessage(
        from,
        `${displayName}, sorry — I couldn't understand that. Could you rephrase?`,
      );
      return res.sendStatus(200);
    }

    const replyToSend =
      decision.reply ??
      `Sorry ${displayName}, I couldn't process that. Could you please rephrase?`;
    const nextState = decision.nextState ?? callStatus;
    const actions = decision.actions ?? { updateDB: false, fields: {} };

    console.log("🤖 AI Decision:", {
      nextState,
      updateDB: actions.updateDB,
      fields: actions.fields,
      saveUpload: actions.saveUpload ? "YES" : "NO",
      cacheUpdate: actions.cacheUpdate ? "YES" : "NO",
    });

    // ── Update in-memory cache ───────────────────────────────────────────
    if (actions.cacheUpdate) {
      if (actions.cacheUpdate.currentDocName !== undefined)
        cache.currentDoc.name = actions.cacheUpdate.currentDocName;
      if (actions.cacheUpdate.currentDocRole !== undefined)
        cache.currentDoc.role = actions.cacheUpdate.currentDocRole;
      if (actions.cacheUpdate.currentDocType !== undefined)
        cache.currentDoc.type = actions.cacheUpdate.currentDocType;
      console.log("💾 Cache updated:", cache.currentDoc);
    }

    // ── Save upload to uploads table ─────────────────────────────────────
    let uploadResult = null;
    if (actions.saveUpload && storedMediaPath) {
      try {
        const uploadUrl =
          actions.saveUpload.document_url === "MEDIA"
            ? storedMediaPath
            : actions.saveUpload.document_url;

        uploadResult = await saveUploadRow({
          participant_id: pid,
          participant_relatives_name:
            actions.saveUpload.participant_relatives_name ??
            participant.full_name,
          document_url: uploadUrl,
          document_type: actions.saveUpload.document_type ?? "Document",
          role: actions.saveUpload.role ?? "Self",
        });

        console.log("✅ Upload saved to uploads table");

        // Save to travel_itinerary if extraction succeeded
        if (extractionResult?.success && extractionResult.extractedData) {
          const docType = actions.saveUpload.document_type || "";
          let direction = null;

          if (docType.toLowerCase().includes("arrival")) direction = "arrival";
          else if (docType.toLowerCase().includes("return"))
            direction = "return";

          if (direction && uploadResult && uploadResult[0]?.upload_id) {
            const personName =
              actions.saveUpload.participant_relatives_name ||
              participant.full_name;

            await saveTravelItinerary({
              participant_id: pid,
              upload_id: uploadResult[0].upload_id,
              event_id: eventId,
              extractedData: extractionResult.extractedData,
              direction,
              document_type: docType,
              participant_relatives_name: personName,
            });
          }
        }
      } catch (err) {
        console.error("❌ Error inserting upload row:", err);
      }
    }

    // ── Update conversation_results ──────────────────────────────────────
    try {
      const { data: existingRow } = await supabase
        .from("conversation_results")
        .select("result_id, event_id")
        .eq("participant_id", pid)
        .maybeSingle();

      const fieldsToUpdate = {
        call_status: nextState,
        last_updated: new Date().toISOString(),
        event_id: existingRow?.event_id || eventId,
      };

      if (actions.updateDB && actions.fields) {
        Object.keys(actions.fields).forEach((key) => {
          fieldsToUpdate[key] = actions.fields[key];
        });
      }

      if (storedMediaPath) {
        fieldsToUpdate.document_url = storedMediaPath;
        if (actions.fields?.proof_uploaded !== false) {
          fieldsToUpdate.proof_uploaded = true;
        }
      }

      if (uploadResult && uploadResult[0]?.upload_id) {
        fieldsToUpdate.upload_id = uploadResult[0].upload_id;
        console.log(
          "🔗 Linking upload_id to conversation_results:",
          uploadResult[0].upload_id,
        );
      }

      console.log("💾 Updating conversation_results:", fieldsToUpdate);

      if (existingRow) {
        const { data: updateData, error: updateError } = await supabase
          .from("conversation_results")
          .update(fieldsToUpdate)
          .eq("participant_id", pid)
          .select();

        if (updateError)
          console.error("❌ Error updating conversation_results:", updateError);
        else console.log("✅ Conversation results updated:", updateData);
      } else {
        const { data: insertData, error: insertError } = await supabase
          .from("conversation_results")
          .insert({ participant_id: pid, event_id: eventId, ...fieldsToUpdate })
          .select();

        if (insertError)
          console.error(
            "❌ Error inserting conversation_results:",
            insertError,
          );
        else console.log("✅ Conversation results inserted:", insertData);
      }
    } catch (err) {
      console.error("❌ Error saving to conversation_results:", err);
    }

    // ── Update cache ─────────────────────────────────────────────────────
    cache.call_status = nextState;
    cache.lastUpdated = new Date();
    convoCache.set(pid, cache);

    // ── Build final reply ────────────────────────────────────────────────
    let finalReply = replyToSend;
    if (!finalReply.toLowerCase().includes(displayName.toLowerCase())) {
      finalReply = `${displayName}, ${finalReply}`;
    }

    // ── Send WhatsApp message ────────────────────────────────────────────
    await sendWhatsAppTextMessage(from, finalReply);

    // ── Settle credits (real token cost if Claude ran this turn) ─────
    const settlement = await settleChatFromUsage({
      userId,
      conversationId: `${pid}:${Date.now()}`,
      eventId,
      usageArray: agentUsage,
      feature: "whatsapp_smart_fields",
    });

    if (settlement) {
      console.log(
        `[CREDITS] 💰 Settled: -${settlement.credits} credits | balance: ${settlement.newBalance}`,
      );
    } else {
      // No Claude call this turn (e.g. document/travel_ticket field
      // handled deterministically) — fall back to legacy flat charge.
      const creditResult = await deductProductionChatCredits(userId, {
        participant_id: pid,
        event_id: eventId,
        phone: from,
        state: "smart_fields",
      });
      if (creditResult) {
        console.log(
          `[CREDITS] 💰 Result: -${creditResult.creditsDeducted} | ` +
            `balance: ${creditResult.newBalance}` +
            (creditResult.wasInsufficient ? " (⚠️ insufficient)" : ""),
        );
      }
    }

    // ── Save messages to chat logs ───────────────────────────────────────
    const chat = await chatCtrl.ensureChat({
      event_id: eventId,
      phone_number: from,
      person_name: displayName,
    });

    await chatCtrl.saveMessage({
      chat_id: chat.chat_id,
      sender_type: "user",
      message:
        userText || (mediaUrl ? `[${incomingType.toUpperCase()}]` : "TEXT"),
      message_type: incomingType || "text",
      media_path: storedMediaPath,
    });

    await chatCtrl.saveMessage({
      chat_id: chat.chat_id,
      sender_type: "ai",
      message: finalReply || "AI reply",
      message_type: "text",
      media_path: null,
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Handler Error:", err);

    try {
      const message = value?.messages?.[0];
      const businessNumber = process.env.WHATSAPP_BUSINESS_NUMBER;

      if (message.from === businessNumber) {
        console.log("ℹ️ Ignored outgoing template/business message");
        return res.sendStatus(200);
      }

      const from = message?.from;
      if (from) {
        await sendWhatsAppTextMessage(
          from,
          `Apologies — an error occurred. Please reply again.`,
        );
      }
    } catch (e) {
      console.error("❌ Failed fallback send:", e);
    }

    return res.sendStatus(500);
  }
};

/* ---------------------------
   Start Initial Message (single participant loop)
   --------------------------- */
async function getEventName(eventId) {
  try {
    const { data } = await supabase
      .from("events")
      .select("event_name")
      .eq("event_id", eventId)
      .maybeSingle();
    return data?.event_name ?? null;
  } catch (e) {
    return null;
  }
}

export const startInitialMessage = async (req, res) => {
  try {
    const { event_id } = req.body;

    if (!event_id) {
      return res.status(400).json({ error: "Event ID is required" });
    }

    const { data: participants, error } = await supabase
      .from("participants")
      .select("participant_id, full_name, phone_number, event_id")
      .eq("event_id", event_id);

    if (error) throw error;

    if (!participants || participants.length === 0) {
      return res.status(404).json({ error: "No participants found" });
    }

    const templateName = "rsvp_initial_message";

    for (const person of participants) {
      try {
        let phone = person.phone_number.toString().trim();
        phone = phone.replace(/\D/g, "");
        if (!phone.startsWith("91")) phone = "91" + phone;

        const name = person.full_name?.trim() || "Guest";
        console.log("📤 Sending to:", phone);

        await sendInitialTemplateMessage(phone, templateName, [
          { type: "body", parameters: [{ type: "text", text: name }] },
        ]);

        const personalizedMessage = `Hello ${name}, welcome!`;

        let chat_id;
        const { data: existingChat } = await supabase
          .from("chats")
          .select("chat_id")
          .eq("phone_number", phone)
          // .eq("event_id", person.event_id)
          .maybeSingle();

        if (existingChat?.chat_id) {
          chat_id = existingChat.chat_id;
        } else {
          const { data: newChat } = await supabase
            .from("chats")
            .insert({
              event_id: person.event_id,
              phone_number: phone,
              person_name: name,
              last_message: personalizedMessage,
            })
            .select("chat_id")
            .single();
          chat_id = newChat.chat_id;
        }

        await supabase.from("messages").insert({
          chat_id,
          sender_type: "system",
          message_type: "text",
          message: personalizedMessage,
        });

        const { data: existingConvo } = await supabase
          .from("conversation_results")
          .select("result_id")
          .eq("participant_id", person.participant_id)
          .maybeSingle();

        if (!existingConvo) {
          await supabase.from("conversation_results").insert({
            participant_id: person.participant_id,
            event_id: person.event_id,
            call_status: "awaiting_rsvp",
            last_updated: new Date().toISOString(),
          });
        }

        convoCache.set(person.participant_id, {
          call_status: "awaiting_rsvp",
          currentDoc: { name: null, role: null, type: null },
          pendingDocs: [],
          lastUpdated: new Date(),
          event_id: person.event_id,
        });
      } catch (err) {
        console.error(
          `❌ Failed for participant ${person.phone_number}:`,
          err.response?.data || err.message,
        );
        continue;
      }
    }

    return res.json({
      success: true,
      message: "✅ Initial WhatsApp messages triggered successfully!",
    });
  } catch (err) {
    console.error("❌ WhatsApp Send Error:", err.response?.data || err);
    return res.status(500).json({ error: "WhatsApp send failed" });
  }
};

/* ---------------------------
   Send Batch Initial Message
   --------------------------- */
export const sendBatchInitialMessage = async (req, res) => {
  try {
    const { event_id, filter_null_rsvp } = req.body;

    if (!event_id) {
      return res.status(400).json({ error: "event_id required" });
    }

    const { data: participants, error } = await supabase
      .from("participants")
      .select("participant_id, full_name, phone_number, event_id")
      .eq("event_id", event_id);

    if (error) {
      console.error("❌ Error fetching participants:", error);
      return res.status(500).json({ error: "Failed to fetch participants" });
    }

    if (!participants || participants.length === 0) {
      return res.status(404).json({ error: "No participants found" });
    }

    let targetParticipants = participants;

    if (filter_null_rsvp) {
      const { data: conversations } = await supabase
        .from("conversation_results")
        .select("participant_id, rsvp_status")
        .eq("event_id", event_id);

      const rsvpMap = new Map();
      (conversations || []).forEach((c) =>
        rsvpMap.set(c.participant_id, c.rsvp_status),
      );

      targetParticipants = participants.filter((p) => {
        const status = rsvpMap.get(p.participant_id);
        return !status || status === null || status === "";
      });
    }

    if (targetParticipants.length === 0) {
      return res
        .status(200)
        .json({ message: "No participants need messages", sent_count: 0 });
    }

    const templateName = "invite_rsvp";
    let successCount = 0;
    let failCount = 0;

    for (const p of targetParticipants) {
      try {
        let phone = p.phone_number?.toString().trim();
        if (!phone) throw new Error("Missing phone number");
        if (!phone.startsWith("91")) phone = "91" + phone;

        const name = p.full_name?.trim() || "Guest";
        const templateComponents = [
          { type: "body", parameters: [{ type: "text", text: name }] },
        ];

        await sendInitialTemplateMessage(
          phone,
          templateName,
          templateComponents,
        );

        const personalizedMessage = `Hello ${name}, please confirm your RSVP.`;

        let chat_id;
        const { data: existingChat, error: chatError } = await supabase
          .from("chats")
          .select("chat_id")
          .eq("phone_number", phone)
          // .eq("event_id", p.event_id)
          .maybeSingle();

        if (chatError) {
          console.error("❌ Chat lookup error:", chatError);
          throw chatError;
        }

        if (existingChat) {
          chat_id = existingChat.chat_id;
          await supabase
            .from("chats")
            .update({
              last_message: personalizedMessage,
              last_message_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("chat_id", chat_id);
        } else {
          const { data: newChat, error: insertError } = await supabase
            .from("chats")
            .insert({
              event_id: p.event_id,
              phone_number: phone,
              person_name: name,
              last_message: personalizedMessage,
              last_message_at: new Date().toISOString(),
              mode: "AI",
            })
            .select("chat_id")
            .single();

          if (insertError) {
            console.error("❌ Chat insert error:", insertError);
            throw insertError;
          }
          chat_id = newChat.chat_id;
        }

        await supabase.from("messages").insert({
          chat_id,
          sender_type: "system",
          message_type: "text",
          message: personalizedMessage,
        });

        const { data: existingConvo } = await supabase
          .from("conversation_results")
          .select("result_id")
          .eq("participant_id", p.participant_id)
          .maybeSingle();

        if (!existingConvo) {
          await supabase.from("conversation_results").insert({
            participant_id: p.participant_id,
            event_id: p.event_id,
            call_status: "awaiting_rsvp",
            last_updated: new Date().toISOString(),
          });
        }

        convoCache.set(p.participant_id, {
          call_status: "awaiting_rsvp",
          currentDoc: { name: null, role: null, type: null },
          pendingDocs: [],
          lastUpdated: new Date(),
          event_id: p.event_id,
        });

        successCount++;
      } catch (err) {
        failCount++;
        console.error(
          `❌ Failed to send template to ${p.phone_number}:`,
          err.response?.data || err.message,
        );
      }
    }

    console.log(`📊 Batch Results: ${successCount} sent, ${failCount} failed`);

    return res.json({
      message: "✅ Batch RSVP messages sent",
      template_used: "invite_rsvp",
      total_targeted: targetParticipants.length,
      sent_count: successCount,
      failed_count: failCount,
      filtered_by_null_rsvp: !!filter_null_rsvp,
    });
  } catch (err) {
    console.error("❌ sendBatchInitialMessage error:", err);
    return res.status(500).json({ error: "Failed to send batch messages" });
  }
};

export const handleSamvaadikWebhook = async (req, res) => {
  console.log("🔹 SAMVAADIK WEBHOOK:", JSON.stringify(req.body, null, 2));

  const { event, from, message, message_type, account_id } = req.body;

  if (event !== "message.received") return res.sendStatus(200);
  if (!from || !message) {
    console.warn("⚠️ Missing from or message");
    return res.sendStatus(200);
  }

  try {
    const normalised = String(from).replace(/^\+/, "");
    const userText = String(message).trim();
    const incomingType = message_type || "text";

    console.log("📩 Samvaadik msg:", {
      from: normalised,
      preview: userText.slice(0, 80),
    });

    // ── 1. Get ALL non-closed sessions for this phone ─────────────────────
    const { data: allSessions } = await supabase
      .from("whatsapp_ai_sessions")
      .select("*")
      .eq("phone_number", normalised)
      .neq("status", "closed")
      .order("last_message_at", { ascending: false });

    if (!allSessions?.length) {
      console.warn("⚠️ No session found for:", normalised);
      return res.sendStatus(200);
    }

    // ── 2. Determine routing ────────────────────────────────────────────────
    const activeSession = allSessions.find((s) => s.status === "active");
    const completedSession = allSessions.find((s) => s.status === "completed");
    const primarySession = activeSession || completedSession;

    if (!primarySession) {
      console.warn("⚠️ No actionable session for:", normalised);
      return res.sendStatus(200);
    }

    // ── 3. Load participant ─────────────────────────────────────────────────
    const { data: participant } = await supabase
      .from("participants")
      .select("*")
      .eq("participant_id", primarySession.participant_id)
      .maybeSingle();

    if (!participant) {
      console.warn("⚠️ Participant not found:", primarySession.participant_id);
      return res.sendStatus(200);
    }

    const eventId = primarySession.event_id;
    const displayName = participant.full_name?.trim() || "Guest";
    const pid = participant.participant_id;

    // ── 4. Load full event ──────────────────────────────────────────────────
    const { data: fullEvent } = await supabase
      .from("events")
      .select(
        "event_id, event_name, knowledge_base_id, field_mode, agent_id, user_id",
      )
      .eq("event_id", eventId)
      .single();

    if (!fullEvent) {
      console.warn("⚠️ Event not found:", eventId);
      return res.sendStatus(200);
    }

    const userId = fullEvent.user_id;

    // ── Credit pre-check — blocks BEFORE any engine/Claude call ──────────
    try {
      const creditUser = await getUserById(userId);
      if (creditUser && creditUser.credits < MIN_CHAT_CREDIT_HOLD) {
        console.warn(
          `[CREDITS] ⛔ User ${userId} below threshold (${creditUser.credits} < ${MIN_CHAT_CREDIT_HOLD}) — blocking reply`,
        );
        const axiosLib = (await import("axios")).default;
        const { data: conn } = await supabase
          .from("samvaadik_connections")
          .select("api_key, status")
          .eq("user_id", userId)
          .maybeSingle();
        if (conn?.api_key && conn.status === "active") {
          await axiosLib.post(
            `${process.env.SAMVAADIK_BASE_URL}/messages/text`,
            {
              phone: `+${normalised}`,
              message: `Sorry, we're temporarily unable to process your message. Please contact the event organizer.`,
            },
            {
              headers: {
                "X-API-Key": conn.api_key,
                "Content-Type": "application/json",
                "x-skip-window-check": "true",
              },
              timeout: 10000,
            },
          );
        }
        return res.sendStatus(200);
      }
    } catch (e) {
      console.error(
        "[CREDITS] ❌ Pre-check failed — allowing through (fail open):",
        e.message,
      );
    }

    // ── 5. Route to the right engine based on field_mode ─────────────────────
    let agentReply;
    let engineUsage = []; // populated by decideNextStep (classic) or agentChatEngine (smart_fields)
    let webhookOcrVisionUnits = 0;
    let webhookOcrClaudeUsage = [];

    if (fullEvent.field_mode === "smart_fields") {
      if (activeSession) {
        console.log(
          `[samvaadikWebhook] 🤖 RSVP mode (smart_fields) — session ${activeSession.session_id}`,
        );

        // NEW — re-upload the media into OUR OWN participant-docs bucket before
        // handing off to the engine, exactly like the classic branch below
        // already does. Without this, uploads.document_url ends up pointing at
        // Samvaadik's bucket instead of ours, and the Document Viewer's
        // signed-url endpoint fails with "Object not found" — it can only sign
        // paths that actually live in participant-docs.
        let smartStoredMediaPath = null;
        if (incomingType !== "text" && req.body.media_url) {
          try {
            console.log(
              "📤 [smart_fields] Downloading media from Samvaadik URL...",
            );
            const resp = await fetch(req.body.media_url);
            if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
            const buffer = Buffer.from(await resp.arrayBuffer());
            const ts = Date.now();
            const urlParts = req.body.media_url.split("/");
            const origFilename =
              urlParts[urlParts.length - 1] || `document_${ts}`;
            const storagePath = `${pid}/${eventId}/${ts}_${origFilename}`;

            const { error: uploadError } = await supabase.storage
              .from("participant-docs")
              .upload(storagePath, buffer, {
                contentType:
                  resp.headers.get("content-type") ||
                  "application/octet-stream",
                upsert: false,
              });

            if (uploadError) {
              console.error(
                "❌ [smart_fields] Supabase upload error:",
                uploadError,
              );
            } else {
              smartStoredMediaPath = storagePath;
              console.log(
                "✅ [smart_fields] Media stored at:",
                smartStoredMediaPath,
              );
            }
          } catch (err) {
            console.error(
              "❌ [smart_fields] Failed to download/store Samvaadik media:",
              err.message,
            );
          }
        }

        try {
          const result = await agentChatEngine({
            phoneNumber: normalised,
            userMessage: userText,
            mediaUrl:
              incomingType !== "text" ? req.body.media_url || null : null,
            mediaType: incomingType,
            storagePath: smartStoredMediaPath,
            eventId,
            participantId: pid,
            guestName: displayName,
            event: fullEvent,
          });
          if (result !== null) {
            agentReply = result.reply;
            engineUsage = result.usage || [];
            webhookOcrVisionUnits = result.ocrVisionUnits || 0;
            webhookOcrClaudeUsage = result.ocrClaudeUsage || [];
          } else {
            agentReply = `Sorry ${displayName}, I had a technical issue. Please try again.`;
          }
        } catch (err) {
          console.error(
            "[samvaadikWebhook] agentChatEngine error:",
            err.message,
          );
          agentReply = `Sorry ${displayName}, I had a technical issue. Please try again.`;
        }
      } else {
        console.log(
          `[samvaadikWebhook] 💬 General chat mode — session ${completedSession.session_id}`,
        );
        try {
          const result = await generalChatEngine({
            phoneNumber: normalised,
            userMessage: userText,
            primarySession: completedSession,
            allSessions,
            event: fullEvent,
          });
          agentReply = result.reply;
          engineUsage = result.usage || [];
        } catch (err) {
          console.error(
            "[samvaadikWebhook] generalChatEngine error:",
            err.message,
          );
          agentReply = `Sorry ${displayName}, I had a technical issue. Please try again.`;
        }
      }
    } else {
      console.log(
        `[samvaadikWebhook] 📋 Classic mode — routing to decideNextStep`,
      );

      const { data: existingConvo } = await supabase
        .from("conversation_results")
        .select("*")
        .eq("participant_id", pid)
        .maybeSingle();

      let convo = existingConvo;
      if (!convo) {
        const { data: newConvo } = await supabase
          .from("conversation_results")
          .insert({
            participant_id: pid,
            event_id: eventId,
            call_status: "awaiting_rsvp",
            last_updated: new Date().toISOString(),
          })
          .select()
          .single();
        convo = newConvo;
      }

      const callStatus = convo?.call_status || "awaiting_rsvp";
      const cache = ensureSamvaadikCache(pid);
      const { data: uploadedDocuments } = await supabase
        .from("uploads")
        .select("*")
        .eq("participant_id", pid);

      // ── NEW: download inbound media (Samvaadik's public URL — no auth needed) ──
      let storedMediaPath = null;
      if (incomingType !== "text" && req.body.media_url) {
        try {
          console.log("📤 Downloading media from Samvaadik URL...");
          const resp = await fetch(req.body.media_url);
          if (!resp.ok) {
            throw new Error(`Fetch failed: ${resp.status}`);
          }
          const buffer = Buffer.from(await resp.arrayBuffer());
          const ts = Date.now();
          const urlParts = req.body.media_url.split("/");
          const origFilename =
            urlParts[urlParts.length - 1] || `document_${ts}`;
          const storagePath = `${pid}/${eventId}/${ts}_${origFilename}`;

          const { error: uploadError } = await supabase.storage
            .from("participant-docs")
            .upload(storagePath, buffer, {
              contentType:
                resp.headers.get("content-type") || "application/octet-stream",
              upsert: false,
            });

          if (uploadError) {
            console.error("❌ Supabase upload error:", uploadError);
          } else {
            storedMediaPath = storagePath;
            console.log("✅ Media stored at:", storedMediaPath);
          }
        } catch (err) {
          console.error(
            "❌ Failed to download/store Samvaadik media:",
            err.message,
          );
        }
      }

      let decision;
      try {
        decision = await decideNextStep({
          userMessage: userText,
          callStatus,
          participant,
          convo,
          cache,
          event: fullEvent,
          incomingMediaUrl: storedMediaPath,
          uploadedDocuments: uploadedDocuments || [],
        });
      } catch (err) {
        console.error("[samvaadikWebhook] decideNextStep error:", err.message);
        decision = {
          reply: `Sorry ${displayName}, I had a technical issue. Please try again.`,
          nextState: callStatus,
          actions: { updateDB: false, fields: {} },
        };
      }

      agentReply = decision.reply;
      engineUsage = decision.usage || [];
      const nextState = decision.nextState || callStatus;
      const actions = decision.actions || { updateDB: false, fields: {} };
      // ── NEW: persist cacheUpdate so context survives across turns ──────────
      if (actions.cacheUpdate) {
        if (actions.cacheUpdate.currentDocName !== undefined)
          cache.currentDoc.name = actions.cacheUpdate.currentDocName;
        if (actions.cacheUpdate.currentDocRole !== undefined)
          cache.currentDoc.role = actions.cacheUpdate.currentDocRole;
        if (actions.cacheUpdate.currentDocType !== undefined)
          cache.currentDoc.type = actions.cacheUpdate.currentDocType;
        console.log("💾 [samvaadikWebhook] Cache updated:", cache.currentDoc);
      }

      // ── NEW: persist upload row + travel itinerary, mirroring handleIncomingMessage ──
      let uploadResult = null;
      if (actions.saveUpload && storedMediaPath) {
        try {
          const uploadUrl =
            actions.saveUpload.document_url === "MEDIA"
              ? storedMediaPath
              : actions.saveUpload.document_url;

          const { data: savedUpload, error: uploadRowError } = await supabase
            .from("uploads")
            .insert({
              participant_id: pid,
              participant_relatives_name:
                actions.saveUpload.participant_relatives_name ??
                participant.full_name,
              document_url: uploadUrl,
              document_type: actions.saveUpload.document_type ?? "Document",
              role: actions.saveUpload.role ?? "Self",
              proof_uploaded: true,
              created_at: new Date().toISOString(),
            })
            .select();

          if (uploadRowError) {
            console.error("❌ Error inserting upload row:", uploadRowError);
          } else {
            uploadResult = savedUpload;
            console.log("✅ Upload saved to uploads table");
            // ── NEW: OCR extraction for travel documents (Samvaadik path) ──────
            const docType = actions.saveUpload.document_type || "";
            const isTravelDoc =
              docType.toLowerCase().includes("arrival") ||
              docType.toLowerCase().includes("return") ||
              docType.toLowerCase().includes("ticket");

            if (isTravelDoc && req.body.media_url) {
              console.log(
                "🤖 Running automatic travel doc extraction (Samvaadik path)",
              );
              try {
                const extractionResult = await autoExtractFromImage({
                  documentUrl: req.body.media_url,
                });
                console.log("📤 Extraction result:", extractionResult);
                webhookOcrVisionUnits = extractionResult?.visionUnits || 0;
                webhookOcrClaudeUsage = extractionResult?.claudeUsage
                  ? [extractionResult.claudeUsage]
                  : [];

                if (
                  extractionResult?.success &&
                  extractionResult.extractedData
                ) {
                  let direction = null;
                  if (docType.toLowerCase().includes("arrival"))
                    direction = "arrival";
                  else if (docType.toLowerCase().includes("return"))
                    direction = "return";

                  if (direction && uploadResult && uploadResult[0]?.upload_id) {
                    const personName =
                      actions.saveUpload.participant_relatives_name ||
                      participant.full_name;

                    await saveTravelItinerary({
                      participant_id: pid,
                      upload_id: uploadResult[0].upload_id,
                      event_id: eventId,
                      extractedData: extractionResult.extractedData,
                      direction,
                      document_type: docType,
                      participant_relatives_name: personName,
                    });
                    console.log("✅ Travel itinerary saved (Samvaadik path)");
                  }
                } else {
                  console.warn(
                    "⚠️ Extraction failed or no data:",
                    extractionResult?.error,
                  );
                }
              } catch (err) {
                console.error(
                  "❌ OCR extraction error (Samvaadik path):",
                  err.message,
                );
              }
            }
          }
        } catch (err) {
          console.error("❌ Error saving upload:", err.message);
        }
      }

      try {
        const fieldsToUpdate = {
          call_status: nextState,
          last_updated: new Date().toISOString(),
          event_id: eventId,
        };
        if (actions.updateDB && actions.fields) {
          Object.keys(actions.fields).forEach(
            (k) => (fieldsToUpdate[k] = actions.fields[k]),
          );
        }
        if (storedMediaPath) {
          fieldsToUpdate.document_url = storedMediaPath;
          if (actions.fields?.proof_uploaded !== false) {
            fieldsToUpdate.proof_uploaded = true;
          }
        }
        if (uploadResult?.[0]?.upload_id) {
          fieldsToUpdate.upload_id = uploadResult[0].upload_id;
        }

        await supabase
          .from("conversation_results")
          .update(fieldsToUpdate)
          .eq("participant_id", pid);
      } catch (err) {
        console.error(
          "[samvaadikWebhook] conversation_results update error:",
          err.message,
        );
      }

      if (nextState === "completed" && activeSession) {
        await supabase
          .from("whatsapp_ai_sessions")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
          })
          .eq("session_id", activeSession.session_id);
      }
    }

    if (!agentReply) {
      console.warn("[samvaadikWebhook] No reply generated");
      return res.sendStatus(200);
    }

    console.log("[samvaadikWebhook] 🤖 Reply:", agentReply.slice(0, 100));

    // ── 6. Send reply via Samvaadik ─────────────────────────────────────────
    const { data: conn } = await supabase
      .from("samvaadik_connections")
      .select("api_key, status")
      .eq("user_id", userId)
      .maybeSingle();

    if (!conn?.api_key || conn.status !== "active") {
      console.error(
        "[samvaadikWebhook] No active Samvaadik connection for:",
        userId,
      );
      return res.sendStatus(200);
    }

    const axiosLib = (await import("axios")).default;
    await axiosLib.post(
      `${process.env.SAMVAADIK_BASE_URL}/messages/text`,
      { phone: `+${normalised}`, message: agentReply },
      {
        headers: {
          "X-API-Key": conn.api_key,
          "Content-Type": "application/json",
          "x-skip-window-check": "true",
        },
        timeout: 10000,
      },
    );

    console.log("[samvaadikWebhook] ✅ Reply sent to", normalised);

    // ── 7. Settle credits ───────────────────────────────────────────────────
    const settlementFeature =
      fullEvent.field_mode === "smart_fields"
        ? activeSession
          ? "samvaadik_smart_fields_rsvp"
          : "samvaadik_smart_fields_general"
        : "samvaadik_classic_rsvp";

    const webhookOcrCostUsd = await computeAndLogOcrCost({
      userId,
      conversationId: `${pid}:ocr:${Date.now()}`,
      participantId: pid,
      eventId,
      visionUnits: webhookOcrVisionUnits,
      claudeUsage: webhookOcrClaudeUsage,
    });

    const settlement = await settleChatFromUsage({
      userId,
      conversationId: `${pid}:${Date.now()}`,
      eventId,
      usageArray: engineUsage,
      feature: settlementFeature,
      ocrCostUsd: webhookOcrCostUsd,
    });

    if (settlement) {
      console.log(
        `[CREDITS] 💰 Settled: -${settlement.credits} credits | balance: ${settlement.newBalance}`,
      );
    } else {
      // Not classic mode (smart_fields via agentChatEngine/generalChatEngine),
      // or classic call produced no usage — fall back to legacy flat deduction
      // until those engines are migrated to return real usage too.
      await deductProductionChatCredits(userId, {
        participant_id: pid,
        event_id: eventId,
        phone: normalised,
        state:
          fullEvent.field_mode === "smart_fields"
            ? activeSession
              ? "smart_fields_rsvp"
              : "smart_fields_general"
            : "classic_rsvp",
      });
    }

    // ── 8. Save to chat logs ─────────────────────────────────────────────────
    try {
      const chat = await upsertAutomationChat({
        event_id: eventId,
        phone_number: normalised,
        person_name: displayName,
        user_id: userId,
      });
      await chatCtrl.saveMessage({
        chat_id: chat.chat_id,
        sender_type: "user",
        message: userText,
        message_type: incomingType,
        media_path: incomingType !== "text" ? req.body.media_url || null : null,
      });
      await chatCtrl.saveMessage({
        chat_id: chat.chat_id,
        sender_type: "ai",
        message: agentReply,
        message_type: "text",
        media_path: null,
      });
    } catch (chatErr) {
      console.warn(
        "[samvaadikWebhook] Chat log error (non-blocking):",
        chatErr.message,
      );
    }

    // ── Respond only after all work is done ──────────────────────────────────
    return res.sendStatus(200);
  } catch (err) {
    console.error("[samvaadikWebhook] Fatal error:", err.message);
    // Still 200 so Samvaadik doesn't retry — but only sent after we tried.
    return res.sendStatus(200);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ADD to controllers/whatsappController.js
//
// New export: sendSamvaadikBatch
// Route:      POST /whatsapp/samvaadik-batch
//
// What it does:
//   1. Gets all participants for the event
//   2. Sends the chosen Samvaadik template to each
//   3. Creates / resets whatsapp_ai_sessions so the chatbot responds automatically
//   4. Creates chat rows for dashboard visibility
//   5. Returns per-participant results
// ─────────────────────────────────────────────────────────────────────────────

import { createSession } from "../utils/sessionManager.js";

export async function sendSamvaadikTemplateToParticipants(
  eventId,
  participantIds,
  templateName,
  languageCode = "en",
  templateBodyText = null,
  onProgress = () => {},
  onParticipantUpdate = () => {}, // ← ADD THIS
) {
  if (!eventId || !templateName) {
    throw new Error("eventId and templateName are required");
  }

  const { data: event } = await supabase
    .from("events")
    .select("event_id, event_name, user_id, field_mode, agent_id")
    .eq("event_id", eventId)
    .single();
  if (!event) throw new Error("Event not found");

  const { data: conn } = await supabase
    .from("samvaadik_connections")
    .select("api_key, status")
    .eq("user_id", event.user_id)
    .maybeSingle();
  if (!conn?.api_key || conn.status !== "active") {
    throw new Error(
      "No active Samvaadik connection. Please connect Samvaadik first.",
    );
  }

  if (!templateBodyText) {
    try {
      const { getTemplates } = await import("../utils/samvaadikClient.js");
      const templatesResp = await getTemplates(conn.api_key);
      const matchedTemplate = templatesResp?.data?.find(
        (t) => t.name === templateName || t.template_name === templateName,
      );

      if (matchedTemplate?.wt_id) {
        const axiosLib = (await import("axios")).default;
        const detailResp = await axiosLib.get(
          `${process.env.SAMVAADIK_BASE_URL}/templates/${matchedTemplate.wt_id}`,
          { headers: { "X-API-Key": conn.api_key } },
        );
        console.log(
          "🔍 RAW template DETAIL:",
          JSON.stringify(detailResp.data, null, 2),
        );
        // once we see the shape, extract body text here
      }
    } catch (fetchErr) {
      console.error("⚠️ Failed to fetch template body:", fetchErr.message);
    }
  }

  const { data: participants } = await supabase
    .from("participants")
    .select("participant_id, full_name, phone_number")
    .eq("event_id", eventId);
  if (!participants?.length)
    throw new Error("No participants found for this event");

  const targets = participantIds?.length
    ? participants.filter((p) => participantIds.includes(p.participant_id))
    : participants;
  if (!targets.length)
    throw new Error("None of the selected participants found");

  // ← ADD THIS BLOCK — seed every target as "pending" so the frontend
  // can render the full manifest immediately, before any sends happen
  targets.forEach((p) => {
    onParticipantUpdate(p.participant_id, {
      name: p.full_name?.trim() || "Guest",
      phone: p.phone_number,
      status: "pending",
    });
  });

  const results = { sent: 0, failed: 0, errors: [] };
  const CONCURRENCY = 5; // tune based on Samvaadik's rate limits

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);

    await Promise.allSettled(
      chunk.map(async (participant) => {
        const name = participant.full_name?.trim() || "Guest";
        onParticipantUpdate(participant.participant_id, {
          name,
          status: "sending",
        }); // ← ADD THIS

        try {
          const phone = String(participant.phone_number).replace(/\D/g, "");
          const normalised = phone.startsWith("+")
            ? phone.replace("+", "")
            : phone;
          const displayPhone = `+${normalised}`;
          // (delete the now-duplicate "const name = ..." line below, since it moved up)

          await axios.post(
            `${process.env.SAMVAADIK_BASE_URL}/messages/template`,
            {
              phone: displayPhone,
              template_name: templateName,
              language_code: languageCode,
              components: [
                { type: "body", parameters: [{ type: "text", text: name }] },
              ],
            },
            {
              headers: {
                "X-API-Key": conn.api_key,
                "Content-Type": "application/json",
              },
              timeout: 10000,
            },
          );

          await supabase
            .from("whatsapp_ai_sessions")
            .update({
              status: "closed",
              completed_at: new Date().toISOString(),
            })
            .eq("phone_number", normalised)
            .neq("status", "closed");

          await createSession({
            event_id: eventId,
            participant_id: participant.participant_id,
            phone_number: normalised,
            triggered_by: "batch_template",
          });

          const chat = await upsertAutomationChat({
            event_id: eventId,
            phone_number: normalised,
            person_name: name,
            user_id: event.user_id,
          });

          const renderedMessage = templateBodyText
            ? templateBodyText.replace(/\{\{\s*1\s*\}\}/g, name)
            : `[Template: ${templateName}] Sent to ${name}`;

          await chatCtrl.saveMessage({
            chat_id: chat.chat_id,
            sender_type: "ai",
            message: renderedMessage,
            message_type: "template",
            media_path: null,
          });

          results.sent++;
          onParticipantUpdate(participant.participant_id, { status: "sent" }); // ← ADD THIS
        } catch (err) {
          results.failed++;
          const errMsg = err.response?.data?.message || err.message;
          results.errors.push(
            `${participant.full_name} (${participant.phone_number}): ${errMsg}`,
          );
          onParticipantUpdate(participant.participant_id, {
            status: "failed",
            error: errMsg,
          }); // ← ADD THIS
          console.error(
            `[sendSamvaadikTemplateToParticipants] ❌ Failed for ${participant.full_name}:`,
            errMsg,
          );
        }
      }),
    );

    onProgress({ ...results, total: targets.length });
  }

  return { total: targets.length, ...results };
}

// Local to this file — deliberately NOT part of chatController.js's
// ensureChat, which other flows (webhook replies, classic call flow) rely
// on with different semantics. One WhatsApp thread per phone number: if a
// chat already exists for this phone, repoint it at the current event
// instead of creating a second row for the same contact.
// Local to this file — deliberately NOT part of chatController.js's
// ensureChat, which other flows (webhook replies, classic call flow) rely
// on with different semantics. One WhatsApp thread per phone number: if a
// chat already exists for this phone, repoint it at the current event
// instead of creating a second row for the same contact.
async function upsertAutomationChat({
  event_id,
  phone_number,
  person_name,
  user_id,
}) {
  const { data: existingRows } = await supabase
    .from("chats")
    .select("chat_id")
    .eq("phone_number", phone_number) // ← removed event_id filter
    .order("created_at", { ascending: true })
    .limit(1);

  const existing = existingRows?.[0];

  if (existing) {
    const { data: updated, error: updateErr } = await supabase
      .from("chats")
      .update({
        event_id, // ← now allowed to update again, since single-thread-per-number is the intent
        person_name,
        user_id,
        updated_at: new Date().toISOString(),
      })
      .eq("chat_id", existing.chat_id)
      .select()
      .single();
    if (updateErr) throw updateErr;
    return updated;
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("chats")
    .insert({
      event_id,
      phone_number,
      person_name,
      user_id,
      last_message: "",
      last_message_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (insertErr) throw insertErr;
  return inserted;
}
export const sendSamvaadikBatch = async (req, res) => {
  const {
    event_id,
    template_name,
    language_code = "en",
    template_body = null,
    participant_ids,
  } = req.body;

  if (!event_id || !template_name) {
    return res
      .status(400)
      .json({ error: "event_id and template_name are required" });
  }

  const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  batchJobs.set(batchId, {
    status: "processing",
    sent: 0,
    failed: 0,
    total: 0,
    errors: [],
    participants: {}, // ← ADD THIS
  });

  // Respond immediately so the HTTP request never times out waiting on the loop
  res.json({ success: true, batch_id: batchId, status: "processing" });

  // Everything below runs AFTER the response has already been sent
  sendSamvaadikTemplateToParticipants(
    event_id,
    participant_ids,
    template_name,
    language_code,
    template_body,
    (progress) => updateJob(batchId, { status: "processing", ...progress }),
    (participantId, patch) => updateParticipant(batchId, participantId, patch), // ← ADD THIS
  )
    .then((result) => {
      updateJob(batchId, {
        status: "done",
        ...result,
        message: `${result.sent}/${result.total} messages sent. Chatbot is now active for replies.`,
      });
    })
    .catch((err) => {
      console.error("[sendSamvaadikBatch] background error:", err.message);
      updateJob(batchId, { status: "error", error: err.message });
    });
};

export const getSamvaadikBatchStatus = (req, res) => {
  const job = batchJobs.get(req.params.batchId);
  if (!job) return res.status(404).json({ error: "Batch not found" });

  const participants = Object.entries(job.participants || {}).map(
    ([id, p]) => ({ id, ...p }),
  );
  return res.json({ ...job, participants });
};

// ─────────────────────────────────────────────────────────────────────────────
// Add to routes/whatsappRoutes.js:
//
//   import { ..., sendSamvaadikBatch } from "../controllers/whatsappController.js";
//   router.post("/whatsapp/samvaadik-batch", sendSamvaadikBatch);
// ─────────────────────────────────────────────────────────────────────────────
