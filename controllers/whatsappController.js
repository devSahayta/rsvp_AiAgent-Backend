// controllers/whatsappController.js - UPDATED WITH TRAVEL ITINERARY STORAGE

import dotenv from "dotenv";
dotenv.config();
import axios from "axios";

import { sendInitialTemplateMessage, sendWhatsAppTextMessage, fetchMediaUrl } from "../utils/whatsappClient.js";
import decideNextStep from "../utils/aiDecisionEngine.js";
import { supabase } from "../config/supabase.js";
import * as chatCtrl from "./chatController.js";
import { autoExtractFromImage } from "../utils/autoExtractor.js";

const convoCache = new Map();
const BUCKET_NAME = process.env.SUPABASE_BUCKET || "participant-docs";

const TEMPLATE_URL = process.env.TEMPLATE_BASE_URL;


async function fetchTemplateFromSystem(templateName) {
  const userId = "kp_c7f2725ff7a74158bb7eae3060d6f1de"; // static for now

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
   NEW: Save Travel Itinerary Helper - FIXED FOR MULTIPLE ATTENDEES
   --------------------------- */
async function saveTravelItinerary({
  participant_id,
  upload_id,
  event_id,
  extractedData,
  direction,
  document_type = "ticket",
  participant_relatives_name // 🔥 REQUIRED: Person's name
}) {
  try {
    console.log("💾 Saving travel itinerary:", { 
      participant_id, 
      participant_relatives_name,
      direction, 
      extractedData 
    });

    // 🔥 CRITICAL: Query by person name to allow multiple rows per participant
    const { data: existing } = await supabase
      .from("travel_itinerary")
      .select("*")
      .eq("participant_id", participant_id)
      .eq("event_id", event_id)
      .eq("participant_relatives_name", participant_relatives_name)
      .maybeSingle();

    const itineraryData = {
      participant_id,
      upload_id,
      event_id,
      participant_relatives_name, // 🔥 Store person identity
      document_type: document_type || 'ticket',
      raw_text_extracted: JSON.stringify(extractedData),
      ai_json_extracted: extractedData,
      direction,
      updated_at: new Date().toISOString()
    };

    // Populate direction-specific fields
    if (direction === 'arrival') {
      itineraryData.arrival_date = extractedData.date || null;
      itineraryData.arrival_time = extractedData.time || null;
      itineraryData.arrival_transport_no = extractedData.transport_number || null;
    } else if (direction === 'return') {
      itineraryData.return_date = extractedData.date || null;
      itineraryData.return_time = extractedData.time || null;
      itineraryData.return_transport_no = extractedData.transport_number || null;
    }

    if (existing) {
      // UPDATE existing row for THIS PERSON
      const updateFields = { ...itineraryData };
      delete updateFields.participant_id;
      delete updateFields.event_id;
      delete updateFields.participant_relatives_name;

      // Preserve existing data when updating
      if (direction === 'return' && existing.arrival_date) {
        updateFields.arrival_date = existing.arrival_date;
        updateFields.arrival_time = existing.arrival_time;
        updateFields.arrival_transport_no = existing.arrival_transport_no;
      }

      if (direction === 'arrival' && existing.return_date) {
        updateFields.return_date = existing.return_date;
        updateFields.return_time = existing.return_time;
        updateFields.return_transport_no = existing.return_transport_no;
      }

      const { data: updated, error: updateError } = await supabase
        .from("travel_itinerary")
        .update(updateFields)
        .eq("itinerary_id", existing.itinerary_id)
        .select();

      if (updateError) {
        console.error("❌ Error updating travel_itinerary:", updateError);
        return null;
      }

      console.log(`✅ Travel itinerary updated for ${participant_relatives_name}:`, updated);
      return updated;
    } else {
      // INSERT new row for THIS PERSON
      const { data: inserted, error: insertError } = await supabase
        .from("travel_itinerary")
        .insert(itineraryData)
        .select();

      if (insertError) {
        console.error("❌ Error inserting travel_itinerary:", insertError);
        return null;
      }

      console.log(`✅ Travel itinerary created for ${participant_relatives_name}:`, inserted);
      return inserted;
    }
  } catch (err) {
    console.error("❌ saveTravelItinerary error:", err);
    return null;
  }
}

/* ---------------------------
   Existing Helpers
   --------------------------- */
function ensureCache(participant) {
  const pid = participant.participant_id;
  if (!convoCache.has(pid)) {
    const initial = { 
      call_status: "awaiting_rsvp", 
      currentDoc: { name: null, role: null, type: null }, 
      pendingDocs: [], 
      lastUpdated: new Date() 
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
        last_updated: new Date().toISOString()
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
    
    if (updateError) {
      console.error("❌ Error updating event_id:", updateError);
    } else {
      console.log("✅ Updated event_id for existing conversation");
      existing.event_id = eventId;
    }
  }
  
  return existing;
}

async function uploadRemoteToBucket(mediaUrl, participantId, eventId, origFilename = null) {
  try {
    if (!mediaUrl) return null;

    const resp = await fetch(mediaUrl, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      }
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
        contentType: resp.headers.get("content-type") || "application/octet-stream",
        upsert: false
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

async function saveUploadRow({ participant_id, participant_relatives_name, document_url, document_type, role }) {
  try {
    const { data, error } = await supabase.from("uploads").insert({
      participant_id,
      participant_relatives_name: participant_relatives_name || null,
      document_url: document_url || null,
      document_type: document_type || "Document",
      role: role || "Self",
      proof_uploaded: true,
      created_at: new Date().toISOString()
    }).select();

    if (error) {
      console.error("❌ Error inserting upload row:", error);
      return null;
    }

    console.log("✅ Upload row saved:", data);
    return data;
  } catch (err) {
    console.error("❌ saveUploadRow error:", err);
    return null;
  }
}

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
   🔥 MAIN HANDLER WITH ITINERARY STORAGE
   --------------------------- */
export const handleIncomingMessage = async (req, res) => {
  console.log("🔹 FULL WHATSAPP PAYLOAD:", JSON.stringify(req.body, null, 2));

  const value = req.body.entry?.[0]?.changes?.[0]?.value;

  if (value?.statuses) {
    console.log("ℹ️ Status notification received:", value.statuses[0]?.status);
    return res.sendStatus(200);
  }

  if (!value?.messages) {
    console.log("⚠️ No messages field in webhook (not a user message)");
    return res.sendStatus(200);
  }

  try {
    const message = value?.messages?.[0];
    const businessNumber = process.env.WHATSAPP_BUSINESS_NUMBER;
    
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
            person_name: participant.full_name
          });

          await chatCtrl.saveMessage({
            chat_id: chat.chat_id,
            sender_type: "ai",
            message: templateText,
            message_type: "text",
            media_path: null
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
    if (incomingType === "image" || incomingType === "document" || incomingType === "video") {
      mediaId = message[incomingType]?.id || null;
      origFilename = message.document?.filename || null;
    }

    let mediaUrl = message.image?.url || message.document?.url || message.video?.url || null;

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
      mediaId 
    });

    // const { data: participant } = await supabase
    //   .from("participants")
    //   .select("*")
    //   .eq("phone_number", from)
    //   .maybeSingle();
    
    // if (!participant) {
    //   console.warn("⚠️ Participant not found for phone:", from);
    //   return res.sendStatus(200);
    // }
    
    const { data: chatRow } = await supabase
      .from("chats")
      .select("chat_id, event_id, mode")
      .eq("phone_number", from)
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (!chatRow) {
      console.warn("⚠️ No chat found for phone:", from);
      return res.sendStatus(200);
    }


    const { data: participant } = await supabase
  .from("participants")
  .select("*")
  .eq("phone_number", from)
  .eq("event_id", chatRow.event_id)
  .maybeSingle();

if (!participant) {
  console.warn(
    "⚠️ Participant not found for phone + event:",
    from,
    chatRow.event_id
  );
  return res.sendStatus(200);
}




if (chatRow?.mode === "MANUAL") {
  console.log("⛔ AI paused — admin is handling this chat");

  await chatCtrl.saveMessage({
    chat_id: chatRow.chat_id,
    sender_type: "user",
    message: userText || `[${incomingType.toUpperCase()}]`,
    message_type: incomingType || "text",
    media_path: null   // IMPORTANT: storedMediaPath not yet defined here
  });

  return res.sendStatus(200);
}



    const { data: uploadedDocuments } = await supabase
      .from("uploads")
      .select("*")
      .eq("participant_id", participant.participant_id);

    const displayName = participant.full_name?.trim() || "Guest";
    const pid = participant.participant_id;
    const eventId = participant.event_id;

    let convo = await ensureConversationRow(pid, eventId);
    const cache = ensureCache(participant);
    const callStatus = cache.call_status || convo.call_status || "awaiting_rsvp";

    // Upload media if present
    let storedMediaPath = null;
    let publicUrl = null;

    if (mediaUrl) {
      try {
        console.log("📤 Uploading media to bucket...");
        const uploadedPath = await uploadRemoteToBucket(
          mediaUrl, 
          pid, 
          eventId, 
          origFilename || `${displayName.replace(/\s+/g, "_")}_${incomingType}`
        );

        storedMediaPath = uploadedPath;
        console.log("✅ Media stored at:", storedMediaPath);

        const { data: signedData, error: signedError } = await supabase
          .storage
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

    // 🔥 EXTRACTION: Only for travel documents (image OR document/PDF)
    const TRAVEL_DOC_STATES = ["awaiting_travel_doc_upload"];
    const shouldExtract = TRAVEL_DOC_STATES.includes(callStatus) && 
                         publicUrl && 
                         (incomingType === "image" || incomingType === "document");

    let extractionResult = null;
    if (shouldExtract) {
      console.log("🤖 Running automatic travel doc extraction (state: " + callStatus + ")");

      extractionResult = await autoExtractFromImage({
        documentUrl: publicUrl
      });

      console.log("📤 Extraction result:", extractionResult);

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
        console.warn("⚠️ Extraction failed or no data:", extractionResult?.error);
      }
    } else {
      console.log("ℹ️ Skipping extraction (state: " + callStatus + ", has media: " + !!publicUrl + ")");
    }

    // AI Decision
    // AI Decision
let decision;
try {
  // Fetch full event with knowledge_base_id
  const { data: fullEvent } = await supabase
    .from("events")
    .select("event_id, event_name, knowledge_base_id")
    .eq("event_id", eventId)
    .single();

  decision = await decideNextStep({
    userMessage: userText || "",
    callStatus,
    participant,
    convo,
    cache,
    event: fullEvent || { event_name: "Event" },  // ← FIXED: Pass full event object
    incomingMediaUrl: storedMediaPath || null,
    uploadedDocuments 
  });
} catch (aiErr) {
  console.error("❌ AI error (decideNextStep):", aiErr);
  
  await sendWhatsAppTextMessage(
    from, 
    `${displayName}, sorry — I'm having trouble processing that right now. Could you try again in a moment?`
  );
  return res.sendStatus(200);
}

    if (!decision || typeof decision !== "object") {
      console.warn("AI returned invalid decision object:", decision);
      await sendWhatsAppTextMessage(
        from, 
        `${displayName}, sorry — I couldn't understand that. Could you rephrase?`
      );
      return res.sendStatus(200);
    }

    const replyToSend = decision.reply ?? `Sorry ${displayName}, I couldn't process that. Could you please rephrase?`;
    const nextState = decision.nextState ?? callStatus;
    const actions = decision.actions ?? { updateDB: false, fields: {} };

    console.log("🤖 AI Decision:", {
      nextState,
      updateDB: actions.updateDB,
      fields: actions.fields,
      saveUpload: actions.saveUpload ? "YES" : "NO",
      cacheUpdate: actions.cacheUpdate ? "YES" : "NO"
    });

    // Update cache
    if (actions.cacheUpdate) {
      if (actions.cacheUpdate.currentDocName !== undefined) {
        cache.currentDoc.name = actions.cacheUpdate.currentDocName;
      }
      if (actions.cacheUpdate.currentDocRole !== undefined) {
        cache.currentDoc.role = actions.cacheUpdate.currentDocRole;
      }
      if (actions.cacheUpdate.currentDocType !== undefined) {
        cache.currentDoc.type = actions.cacheUpdate.currentDocType;
      }
      console.log("💾 Cache updated:", cache.currentDoc);
    }

    // Save upload to uploads table
    let uploadResult = null;
    if (actions.saveUpload && storedMediaPath) {
      try {
        const uploadUrl = actions.saveUpload.document_url === "MEDIA"
          ? storedMediaPath
          : actions.saveUpload.document_url;

        uploadResult = await saveUploadRow({
          participant_id: pid,
          participant_relatives_name: actions.saveUpload.participant_relatives_name ?? participant.full_name,
          document_url: uploadUrl,
          document_type: actions.saveUpload.document_type ?? "Document",
          role: actions.saveUpload.role ?? "Self"
        });

        console.log("✅ Upload saved to uploads table");

        // 🔥 Save to travel_itinerary if extraction succeeded
        if (extractionResult?.success && extractionResult.extractedData) {
          const docType = actions.saveUpload.document_type || "";
          
          // Determine direction from document_type
          let direction = null;
          if (docType.toLowerCase().includes("arrival")) {
            direction = "arrival";
          } else if (docType.toLowerCase().includes("return")) {
            direction = "return";
          }

          if (direction && uploadResult && uploadResult[0]?.upload_id) {
            // 🔥 CRITICAL: Pass the person's name to create separate rows
            const personName = actions.saveUpload.participant_relatives_name || participant.full_name;
            
            await saveTravelItinerary({
              participant_id: pid,
              upload_id: uploadResult[0].upload_id,
              event_id: eventId,
              extractedData: extractionResult.extractedData,
              direction: direction,
              document_type: docType,
              participant_relatives_name: personName // 🔥 NEW: Identifies who this belongs to
            });
          }
        }
      } catch (err) {
        console.error("❌ Error inserting upload row:", err);
      }
    }

    // Update conversation_results
    try {
      const { data: existingRow } = await supabase
        .from("conversation_results")
        .select("result_id, event_id")
        .eq("participant_id", pid)
        .maybeSingle();

      const fieldsToUpdate = {
        call_status: nextState,
        last_updated: new Date().toISOString(),
        event_id: existingRow?.event_id || eventId
      };

      if (actions.updateDB && actions.fields) {
        Object.keys(actions.fields).forEach(key => {
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
        console.log("🔗 Linking upload_id to conversation_results:", uploadResult[0].upload_id);
      }

      console.log("💾 Updating conversation_results:", fieldsToUpdate);

      if (existingRow) {
        const { data: updateData, error: updateError } = await supabase
          .from("conversation_results")
          .update(fieldsToUpdate)
          .eq("participant_id", pid)
          .select();

        if (updateError) {
          console.error("❌ Error updating conversation_results:", updateError);
        } else {
          console.log("✅ Conversation results updated:", updateData);
        }
      } else {
        const { data: insertData, error: insertError } = await supabase
          .from("conversation_results")
          .insert({
            participant_id: pid,
            event_id: eventId,
            ...fieldsToUpdate
          })
          .select();

        if (insertError) {
          console.error("❌ Error inserting conversation_results:", insertError);
        } else {
          console.log("✅ Conversation results inserted:", insertData);
        }
      }
    } catch (err) {
      console.error("❌ Error saving to conversation_results:", err);
    }

    cache.call_status = nextState;
    cache.lastUpdated = new Date();
    convoCache.set(pid, cache);

    let finalReply = replyToSend;
    if (!finalReply.toLowerCase().includes(displayName.toLowerCase())) {
      finalReply = `${displayName}, ${finalReply}`;
    }
    
    await sendWhatsAppTextMessage(from, finalReply);

    const chat = await chatCtrl.ensureChat({
      event_id: eventId,
      phone_number: from,
      person_name: displayName
    });

    await chatCtrl.saveMessage({
      chat_id: chat.chat_id,
      sender_type: "user",
      message: userText || (mediaUrl ? `[${incomingType.toUpperCase()}]` : "TEXT"),
      message_type: incomingType || "text",
      media_path: storedMediaPath
    });

    await chatCtrl.saveMessage({
      chat_id: chat.chat_id,
      sender_type: "ai",
      message: finalReply || "AI reply",
      message_type: "text",
      media_path: null
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
        await sendWhatsAppTextMessage(from, `Apologies — an error occurred. Please reply again.`);
      }
    } catch (e) {
      console.error("❌ Failed fallback send:", e);
    }
    
    return res.sendStatus(500);
  }
};

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
    if (!event_id) return res.status(400).json({ error: "Event ID is required" });

    // 🚀 Fetch participants
    const { data: participants, error } = await supabase
      .from("participants")
      .select("participant_id, full_name, phone_number, event_id")
      .eq("event_id", event_id);
    
    if (error) throw error;
    if (!participants?.length) return res.status(404).json({ error: "No participants found" });

    // 📌 Fetch Template only once
    const templateName = "rsvp_initial_message";
    const metaTemplate = await fetchTemplateFromSystem(templateName);

    if (!metaTemplate)
      return res.status(500).json({ error: "Failed to load WhatsApp template" });

    // 🧩 Extract Body Content with {{1}} placeholder
    const templateBody = metaTemplate?.components?.find(c => c.type === "BODY")?.text;

    if (!templateBody)
      return res.status(500).json({ error: "Template body missing" });

    // 🔁 Send to each participant
    for (const person of participants) {
      let phone = person.phone_number.toString().trim();
      if (!phone.startsWith("91")) phone = "91" + phone;

      const name = person.full_name?.trim() || "Guest";

      // 🌟 Replace placeholder
      const personalizedMessage = templateBody.replace("{{1}}", name);

      // 📤 Send Template to WhatsApp
      await sendInitialTemplateMessage(phone, templateName, [
        { type: "body", parameters: [{ type: "text", text: name }] }
      ]);

      // 💬 Store in Chat Logs (same as batch logic)
      let chat_id;
      const { data: existingChat } = await supabase
        .from("chats")
        .select("chat_id")
        .eq("phone_number", phone)
        .eq("event_id", person.event_id)
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
            last_message: personalizedMessage
          })
          .select("chat_id")
          .single();

        chat_id = newChat.chat_id;
      }

      // 🗃️ Save message
      await supabase.from("messages").insert({
        chat_id,
        sender_type: "system",
        message_type: "text",
        message: personalizedMessage
      });

      // 🏷️ Update RSVP status tracking
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
          last_updated: new Date().toISOString()
        });
      }

      // ♻️ Cache memory
      convoCache.set(person.participant_id, {
        call_status: "awaiting_rsvp",
        currentDoc: { name: null, role: null, type: null },
        pendingDocs: [],
        lastUpdated: new Date(),
        event_id: person.event_id
      });
    }

    return res.json({ 
      success: true, 
      message: "✅ Initial messages triggered successfully!"
    });

  } catch (err) {
    console.error("❌ WhatsApp Send Error:", err?.response?.data || err);
    return res.status(500).json({ error: "WhatsApp send failed" });
  }
};


// 🌐 Fetch WhatsApp Template Meta Data From Your API


export const sendBatchInitialMessage = async (req, res) => {
  try {
    const { event_id, filter_null_rsvp } = req.body;
    if (!event_id) return res.status(400).json({ error: "event_id required" });

    const { data: participants, error: participantsError } = await supabase
      .from("participants")
      .select("participant_id, full_name, phone_number, event_id")
      .eq("event_id", event_id);
    
    if (participantsError) {
      console.error("❌ Error fetching participants:", participantsError);
      return res.status(500).json({ error: "Failed to fetch participants" });
    }

    if (!participants || participants.length === 0) {
      return res.status(404).json({ error: "No participants found" });
    }

    let targetParticipants = participants;

    // 📌 Load template one time
const templateName = "invite_rsvp";
const metaTemplate = await fetchTemplateFromSystem(templateName);

if (!metaTemplate) {
  return res.status(500).json({ error: "Failed to load WhatsApp template" });
}

// 🧩 Extract the WHATSAPP TEMPLATE BODY TEXT (e.g. Hi {{1}} ...)
const templateBody = metaTemplate?.components?.find(c => c.type === "BODY")?.text;

if (!templateBody) {
  return res.status(500).json({ error: "Template body missing" });
}

    
    if (filter_null_rsvp) {
      const { data: conversations } = await supabase
        .from("conversation_results")
        .select("participant_id, rsvp_status")
        .eq("event_id", event_id);
      
      const rsvpMap = new Map();
      (conversations || []).forEach(c => rsvpMap.set(c.participant_id, c.rsvp_status));
      
      targetParticipants = participants.filter(p => {
        const status = rsvpMap.get(p.participant_id);
        return !status || status === null || status === "";
      });
    }

    if (targetParticipants.length === 0) {
      return res.status(200).json({ 
        message: "No participants need messages", 
        sent_count: 0 
      });
    }

    let successCount = 0, failCount = 0;
    
    for (const p of targetParticipants) {
      try {
        let phone = p.phone_number?.toString().trim();
        if (!phone) throw new Error("Missing phone number");
        if (!phone.startsWith("91")) phone = "91" + phone;

        const name = p.full_name?.trim() || "Guest";
        const templateName = "invite_rsvp";
        const templateComponents = [
          { type: "body", parameters: [{ type: "text", text: name }] }
        ];

        await sendInitialTemplateMessage(phone, templateName, templateComponents);

        // 🏷 Store the template message in DB as "admin"
// 🏷 Build personalized message using template
const personalizedMessage = templateBody.replace("{{1}}", name);


// 👉 Ensure chat exists or create a new one
let chat_id;
const { data: existingChat } = await supabase
  .from("chats")
  .select("chat_id")
  .eq("phone_number", phone)
  .eq("event_id", p.event_id)
  .maybeSingle();

if (existingChat?.chat_id) {
  chat_id = existingChat.chat_id;
} else {
  const { data: newChat } = await supabase
    .from("chats")
    .insert({
      event_id: p.event_id,
      phone_number: phone,
      person_name: name,
      last_message: personalizedMessage
    })
    .select("chat_id")
    .single();

  chat_id = newChat.chat_id;
}

// 💬 Insert message log
await supabase.from("messages").insert({
  chat_id,
  sender_type: "system",
  message_type:"text",   // 👈 IMPORTANT
  message: personalizedMessage
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
            last_updated: new Date().toISOString()
          });
        }

        convoCache.set(p.participant_id, { 
          call_status: "awaiting_rsvp", 
          currentDoc: { name: null, role: null, type: null }, 
          pendingDocs: [], 
          lastUpdated: new Date(), 
          event_id: p.event_id 
        });
        
        successCount++;
      } catch (err) {
        failCount++;
        console.error(`❌ Failed to send template to ${p.phone_number}:`, err.message || err);
      }
    }

    console.log(`📊 Batch Results: ${successCount} sent, ${failCount} failed`);
    
    return res.json({ 
      message: "✅ Batch initial RSVP messages sent", 
      template_used: "invite_rsvp", 
      total_targeted: targetParticipants.length, 
      sent_count: successCount, 
      failed_count: failCount, 
      filtered_by_null_rsvp: !!filter_null_rsvp 
    });
  } catch (err) {
    console.error("❌ sendBatchInitialMessage error:", err);
    return res.status(500).json({ error: "Failed to send batch messages" });
  }
};