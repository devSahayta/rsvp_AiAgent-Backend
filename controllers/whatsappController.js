// controllers/whatsappController.js
import groq from "../utils/groqClient.js";
import { sendWhatsAppMessage, sendWhatsAppTextMessage,sendInitialTemplateMessage} from "../utils/whatsappClient.js";
import { supabase } from "../config/supabase.js";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v17.0";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";

// -----------------------------
// Wedding info
// -----------------------------
const WEDDING = {
  date: "January 25, 2026",
  venue: "Grand Palace Convention Hall",
  location_link: "https://maps.google.com/?q=Grand+Palace",
  dress_code: "Traditional / Formal",
  couple_names: "Arshia & Aditya",
  food_info: "A delightful mix of vegetarian and non-vegetarian dishes"
};

// -----------------------------
// System prompt
// -----------------------------
const systemPrompt = `
You are a formal, helpful WhatsApp assistant that ONLY helps with RSVPs and wedding-related information
for the wedding of ${WEDDING.couple_names}.
`;

// -----------------------------
// Heuristics / helpers
// -----------------------------
const YES_SYNONYMS = [
  "yes", "yeah", "yep", "sure", "of course", "count me in",
  "i'll be there", "ill be there", "coming", "attending", "definitely", "absolutely"
];
const NO_SYNONYMS = [
  "no", "nah", "nope", "not coming", "can't make it", "cannot", "won't", "wont", "not attending", "i'm not attending", "im not attending"
];
const MAYBE_SYNONYMS = ["maybe", "not sure", "might", "possibly", "depends"];
const UPDATE_KEYWORDS = ["update rsvp", "update", "edit", "change", "modify", "edit rsvp", "i want to update"];
const OFFTOPIC_KEYWORDS = ["who won","score","ipl","movie","weather","news","price","bitcoin","stock","youtube","google","facebook","instagram","translate","how to","where is","who is"];

const PRIMARY_DOC_TYPES = ["ID Proof", "Passport"];
const TRAVEL_DOC_TYPES = ["Travel Ticket", "Hotel Booking", "Visa"];

const ROLE_OPTIONS = [
  { label: "Self", prompt: "I'm attending myself" },
  { label: "Spouse", prompt: "I'm bringing my spouse" },
  { label: "Child", prompt: "I'm bringing a child" },
  { label: "Friend", prompt: "A friend is joining me" },
  { label: "Family", prompt: "A family member is joining me" },
  { label: "Other", prompt: "Someone else" }
];

// in-memory cache
const convoCache = new Map();

// normalization helpers
function normalize(s = "") {
  return s?.toString().toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
}
function containsAnyNorm(text, arr) { const n = normalize(text); return arr.some(x => n.includes(x)); }
function exactIntentMatch(text, arr) {
  const n = normalize(text);
  return arr.some(w => n === w || n.startsWith(w + " ") || n.endsWith(" " + w) || n.includes(" " + w + " "));
}
function detectQuickIntent(text) {
  if (exactIntentMatch(text, YES_SYNONYMS)) return "Yes";
  if (exactIntentMatch(text, NO_SYNONYMS)) return "No";
  if (exactIntentMatch(text, MAYBE_SYNONYMS)) return "Maybe";
  return null;
}
function isUpdateIntent(text) { return containsAnyNorm(text, UPDATE_KEYWORDS); }
function detectOffTopic(text) {
  const norm = normalize(text);
  const rsvpHints = ["rsvp","attend","attending","guest","guests","invite","wedding","venue","date","time","when","where","status","document","upload"];
  if (rsvpHints.some(h => norm.includes(h))) return false;
  return OFFTOPIC_KEYWORDS.some(k => norm.includes(k));
}
function stripCodeFences(s = "") { return s.replace(/(^```json|```json$|^```|```$)/g, "").trim(); }
function extractJsonString(text) { const first = text.indexOf("{"); if (first === -1) return null; let depth=0; for (let i=first;i<text.length;i++){ if (text[i]==="{") depth++; if (text[i]==="}"){ depth--; if (depth===0) return text.slice(first,i+1); } } return null; }

// -----------------------------
// WhatsApp media download -> Supabase upload helpers
// -----------------------------
async function fetchWhatsAppMediaUrl(mediaId) {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN not configured");
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${mediaId}`;
  const resp = await axios.get(url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  return resp.data?.url || null;
}
async function downloadFileBuffer(url) {
  const resp = await axios.get(url, { responseType: "arraybuffer", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  return { buffer: Buffer.from(resp.data), contentType: resp.headers["content-type"] };
}
async function uploadToSupabaseStorage(eventId, participantId, filename, buffer, contentType) {
  const path = `${eventId}/${participantId}/${filename}`;

  const { error: uploadError } = await supabase.storage
    .from("participant-docs")
    .upload(path, buffer, {
      contentType,
      upsert: false,
    });

  if (uploadError) throw uploadError;

  const { data: publicData, error: publicErr } = supabase.storage
    .from("participant-docs")
    .getPublicUrl(path);

  if (publicErr) throw publicErr;

  const publicUrl = publicData?.publicUrl || null;
  return publicUrl;
}

// -----------------------------
// verify webhook
// -----------------------------
export const verifyWebhook = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ WhatsApp Webhook Verified!");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
};

// -----------------------------
// send batch initial messages
// -----------------------------
export const sendBatchInitialMessage = async (req, res) => {
  try {
    const { event_id } = req.body;
    if (!event_id) return res.status(400).json({ error: "event_id required" });

    const { data: participants } = await supabase.from("participants").select("*").eq("event_id", event_id);
    if (!participants?.length) return res.status(404).json({ error: "No participants found" });

    for (const p of participants) {
      const name = p.full_name?.trim() || "Guest";
      const msg = `Hello ${name},\nThis is ${WEDDING.couple_names}'s wedding RSVP assistant. Are you planning to attend on ${WEDDING.date}? Reply Yes / No / Maybe.`;
      await sendWhatsAppMessage(p.phone_number, msg);
      await supabase.from("conversation_results").upsert({
        participant_id: p.participant_id,
        event_id: p.event_id,
        call_status: "awaiting_rsvp",
        last_updated: new Date().toISOString()
      }, { onConflict: "participant_id" });
      convoCache.set(p.participant_id, { 
        call_status: "awaiting_rsvp", 
        currentDoc: null, 
        pendingDocs: [], 
        lastUpdated: new Date(), 
        event_id: p.event_id 
      });
    }
    res.json({ message: "✅ Batch messages sent" });
  } catch (err) {
    console.error("❌ Batch error:", err);
    res.sendStatus(500);
  }
};

// -----------------------------
// Ensure and load cache
// -----------------------------
async function ensureCache(participant) {
  const pid = participant.participant_id;
  if (!convoCache.has(pid)) {
    const { data: convo } = await supabase.from("conversation_results").select("*").eq("participant_id", pid).maybeSingle();
    const cacheObj = {
      call_status: convo?.call_status || "awaiting_rsvp",
      currentDoc: null,
      pendingDocs: [],
      lastUpdated: new Date(),
      event_id: participant.event_id
    };
    convoCache.set(pid, cacheObj);
  } else {
    const c = convoCache.get(pid);
    if (!c.event_id) c.event_id = participant.event_id;
  }
  return convoCache.get(pid);
}

// -----------------------------
// MAIN MESSAGE HANDLER
// -----------------------------
export const handleIncomingMessage = async (req, res) => {
  console.log("🔹 FULL WHATSAPP PAYLOAD:", JSON.stringify(req.body, null, 2));
  try {
    
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const incomingType = message.type || "text";
    const userText = message.text?.body?.trim() ?? "";

    console.log("📩 Incoming:", { from, incomingType, preview: (userText || "").slice(0,180) });

   // -------------------- BUTTON HANDLING --------------------
if (incomingType === "button") {

  const buttonPayload = message?.button?.payload || message?.button?.text;
  const buttonText = message?.button?.text;

  console.log("✅ Button Triggered:", buttonPayload, buttonText);

  // ✅ Normalize
  const normalizedPayload = buttonPayload?.toUpperCase()?.replace(/\s+/g, "_");

  // Load participant
  const { data: participant } = await supabase
    .from("participants")
    .select("*")
    .eq("phone_number", from)
    .maybeSingle();

  if (!participant) {
    console.warn("⚠️ Participant not found for phone:", from);
    return res.sendStatus(200);
  }

  const pid = participant.participant_id;
  const displayName = participant.full_name?.trim() || "Guest";
  let cache = await ensureCache(participant);

  // ✅ Case 1: Add Document for Myself
  if (normalizedPayload === "ADD_DOCUMENT_FOR_MYSELF") {
    cache.call_status = "awaiting_additional_attendee_name";
    cache.currentDoc = null;
    cache.pendingDocs = cache.pendingDocs || [];
    cache.lastUpdated = new Date();
    convoCache.set(pid, cache);

    await supabase.from("conversation_results").update({
      call_status: "awaiting_additional_attendee_name",
      last_updated: new Date().toISOString()
    }).eq("participant_id", pid);

    await sendWhatsAppTextMessage(from,
      `Sure. Who is the first person you'd like to upload a document for?`
    );
    return res.sendStatus(200);
  }

  // ✅ Case 2: Wrong response record
  if (normalizedPayload === "WRONG_RESPONSE_RECORD") {
    cache.call_status = "confirm_rsvp_update";
    cache.lastUpdated = new Date();
    convoCache.set(pid, cache);

    await supabase.from("conversation_results").update({
      call_status: "confirm_rsvp_update",
      last_updated: new Date().toISOString()
    }).eq("participant_id", pid);

    await sendWhatsAppTextMessage(from,
      `${displayName}, it seems the recorded RSVP might be incorrect.\nWould you like to update your RSVP? Reply Yes or No.`
    );
    return res.sendStatus(200);
  }

  // ✅ Case 3: I changed my mind (support all variations)
if (
  normalizedPayload === "I_CHANGE_MY_MIND" ||
  normalizedPayload === "I_CHANGED_MY_MIND" ||
  normalizedPayload === "CHANGE_MY_MIND"
) {
  await supabase.from("conversation_results").update({
    rsvp_status: null,
    number_of_guests: null,
    notes: null,
    call_status: "awaiting_rsvp",
    last_updated: new Date().toISOString()
  }).eq("participant_id", pid);

  convoCache.set(pid, {
    call_status: "awaiting_rsvp",
    currentDoc: null,
    pendingDocs: [],
    lastUpdated: new Date()
  });

  await sendWhatsAppTextMessage(from,
    `Alright ${displayName}, let's update your RSVP.\nWill you attend the event? Reply Yes / No / Maybe.`
  );
  return res.sendStatus(200);
}

  return res.sendStatus(200);
}





    // find participant
    const { data: participant } = await supabase.from("participants").select("*").eq("phone_number", from).maybeSingle();
    if (!participant) {
      console.warn("⚠️ Participant not found for phone:", from);
      return res.sendStatus(200);
    }
    const displayName = participant.full_name?.trim() || "Guest";
    const pid = participant.participant_id;
    const eventId = participant.event_id;

    // ensure convo row exists
    let { data: convo } = await supabase.from("conversation_results").select("*").eq("participant_id", pid).maybeSingle();
    if (!convo) {
      const { data: newConvo } = await supabase.from("conversation_results").insert({
        participant_id: pid,
        event_id: eventId,
        call_status: "awaiting_rsvp",
        last_updated: new Date().toISOString()
      }).select().maybeSingle();
      convo = newConvo;
    }

    // ensure cache
    const cache = await ensureCache(participant);
    let callStatus = cache.call_status || convo.call_status || "awaiting_rsvp";

    // Quick: handle update command
    if (isUpdateIntent(userText)) {
      await supabase.from("conversation_results").update({
        rsvp_status: null,
        number_of_guests: null,
        notes: null,
        call_status: "awaiting_rsvp",
        last_updated: new Date().toISOString()
      }).eq("participant_id", pid);

      convoCache.set(pid, { 
        call_status: "awaiting_rsvp", 
        currentDoc: null, 
        pendingDocs: [], 
        lastUpdated: new Date(), 
        event_id: eventId 
      });

      await sendWhatsAppTextMessage(from, `Certainly ${displayName}. I will help you update your RSVP. Will you attend on ${WEDDING.date}? Reply Yes / No / Maybe.`);
      return res.sendStatus(200);
    }

    // Detect when user says RSVP info is wrong
if (/(wrong|incorrect|mistake|not right|change it|modify|update rsvp|wrong response)/i.test(userText)) {
  await sendWhatsAppTextMessage(from,
    `${displayName}, it seems the recorded RSVP might be incorrect.\nWould you like to update your RSVP details?\nReply Yes or No.`
  );

  cache.call_status = "confirm_rsvp_update";
  cache.lastUpdated = new Date();
  convoCache.set(pid, cache);

  await supabase.from("conversation_results").update({
    call_status: "confirm_rsvp_update",
    last_updated: new Date().toISOString()
  }).eq("participant_id", pid);

  return res.sendStatus(200);
}

if (callStatus === "confirm_rsvp_update") {
  const intent = detectQuickIntent(userText);

  if (intent === "Yes") {
    await supabase.from("conversation_results").update({
      rsvp_status: null,
      number_of_guests: null,
      notes: null,
      call_status: "awaiting_rsvp",
      last_updated: new Date().toISOString()
    }).eq("participant_id", pid);

    convoCache.set(pid, {
      call_status: "awaiting_rsvp",
      currentDoc: null,
      pendingDocs: [],
      lastUpdated: new Date(),
      event_id: eventId
    });

    await sendWhatsAppTextMessage(from,
      `Sure ${displayName}, Great.let's update your RSVP.\nWill you attend on ${WEDDING.date}? Reply Yes / No / Maybe.`
    );
    return res.sendStatus(200);
  }

  if (intent === "No") {
    await sendWhatsAppTextMessage(from,
      `No problem ${displayName} .We can continue from where we left off.\nIf you need to update later, reply "Update".`
    );

    // Restore previous state or continue doc flow
    cache.call_status = convo.call_status;
    convoCache.set(pid, cache);

    return res.sendStatus(200);
  }

  await sendWhatsAppTextMessage(from, `Please reply Yes or No.`);
  return res.sendStatus(200);
}


    // If non-text and not in upload state => prompt text
    if (incomingType !== "text" && incomingType !== "interactive") {
      if (!["awaiting_id_proof", "awaiting_travel_doc_upload"].includes(callStatus)) {
        await sendWhatsAppTextMessage(from, `Hello ${displayName}. I received a non-text message but I'm currently expecting text. Please reply Yes / No / Maybe or ask about the event.`);
        return res.sendStatus(200);
      }
    }

    // ---------- RSVP FLOW ----------
    // awaiting_guest_count
    if (callStatus === "awaiting_guest_count") {
      const numMatch = userText.match(/(\d+)/);
      if (numMatch) {
        const num = parseInt(numMatch[1], 10);
        if (!isNaN(num) && num > 0) {
          await supabase.from("conversation_results").update({
            number_of_guests: num,
            call_status: "awaiting_notes",
            last_updated: new Date().toISOString()
          }).eq("participant_id", pid);

          cache.call_status = "awaiting_notes";
          cache.lastUpdated = new Date();
          convoCache.set(pid, cache);

          await sendWhatsAppTextMessage(from, `Understood ${displayName}. How about any notes or special requirements? If none, reply "No".`);
          return res.sendStatus(200);
        }
      }
      await sendWhatsAppTextMessage(from, `${displayName}, please reply with a number like 1, 2, or 3 (including you).`);
      return res.sendStatus(200);
    }

    // awaiting_notes
    if (callStatus === "awaiting_notes") {
      const notes = userText || "None";
      await supabase.from("conversation_results").update({
        notes,
        last_updated: new Date().toISOString()
      }).eq("participant_id", pid);

      const rsvpStatus = convo.rsvp_status ?? null;
      const isYes = (rsvpStatus === "Yes");

      if (isYes) {
        // NEW: Move to summary state instead of directly to doc collection
        cache.call_status = "showing_summary";
        cache.pendingDocs = [];
        cache.currentDoc = null;
        cache.lastUpdated = new Date();
        convoCache.set(pid, cache);

        await supabase.from("conversation_results").update({
          call_status: "showing_summary",
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        // Fetch the updated conversation data for summary
        const { data: updatedConvo } = await supabase
          .from("conversation_results")
          .select("*")
          .eq("participant_id", pid)
          .maybeSingle();

        const summaryMessage = `Hello ${displayName},\nThank you for sharing your RSVP details. Here is the information we have recorded:
• RSVP Status: ${updatedConvo?.rsvp_status || "—"}
• Number of Guests: ${updatedConvo?.number_of_guests || "—"}
• Notes: ${updatedConvo?.notes || "None"}

Before we proceed further, we need to collect document proof for the attendees.
Let's start with the primary attendee. What is the full name as it appears on the document?`;

        await sendWhatsAppTextMessage(from, summaryMessage);
        return res.sendStatus(200);
      } else {
        await supabase.from("conversation_results").update({
          notes,
          call_status: "completed",
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        cache.call_status = "completed";
        convoCache.set(pid, cache);

        await sendWhatsAppTextMessage(from, `Thank you ${displayName}. Your RSVP has been saved.\n• Status: ${convo.rsvp_status ?? "—"}\n• Guests: ${convo.number_of_guests ?? "—"}\n• Notes: ${notes}\nYou may reply 'Update' anytime to change.`);
        return res.sendStatus(200);
      }
    }

    // NEW STATE: showing_summary (transition to document collection)
    if (callStatus === "showing_summary" || cache.call_status === "showing_summary") {
      // User provides the primary attendee name after seeing summary
      const personName = userText && userText.length > 1 ? userText : displayName;
      
      // Validate name input (should be at least 2 characters)
      if (personName.length < 2) {
        await sendWhatsAppTextMessage(from, `Please provide the full name of the primary attendee as it appears on their document.`);
        return res.sendStatus(200);
      }
      
      cache.currentDoc = { 
        name: personName, 
        role: null, 
        document_type: null, 
        docs: [],
        hasIdProof: false,
        hasTravelDoc: false 
      };
      cache.call_status = "awaiting_doc_role";
      cache.lastUpdated = new Date();
      convoCache.set(pid, cache);

      await supabase.from("conversation_results").update({
        call_status: "awaiting_doc_role",
        last_updated: new Date().toISOString()
      }).eq("participant_id", pid);

      await sendWhatsAppTextMessage(from, `Got it. What is the relationship or role for ${personName}? (For example: I'm attending myself; I'm bringing my spouse; a friend is joining me)`);
      return res.sendStatus(200);
    }

    // ---------- NEW DOCUMENT COLLECTION FLOW ----------
    // REMOVED: awaiting_doc_name state (now handled by showing_summary)

    // awaiting_doc_role
    // awaiting_doc_role
    if (callStatus === "awaiting_doc_role" || cache.call_status === "awaiting_doc_role") {
      const norm = normalize(userText);
      let roleLabel = "Other";
      if (norm.includes("myself") || norm.includes("self") || norm.includes("i am") || norm.includes("i'm")) roleLabel = "Self";
      else if (norm.includes("spouse") || norm.includes("wife") || norm.includes("husband")) roleLabel = "Spouse";
      else if (norm.includes("child") || norm.includes("son") || norm.includes("daughter")) roleLabel = "Child";
      else if (norm.includes("friend")) roleLabel = "Friend";
      else if (norm.includes("family") || ["mother","father","sister","brother"].some(w => norm.includes(w))) roleLabel = "Family";

      if (!cache.currentDoc) {
        cache.currentDoc = { name: displayName, role: roleLabel, document_type: null, docs: [], hasIdProof: false, hasTravelDoc: false };
      } else {
        cache.currentDoc.role = roleLabel;
      }

      // NEW: Ask for ID Proof or Passport directly
      cache.call_status = "awaiting_id_proof";
      cache.lastUpdated = new Date();
      convoCache.set(pid, cache);

      await supabase.from("conversation_results").update({
        call_status: "awaiting_id_proof",
        last_updated: new Date().toISOString()
      }).eq("participant_id", pid);

      await sendWhatsAppTextMessage(from, `Thanks. Please upload either an ID Proof or Passport for ${cache.currentDoc.name}. Send a photo or PDF file now.`);
      return res.sendStatus(200);
    }

    // NEW: awaiting_id_proof (mandatory)
    if (callStatus === "awaiting_id_proof" || cache.call_status === "awaiting_id_proof") {
      const mediaId = message.image?.id || message.document?.id || message.video?.id;
      
      if (!mediaId) {
        const lower = normalize(userText);
        if (["later","skip","upload later","don't have","dont have"].some(k => lower.includes(k))) {
          await sendWhatsAppTextMessage(from, `I'm sorry, but ID Proof or Passport is mandatory for ${cache.currentDoc.name}. Please upload either document to continue.`);
          return res.sendStatus(200);
        }
        
        await sendWhatsAppTextMessage(from, `Please send a photo or file of the ID Proof or Passport for ${cache.currentDoc.name}.`);
        return res.sendStatus(200);
      }

      // Download and upload ID proof
      try {
        const mediaUrl = await fetchWhatsAppMediaUrl(mediaId);
        if (!mediaUrl) throw new Error("no media url");
        const { buffer, contentType } = await downloadFileBuffer(mediaUrl);

        const timestamp = Date.now();
        const safeName = (cache.currentDoc.name || displayName).replace(/\s+/g, "_").replace(/[^\w_]/g, "").slice(0, 40);
        const ext = contentType && contentType.split("/")[1] ? `.${contentType.split("/")[1].split(";")[0]}` : "";
        const filename = `${timestamp}_${safeName}_id${ext}`;
        const storagePath = `${eventId}/${pid}/${filename}`;

        const { error: uploadError } = await supabase.storage
          .from("participant-docs")
          .upload(storagePath, buffer, { contentType, upsert: false });

        if (uploadError) throw uploadError;

        const docType = "ID Proof";

        await supabase.from("uploads").insert({
          participant_id: pid,
          participant_relatives_name: cache.currentDoc.name || displayName,
          document_url: `participant-docs/${storagePath}`,
          document_type: docType,
          proof_uploaded: true,
          role: cache.currentDoc.role || "Self",
          created_at: new Date().toISOString()
        });

        cache.currentDoc.hasIdProof = true;
        cache.currentDoc.document_type = docType;
        
        // Move to asking for travel documents
        cache.call_status = "awaiting_travel_docs_choice";
        cache.lastUpdated = new Date();
        convoCache.set(pid, cache);

        await supabase.from("conversation_results").update({
          call_status: "awaiting_travel_docs_choice",
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        await sendWhatsAppTextMessage(from, `✅ ${docType} uploaded successfully for ${cache.currentDoc.name}.\n\nDo you have travel documents (flight tickets or hotel bookings) to upload? Reply Yes or No.`);
        return res.sendStatus(200);

      } catch (err) {
        console.error("❌ ID proof upload error:", err);
        await sendWhatsAppTextMessage(from, `Sorry, I couldn't process that file. Please try sending the ID Proof or Passport again.`);
        return res.sendStatus(200);
      }
    }

    // NEW: awaiting_travel_docs_choice
    if (callStatus === "awaiting_travel_docs_choice" || cache.call_status === "awaiting_travel_docs_choice") {
      const intent = detectQuickIntent(userText);
      
      if (intent === "Yes") {
        cache.call_status = "awaiting_travel_doc_type";
        cache.lastUpdated = new Date();
        convoCache.set(pid, cache);

        await supabase.from("conversation_results").update({
          call_status: "awaiting_travel_doc_type",
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        await sendWhatsAppTextMessage(from, `Great! Which travel document would you like to upload?\n1. Travel Ticket\n2. Hotel Booking\n3. Visa\n\nReply with the number or name.`);
        return res.sendStatus(200);
        
      } else if (intent === "No") {
        cache.call_status = "awaiting_arrival_info";
        cache.lastUpdated = new Date();
        convoCache.set(pid, cache);

        await supabase.from("conversation_results").update({
          call_status: "awaiting_arrival_info",
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        await sendWhatsAppTextMessage(from, `No problem. When will ${cache.currentDoc.name} arrive at the venue location? Please provide the date and approximate time.\n\nFor example: "January 24, 2026 at 3 PM" or "24th Jan evening"`);
        return res.sendStatus(200);
        
      } else {
        await sendWhatsAppTextMessage(from, `Do you have travel documents (tickets or hotel bookings) to upload for ${cache.currentDoc.name}? Reply Yes or No.`);
        return res.sendStatus(200);
      }
    }

    // NEW: awaiting_travel_doc_type
    if (callStatus === "awaiting_travel_doc_type" || cache.call_status === "awaiting_travel_doc_type") {
      const norm = normalize(userText);
      let selectedType = null;
      
      if (norm === "1" || norm.includes("ticket") || norm.includes("flight")) {
        selectedType = "Travel Ticket";
      } else if (norm === "2" || norm.includes("hotel") || norm.includes("booking")) {
        selectedType = "Hotel Booking";
      } else if (norm === "3" || norm.includes("visa")) {
        selectedType = "Visa";
      }
      
      if (!selectedType) {
        await sendWhatsAppTextMessage(from, `Please select:\n1. Travel Ticket\n2. Hotel Booking\n3. Visa\n\nReply with the number or name.`);
        return res.sendStatus(200);
      }

      cache.currentDoc.travelDocType = selectedType;
      cache.call_status = "awaiting_travel_doc_upload";
      cache.lastUpdated = new Date();
      convoCache.set(pid, cache);

      await supabase.from("conversation_results").update({
        call_status: "awaiting_travel_doc_upload",
        last_updated: new Date().toISOString()
      }).eq("participant_id", pid);

      await sendWhatsAppTextMessage(from, `Please upload the ${selectedType} for ${cache.currentDoc.name}. Send a photo or PDF file.`);
      return res.sendStatus(200);
    }

    // NEW: awaiting_travel_doc_upload
    if (callStatus === "awaiting_travel_doc_upload" || cache.call_status === "awaiting_travel_doc_upload") {
      const mediaId = message.image?.id || message.document?.id;
      
      if (!mediaId) {
        const lower = normalize(userText);
        if (["skip","later","don't have","dont have","no"].some(k => lower.includes(k))) {
          cache.call_status = "awaiting_arrival_info";
          cache.lastUpdated = new Date();
          convoCache.set(pid, cache);

          await supabase.from("conversation_results").update({
            call_status: "awaiting_arrival_info",
            last_updated: new Date().toISOString()
          }).eq("participant_id", pid);

          await sendWhatsAppTextMessage(from, `No problem. When will ${cache.currentDoc.name} arrive at the venue location? Please provide the date and approximate time.`);
          return res.sendStatus(200);
        }
        
        await sendWhatsAppTextMessage(from, `Please send the ${cache.currentDoc.travelDocType} file for ${cache.currentDoc.name}, or reply "Skip" if you don't have it.`);
        return res.sendStatus(200);
      }

      // Upload travel document
      try {
        const mediaUrl = await fetchWhatsAppMediaUrl(mediaId);
        if (!mediaUrl) throw new Error("no media url");
        const { buffer, contentType } = await downloadFileBuffer(mediaUrl);

        const timestamp = Date.now();
        const safeName = (cache.currentDoc.name || displayName).replace(/\s+/g, "_").replace(/[^\w_]/g, "").slice(0, 40);
        const ext = contentType && contentType.split("/")[1] ? `.${contentType.split("/")[1].split(";")[0]}` : "";
        const filename = `${timestamp}_${safeName}_travel${ext}`;
        const storagePath = `${eventId}/${pid}/${filename}`;

        const { error: uploadError } = await supabase.storage
          .from("participant-docs")
          .upload(storagePath, buffer, { contentType, upsert: false });

        if (uploadError) throw uploadError;

        await supabase.from("uploads").insert({
          participant_id: pid,
          participant_relatives_name: cache.currentDoc.name || displayName,
          document_url: `participant-docs/${storagePath}`,
          document_type: cache.currentDoc.travelDocType,
          proof_uploaded: true,
          role: cache.currentDoc.role || "Self",
          created_at: new Date().toISOString()
        });

        cache.currentDoc.hasTravelDoc = true;
        
        cache.call_status = "awaiting_more_travel_docs";
        cache.lastUpdated = new Date();
        convoCache.set(pid, cache);

        await supabase.from("conversation_results").update({
          call_status: "awaiting_more_travel_docs",
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        await sendWhatsAppTextMessage(from, `✅ ${cache.currentDoc.travelDocType} uploaded successfully!\n\nWould you like to upload another travel document? Reply Yes or No.`);
        return res.sendStatus(200);

      } catch (err) {
        console.error("❌ Travel doc upload error:", err);
        await sendWhatsAppTextMessage(from, `Sorry, I couldn't process that file. Please try again or reply "Skip".`);
        return res.sendStatus(200);
      }
    }

    // NEW: awaiting_more_travel_docs
    if (callStatus === "awaiting_more_travel_docs" || cache.call_status === "awaiting_more_travel_docs") {
      const intent = detectQuickIntent(userText);
      
      if (intent === "Yes") {
        cache.call_status = "awaiting_travel_doc_type";
        cache.lastUpdated = new Date();
        convoCache.set(pid, cache);

        await supabase.from("conversation_results").update({
          call_status: "awaiting_travel_doc_type",
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        await sendWhatsAppTextMessage(from, `Which travel document would you like to upload next?\n1. Travel Ticket\n2. Hotel Booking\n3. Visa`);
        return res.sendStatus(200);
        
      } else if (intent === "No") {
        cache.pendingDocs = cache.pendingDocs || [];
        cache.pendingDocs.push({ ...cache.currentDoc });
        cache.currentDoc = null;
        cache.call_status = "awaiting_more_attendees";
        cache.lastUpdated = new Date();
        convoCache.set(pid, cache);

        await supabase.from("conversation_results").update({
          call_status: "awaiting_more_attendees",
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        await sendWhatsAppTextMessage(from, `Perfect! Would you like to add documents for another attendee? Reply Yes or No.`);
        return res.sendStatus(200);
        
      } else {
        await sendWhatsAppTextMessage(from, `Would you like to upload another travel document? Reply Yes or No.`);
        return res.sendStatus(200);
      }
    }

    // NEW: awaiting_arrival_info
    if (callStatus === "awaiting_arrival_info" || cache.call_status === "awaiting_arrival_info") {
      const arrivalInfo = userText.trim();
      
      if (arrivalInfo.length < 5) {
        await sendWhatsAppTextMessage(from, `Please provide the arrival date and time for ${cache.currentDoc.name}. For example: "January 24 at 3 PM" or "24th evening"`);
        return res.sendStatus(200);
      }

      // Store arrival info in notes
      const currentNotes = convo.notes || "";
      const newNote = `${cache.currentDoc.name} arrival: ${arrivalInfo}`;
      const updatedNotes = currentNotes ? `${currentNotes}\n${newNote}` : newNote;

      await supabase.from("conversation_results").update({
        notes: updatedNotes,
        last_updated: new Date().toISOString()
      }).eq("participant_id", pid);

      // Mark this person as complete
      cache.pendingDocs = cache.pendingDocs || [];
      cache.pendingDocs.push({ ...cache.currentDoc, arrivalInfo });
      cache.currentDoc = null;
      cache.call_status = "awaiting_more_attendees";
      cache.lastUpdated = new Date();
      convoCache.set(pid, cache);

      await supabase.from("conversation_results").update({
        call_status: "awaiting_more_attendees",
        last_updated: new Date().toISOString()
      }).eq("participant_id", pid);

      await sendWhatsAppTextMessage(from, `✅ Noted! ${cache.pendingDocs[cache.pendingDocs.length - 1].name} will arrive: ${arrivalInfo}\n\nWould you like to add documents for another attendee? Reply Yes or No.`);
      return res.sendStatus(200);
    }

    // NEW: awaiting_more_attendees (renamed from awaiting_more_docs)
    if (callStatus === "awaiting_more_attendees" || cache.call_status === "awaiting_more_attendees") {
      const intent = detectQuickIntent(userText);
      
      if (intent === "Yes") {
        // NEW: Go directly to showing_summary_additional for additional attendees
        cache.call_status = "awaiting_additional_attendee_name";
        cache.currentDoc = null;
        cache.lastUpdated = new Date();
        convoCache.set(pid, cache);

        await supabase.from("conversation_results").update({
          call_status: "awaiting_additional_attendee_name",
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        await sendWhatsAppTextMessage(from, `Please provide the full name of the next attendee (as on their document).`);
        return res.sendStatus(200);
        
      } else if (intent === "No") {
        // Complete the RSVP
        cache.call_status = "completed";
        cache.lastUpdated = new Date();
        convoCache.set(pid, cache);

        await supabase.from("conversation_results").update({
          call_status: "completed",
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        const docCount = cache.pendingDocs?.length || 0;
        await sendWhatsAppTextMessage(from, `✅ All set — thank you ${displayName}!\n\n📋 Summary:\n• RSVP: ${convo.rsvp_status}\n• Guests: ${convo.number_of_guests}\n• Documents collected: ${docCount}\n\nYou may reply 'Update' anytime to make changes.`);
        return res.sendStatus(200);
        
      } else {
        await sendWhatsAppTextMessage(from, `Would you like to add documents for another attendee? Reply Yes or No.`);
        return res.sendStatus(200);
      }
    }

    // NEW STATE: awaiting_additional_attendee_name (for 2nd, 3rd attendees)
    if (callStatus === "awaiting_additional_attendee_name" || cache.call_status === "awaiting_additional_attendee_name") {
      const personName = userText && userText.length > 1 ? userText : displayName;
      
      // Validate name input
      if (personName.length < 2) {
        await sendWhatsAppTextMessage(from, `Please provide the full name of the attendee as it appears on their document.`);
        return res.sendStatus(200);
      }
      
      cache.currentDoc = { 
        name: personName, 
        role: null, 
        document_type: null, 
        docs: [],
        hasIdProof: false,
        hasTravelDoc: false 
      };
      cache.call_status = "awaiting_doc_role";
      cache.lastUpdated = new Date();
      convoCache.set(pid, cache);

      await supabase.from("conversation_results").update({
        call_status: "awaiting_doc_role",
        last_updated: new Date().toISOString()
      }).eq("participant_id", pid);

      await sendWhatsAppTextMessage(from, `Got it. What is the relationship or role for ${personName}? (For example: I'm attending myself; I'm bringing my spouse; a friend is joining me)`);
      return res.sendStatus(200);
    }

    // ---------- COMPLETED MODE ----------
    if (callStatus === "completed" || cache.call_status === "completed") {
      const norm = normalize(userText);

      // status request
      if (["status","my status","what is my status","what's my status","show my status"].some(k => norm.includes(k))) {
        const { data: docs } = await supabase.from("uploads").select("*").eq("participant_id", pid);
        const docsCount = docs?.length ?? 0;
        await sendWhatsAppTextMessage(from, `✅ RSVP Status: ${convo.rsvp_status ?? "—"}\n👥 Guests: ${convo.number_of_guests ?? "—"}\n📝 Notes: ${convo.notes ?? "—"}\n📎 Documents uploaded: ${docsCount}\nIf you wish to change anything, reply 'Update'.`);
        return res.sendStatus(200);
      }

      // short replies for No RSVP
      if (convo.rsvp_status === "No") {
        if (["thanks","thank you","thx","ok","okay","noted"].includes(norm)) {
          await sendWhatsAppTextMessage(from, `You're welcome, ${displayName}. If you change your mind later, feel free to message me anytime.`);
          return res.sendStatus(200);
        }
        if (["venue","where is the venue","what's the venue","location","where is"].some(k => norm.includes(k))) {
          await sendWhatsAppTextMessage(from, `📍 Venue: ${WEDDING.venue}\nDirections: ${WEDDING.location_link}`);
          return res.sendStatus(200);
        }
        if (["date","when is the wedding","wedding date","what is the date"].some(k => norm.includes(k))) {
          await sendWhatsAppTextMessage(from, `📅 Date: ${WEDDING.date}`);
          return res.sendStatus(200);
        }
        if (detectOffTopic(userText)) {
          await sendWhatsAppTextMessage(from, `I can only assist with the wedding RSVP and event details. If you change your mind later, please reply 'Update'.`);
          return res.sendStatus(200);
        }
        await sendWhatsAppTextMessage(from, `Understood. If you need anything else regarding the event, let me know.`);
        return res.sendStatus(200);
      }

      // completed & Yes/Maybe -> allow doc uploads anytime
      if (normalize(userText).includes("upload") || normalize(userText).includes("document")) {
        cache.call_status = "awaiting_additional_attendee_name";
        cache.currentDoc = null;
        cache.pendingDocs = cache.pendingDocs || [];
        convoCache.set(pid, cache);

        await supabase.from("conversation_results").update({ 
          call_status: "awaiting_additional_attendee_name", 
          last_updated: new Date().toISOString() 
        }).eq("participant_id", pid);

        await sendWhatsAppTextMessage(from, `Sure. Who is the first person you'd like to upload a document for? Please provide their full name as on the document.`);
        return res.sendStatus(200);
      }

      // otherwise use AI for helpful replies
      if (detectOffTopic(userText)) {
        await sendWhatsAppTextMessage(from, `I can only assist with the wedding RSVP and event details. Would you like to view or update your RSVP?`);
        return res.sendStatus(200);
      }

      // AI helper
      const aiUserContent = [
        `Participant: ${displayName}`,
        `Mode: completed_helpful`,
        `Stored RSVP: ${convo.rsvp_status ?? "null"}`,
        `Guests: ${convo.number_of_guests ?? "null"}`,
        `Notes: ${convo.notes ?? "null"}`,
        `Wedding Info: ${JSON.stringify(WEDDING)}`,
        `UserMessage: "${userText}"`
      ].join("\n");

      try {
        const aiResponse = await groq.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: aiUserContent }
          ],
          temperature: 0.25,
          max_tokens: 400
        });
        const rawAiText = aiResponse?.choices?.[0]?.message?.content ?? "";
        const cleaned = stripCodeFences(rawAiText);
        let parsed = null;
        const jsonString = extractJsonString(cleaned);
        if (jsonString) {
          try { parsed = JSON.parse(jsonString); } catch (e) { parsed = null; }
        }
        let replyToSend = cleaned;
        if (parsed && parsed.reply) replyToSend = parsed.reply;
        if (!replyToSend.toLowerCase().includes(displayName.toLowerCase())) replyToSend = `${displayName}, ${replyToSend}`;
        await sendWhatsAppTextMessage(from, replyToSend);
        return res.sendStatus(200);
      } catch (e) {
        console.error("❌ AI error:", e);
        await sendWhatsAppTextMessage(from, `Hello ${displayName}. I am here to help with event details or to update your RSVP. What would you like to do?`);
        return res.sendStatus(200);
      }
    }

    // ---------- AWAITING RSVP (default) ----------
    const quickIntent = detectQuickIntent(userText);
    if (quickIntent) {
      const newCallStatus = quickIntent === "Yes" ? "awaiting_guest_count" : "completed";
      await supabase.from("conversation_results").update({
        rsvp_status: quickIntent,
        call_status: newCallStatus,
        last_updated: new Date().toISOString()
      }).eq("participant_id", pid);

      cache.call_status = newCallStatus;
      convoCache.set(pid, cache);

      let reply;
      if (quickIntent === "Yes") reply = `${displayName}, thank you. How many people including you will attend?`;
      else if (quickIntent === "No") reply = `Understood ${displayName}. Your RSVP is recorded as Not Attending. Reply 'Update' if you change your mind.`;
      else reply = `${displayName}, noted as Maybe. Reply 'Update' if your plans change.`;

      await sendWhatsAppTextMessage(from, reply);
      return res.sendStatus(200);
    }

    // FAQs before AI
    const norm = normalize(userText);
    if (["venue","where is the venue","what's the venue","location"].some(k => norm.includes(k))) {
      await sendWhatsAppTextMessage(from, `📍 Venue: ${WEDDING.venue}\nDirections: ${WEDDING.location_link}`);
      return res.sendStatus(200);
    }
    if (["date","when is the wedding","wedding date","what is the date"].some(k => norm.includes(k))) {
      await sendWhatsAppTextMessage(from, `📅 Date: ${WEDDING.date}`);
      return res.sendStatus(200);
    }
    if (["dress","dress code","what to wear"].some(k => norm.includes(k))) {
      await sendWhatsAppTextMessage(from, `👗 Dress code: ${WEDDING.dress_code}`);
      return res.sendStatus(200);
    }
    if (["food","menu","vegetarian","non-veg","catering"].some(k => norm.includes(k))) {
      await sendWhatsAppTextMessage(from, `🍽️ Food: ${WEDDING.food_info}`);
      return res.sendStatus(200);
    }

    // off-topic detection
    if (detectOffTopic(userText)) {
      await sendWhatsAppTextMessage(from, `I can only assist with the wedding RSVP and event details. Would you like to view or update your RSVP?`);
      return res.sendStatus(200);
    }

    // final AI attempt (ambiguous awaiting_rsvp)
    const userContent = [
      `Participant: ${displayName}`,
      `Step: ${callStatus}`,
      `RSVP: ${convo.rsvp_status ?? "null"}`,
      `Guests: ${convo.number_of_guests ?? "null"}`,
      `Notes: ${convo.notes ?? "null"}`,
      `Wedding Info: ${JSON.stringify(WEDDING)}`,
      `UserMessage: "${userText}"`
    ].join("\n");

    try {
      const aiResponse = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ],
        temperature: 0.2,
        max_tokens: 400
      });

      const rawAiText = aiResponse?.choices?.[0]?.message?.content ?? "";
      if (!rawAiText) {
        await sendWhatsAppTextMessage(from, `${displayName}, I am sorry — I did not understand. Are you attending on ${WEDDING.date}? Reply Yes / No / Maybe.`);
        return res.sendStatus(200);
      }

      const cleaned = stripCodeFences(rawAiText);
      const jsonString = extractJsonString(cleaned);
      let parsed = null;
      if (jsonString) {
        try { parsed = JSON.parse(jsonString); } catch (e) { parsed = null; }
      }
      if (!parsed) {
        const aiNorm = normalize(rawAiText);
        const fallbackIntent = detectQuickIntent(aiNorm);
        parsed = {
          reply: cleaned.trim().slice(0, 800),
          rsvp_status: fallbackIntent,
          guest_count: null,
          notes: null
        };
      }

      let reply = parsed.reply || `${displayName}, could you please confirm: Are you attending on ${WEDDING.date}? Reply Yes / No / Maybe.`;
      let parsedRsvp = parsed.rsvp_status ?? null;
      let parsedGuests = parsed.guest_count ?? parsed.guestCount ?? null;
      let parsedNotes = parsed.notes ?? null;

      if (typeof parsedRsvp === "string") {
        const p = parsedRsvp.trim().toLowerCase();
        if (p.startsWith("y")) parsedRsvp = "Yes";
        else if (p.startsWith("n")) parsedRsvp = "No";
        else if (p.startsWith("m")) parsedRsvp = "Maybe";
        else parsedRsvp = null;
      }

      if (parsedRsvp) {
        const newCallStatus = parsedRsvp === "Yes" ? "awaiting_guest_count" : "completed";
        await supabase.from("conversation_results").update({
          rsvp_status: parsedRsvp,
          call_status: newCallStatus,
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        cache.call_status = newCallStatus;
        convoCache.set(pid, cache);

        if (!reply || reply.length < 3) {
          reply = parsedRsvp === "Yes" ? `${displayName}, thank you. How many people including you will attend?` : `${displayName}, understood. Your RSVP has been recorded. Reply 'Update' to change.`;
        }
      }

      if (parsedGuests && Number.isInteger(parsedGuests) && parsedGuests > 0) {
        await supabase.from("conversation_results").update({ 
          number_of_guests: parsedGuests, 
          last_updated: new Date().toISOString() 
        }).eq("participant_id", pid);
        cache.lastUpdated = new Date();
        convoCache.set(pid, cache);
      }

      if (parsedNotes && typeof parsedNotes === "string" && parsedNotes.trim().length > 0) {
        await supabase.from("conversation_results").update({ 
          notes: parsedNotes.trim(), 
          last_updated: new Date().toISOString() 
        }).eq("participant_id", pid);
        cache.lastUpdated = new Date();
        convoCache.set(pid, cache);
      }

      if (!reply.toLowerCase().includes(displayName.toLowerCase())) reply = `${displayName}, ${reply}`;
      await sendWhatsAppTextMessage(from, reply);
      return res.sendStatus(200);

    } catch (err) {
      console.error("❌ AI fallback error:", err);
      await sendWhatsAppTextMessage(from, `${displayName}, I could not process that. Please reply Yes / No / Maybe to update your RSVP.`);
      return res.sendStatus(200);
    }

  } catch (err) {
    console.error("❌ Handler Error:", err);
    try {
      const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const from = message?.from;
      if (from) {
        await sendWhatsAppTextMessage(from, `Apologies — an error occurred. Please reply Yes / No / Maybe to update your RSVP.`);
      }
    } catch (e) {
      console.error("❌ Failed fallback send:", e);
    }
    return res.sendStatus(500);
  }
};

export const startInitialMessage = async (req, res) => {
  try {
    const { event_id } = req.body;

    if (!event_id) {
      return res.status(400).json({ error: "Event ID is required" });
    }

    const { data: participants, error } = await supabase
      .from("participants")
      .select("full_name, phone_number")
      .eq("event_id", event_id);

    if (error) throw error;

    for (const person of participants) {
      let phone = person.phone_number.toString().trim();
      if (!phone.startsWith("91")) {
        phone = "91" + phone;
      }

      console.log("📩 Sending Initial Message to =>", phone, person.full_name);

      const templateComponents = [
        {
          type: "body",
          parameters: [
            { type: "text", text: person.full_name || "Guest" }
          ]
        }
      ];

      await sendInitialTemplateMessage(
        phone,
        "rsvp_initial_message",
        templateComponents
      );
    }

    return res.json({
      success: true,
      message: "✅ Initial messages triggered successfully!"
    });

  } catch (err) {
    console.error("❌ WhatsApp Send Error:", err.response?.data || err);
    return res.status(500).json({ error: "WhatsApp send failed" });
  }
};

