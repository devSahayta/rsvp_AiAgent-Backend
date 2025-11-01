  // controllers/whatsappController.js
  import groq from "../utils/groqClient.js";
  import { sendWhatsAppMessage, sendWhatsAppTextMessage } from "../utils/whatsappClient.js";
  import { supabase } from "../config/supabase.js";
  import axios from "axios";
  import dotenv from "dotenv";
  dotenv.config();

  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // Bearer token used to fetch media from WhatsApp Cloud
  const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v17.0";
  const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
  // -----------------------------
  // Dummy wedding info (replace later)
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
  // System prompt (formal tone + S2 firm redirect behavior)
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

  const DOCUMENT_TYPES = ["ID Proof", "Passport", "Visa", "Travel Ticket", "Hotel Booking", "Other"];
  const ROLE_OPTIONS = [
    { label: "Self", prompt: "I’m attending myself" },
    { label: "Spouse", prompt: "I’m bringing my spouse" },
    { label: "Child", prompt: "I’m bringing a child" },
    { label: "Friend", prompt: "A friend is joining me" },
    { label: "Family", prompt: "A family member is joining me" },
    { label: "Other", prompt: "Someone else" }
  ];

  // in-memory cache
  const convoCache = new Map(); // participant_id => { call_status, currentDoc, pendingDocs, lastUpdated, event_id }

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
        // initialize cache
        convoCache.set(p.participant_id, { call_status: "awaiting_rsvp", currentDoc: null, pendingDocs: [], lastUpdated: new Date(), event_id: p.event_id });
      }
      res.json({ message: "✅ Batch messages sent" });
    } catch (err) {
      console.error("❌ Batch error:", err);
      res.sendStatus(500);
    }
  };

  // -----------------------------
  // Ensure and load cache (hybrid mode)
  // -----------------------------
  async function ensureCache(participant) {
    const pid = participant.participant_id;
    if (!convoCache.has(pid)) {
      const { data: convo } = await supabase.from("conversation_results").select("*").eq("participant_id", pid).maybeSingle();
      const cacheObj = {
        call_status: convo?.call_status || "awaiting_rsvp",
        currentDoc: null,
        pendingDocs: [], // each { name, role, document_type, docs: [] }
        lastUpdated: new Date(),
        event_id: participant.event_id
      };
      convoCache.set(pid, cacheObj);
    } else {
      // ensure event_id present
      const c = convoCache.get(pid);
      if (!c.event_id) c.event_id = participant.event_id;
    }
    return convoCache.get(pid);
  }

  // -----------------------------
  // MAIN MESSAGE HANDLER
  // -----------------------------
  export const handleIncomingMessage = async (req, res) => {
    try {
      const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!message) return res.sendStatus(200);

      const from = message.from;
      const incomingType = message.type || "text";
      const userText = message.text?.body?.trim() ?? "";

      console.log("📩 Incoming:", { from, incomingType, preview: (userText || "").slice(0,180) });

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

      // prefer cache state but keep it synced with DB value where relevant
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

        convoCache.set(pid, { call_status: "awaiting_rsvp", currentDoc: null, pendingDocs: [], lastUpdated: new Date(), event_id: eventId });

        await sendWhatsAppTextMessage(from, `Certainly ${displayName}. I will help you update your RSVP. Will you attend on ${WEDDING.date}? Reply Yes / No / Maybe.`);
        return res.sendStatus(200);
      }

      // If non-text and not in upload state => prompt text
      if (incomingType !== "text" && incomingType !== "interactive") {
        if (!(callStatus === "awaiting_doc_upload")) {
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
            // persist guest count
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
        // persist notes
        await supabase.from("conversation_results").update({
          notes,
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        // check rsvp status (DB)
        const rsvpStatus = convo.rsvp_status ?? null;
        // If rsvpStatus not set in DB but user previously answered "Yes" quickIntent, check cache or detect
        const quickRsvp = detectQuickIntent(userText);
        // decide if RSVP is Yes
        const isYes = (rsvpStatus === "Yes") || (cache.call_status === "awaiting_notes" && (convo.rsvp_status === "Yes")) || (detectQuickIntent(userText) === "Yes") || (convo.rsvp_status === "Yes");

        // If the stored RSVP was "Yes" (or we have reason to believe yes), start doc flow; else complete
        if ((convo.rsvp_status === "Yes") || (isYes || (convo.number_of_guests > 0 && convo.rsvp_status === "Yes"))) {
          // start doc flow
          cache.call_status = "awaiting_doc_name";
          cache.pendingDocs = [];
          cache.currentDoc = null;
          cache.lastUpdated = new Date();
          convoCache.set(pid, cache);

          await supabase.from("conversation_results").update({
            call_status: "awaiting_doc_name",
            last_updated: new Date().toISOString()
          }).eq("participant_id", pid);

          await sendWhatsAppTextMessage(from, `Thank you. Now we need to collect document proof for attendees. Let's start with the primary attendee. What is the full name as on the document?`);
          return res.sendStatus(200);
        } else {
          // not attending or maybe -> complete
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

      // ---------- DOCUMENT COLLECTION FLOW ----------
      // awaiting_doc_name
      if (callStatus === "awaiting_doc_name" || cache.call_status === "awaiting_doc_name") {
        // accept provided name; default to participant if empty
        const personName = userText && userText.length > 1 ? userText : displayName;
        cache.currentDoc = { name: personName, role: null, document_type: null, docs: [] };
        cache.call_status = "awaiting_doc_role";
        cache.lastUpdated = new Date();
        convoCache.set(pid, cache);

        // persist that we are in doc flow
        await supabase.from("conversation_results").update({
          call_status: "awaiting_doc_role",
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        await sendWhatsAppTextMessage(from, `Got it. What is the relationship or role for ${personName}? (For example: I’m attending myself; I’m bringing my spouse; a friend is joining me)`);
        return res.sendStatus(200);
      }

      // awaiting_doc_role
      if (callStatus === "awaiting_doc_role" || cache.call_status === "awaiting_doc_role") {
        const norm = normalize(userText);
        // map to short role label
        let roleLabel = "Other";
        if (norm.includes("myself") || norm.includes("self") || norm.includes("i am") || norm.includes("i'm")) roleLabel = "Self";
        else if (norm.includes("spouse") || norm.includes("wife") || norm.includes("husband")) roleLabel = "Spouse";
        else if (norm.includes("child") || norm.includes("son") || norm.includes("daughter")) roleLabel = "Child";
        else if (norm.includes("friend")) roleLabel = "Friend";
        else if (norm.includes("family") || ["mother","father","sister","brother"].some(w => norm.includes(w))) roleLabel = "Family";

        // Save role and advance state to doc type selection (IMPORTANT FIX: update cache.call_status BEFORE replying)
        if (!cache.currentDoc) cache.currentDoc = { name: displayName, role: roleLabel, document_type: null, docs: [] };
        else cache.currentDoc.role = roleLabel;

        cache.call_status = "awaiting_doc_type";
        cache.lastUpdated = new Date();
        convoCache.set(pid, cache);

        // persist minimal pending info (we will persist full upload on file reception)
        // (we do not insert into uploads table yet until file arrives)
        await supabase.from("conversation_results").update({
          call_status: "awaiting_doc_type",
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        // Ask user to pick document type
        const typesList = DOCUMENT_TYPES.map((t, i) => `${i+1}. ${t}`).join("\n");
        await sendWhatsAppTextMessage(from, `Thanks. Which document type will you upload for ${cache.currentDoc.name}? Reply with the type name or number:\n${typesList}`);
        return res.sendStatus(200);
      }

      // awaiting_doc_type
      if (callStatus === "awaiting_doc_type" || cache.call_status === "awaiting_doc_type") {
        const norm = normalize(userText);
        let selectedType = null;
        if (/^\d+$/.test(norm)) {
          const idx = parseInt(norm, 10) - 1;
          if (DOCUMENT_TYPES[idx]) selectedType = DOCUMENT_TYPES[idx];
        } else {
          for (const t of DOCUMENT_TYPES) {
            if (norm.includes(t.toLowerCase().split(" ")[0])) { selectedType = t; break; }
          }
        }
        if (!selectedType) {
          await sendWhatsAppTextMessage(from, `Sorry, I didn't understand the document type. Please reply with one of: ${DOCUMENT_TYPES.join(", ")}`);
          return res.sendStatus(200);
        }

        // save type and request upload
        if (!cache.currentDoc) cache.currentDoc = { name: displayName, role: "Self", document_type: selectedType, docs: [] };
        else cache.currentDoc.document_type = selectedType;
        cache.call_status = "awaiting_doc_upload";
        cache.lastUpdated = new Date();
        convoCache.set(pid, cache);

        await supabase.from("conversation_results").update({
          call_status: "awaiting_doc_upload",
          last_updated: new Date().toISOString()
        }).eq("participant_id", pid);

        await sendWhatsAppTextMessage(from, `Please upload the ${selectedType} for ${cache.currentDoc.name} now (send a photo or file). You may also reply "Later" to skip and upload at another time.`);
        return res.sendStatus(200);
      }

      // awaiting_doc_upload
      if (callStatus === "awaiting_doc_upload" || cache.call_status === "awaiting_doc_upload") {
        // user may reply "later"/"skip"
        const lower = normalize(userText);
        if (["later","skip","upload later","i will upload later"].includes(lower)) {
          // mark pending (no file yet)
          cache.pendingDocs = cache.pendingDocs || [];
          cache.pendingDocs.push({ name: cache.currentDoc.name, role: cache.currentDoc.role, document_type: cache.currentDoc.document_type, docs: [] });
          cache.currentDoc = null;
          cache.call_status = "awaiting_more_docs";
          cache.lastUpdated = new Date();
          convoCache.set(pid, cache);

          await supabase.from("conversation_results").update({ call_status: "awaiting_more_docs", last_updated: new Date().toISOString() }).eq("participant_id", pid);

          await sendWhatsAppTextMessage(from, `No problem. You can upload documents anytime. Would you like to add another attendee's document now? Reply Yes or No.`);
          return res.sendStatus(200);
        }

        // Check for media id inside message (image, document, video)
        const mediaId = message.image?.id || message.document?.id || message.video?.id || message.audio?.id;
        if (!mediaId) {
          await sendWhatsAppTextMessage(from, `I didn't detect a file. Please send a photo or file for ${cache.currentDoc.document_type} or reply "Later" to upload at another time.`);
          return res.sendStatus(200);
        }

        // download and upload to Supabase
        try {
          const mediaUrl = await fetchWhatsAppMediaUrl(mediaId);
          if (!mediaUrl) throw new Error("no media url");
          const { buffer, contentType } = await downloadFileBuffer(mediaUrl);

          // build filename safe
          const timestamp = Date.now();
          const safeName = (cache.currentDoc.name || displayName).replace(/\s+/g, "_").replace(/[^\w_]/g, "").slice(0, 40);
          const ext = contentType && contentType.split("/")[1] ? `.${contentType.split("/")[1].split(";")[0]}` : "";
          // event-scoped folder: participant-docs/<event_id>/<participant_id>/<filename>
          const filename = `${timestamp}_${safeName}${ext}`;

          const publicUrl = await uploadToSupabaseStorage(eventId, pid, filename, buffer, contentType);

          // record doc entry
          const docEntry = { url: publicUrl, type: cache.currentDoc.document_type, uploaded_at: new Date().toISOString() };
          cache.currentDoc.docs = cache.currentDoc.docs || [];
          cache.currentDoc.docs.push(docEntry);

          // persist upload row
          await supabase.from("uploads").insert({
            participant_id: pid,
            participant_relatives_name: cache.currentDoc.name || displayName,
            document_url: publicUrl,
            document_type: cache.currentDoc.document_type,
            proof_uploaded: true,
            role: cache.currentDoc.role || "Self",
            created_at: new Date().toISOString()
          });

          // push to pendingDocs as completed
          cache.pendingDocs = cache.pendingDocs || [];
          cache.pendingDocs.push({ ...cache.currentDoc });
          cache.currentDoc = null;
          cache.call_status = "awaiting_more_docs";
          cache.lastUpdated = new Date();
          convoCache.set(pid, cache);

          // update main convo table to awaiting_more_docs (not completed yet)
          await supabase.from("conversation_results").update({
            call_status: "awaiting_more_docs",
            last_updated: new Date().toISOString()
          }).eq("participant_id", pid);

          await sendWhatsAppTextMessage(from, `✅ Document uploaded successfully for ${cache.pendingDocs[cache.pendingDocs.length - 1].name}. Would you like to add another attendee's document? Reply Yes or No.`);
          return res.sendStatus(200);

        } catch (err) {
          console.error("❌ Media handling error:", err);
          await sendWhatsAppTextMessage(from, `Sorry, I couldn't process that file. Please try sending the image or file again, or reply "Later" to upload later.`);
          return res.sendStatus(200);
        }
      }

      // awaiting_more_docs
      if (callStatus === "awaiting_more_docs" || cache.call_status === "awaiting_more_docs") {
        const intent = detectQuickIntent(userText);
        if (intent === "Yes") {
          cache.call_status = "awaiting_doc_name";
          cache.currentDoc = null;
          cache.lastUpdated = new Date();
          convoCache.set(pid, cache);

          await supabase.from("conversation_results").update({ call_status: "awaiting_doc_name", last_updated: new Date().toISOString() }).eq("participant_id", pid);

          await sendWhatsAppTextMessage(from, `Please provide the full name of the next attendee (as on their document).`);
          return res.sendStatus(200);
        } else if (intent === "No") {
          // finish: allow missing docs but remind
          cache.call_status = "completed";
          cache.lastUpdated = new Date();
          convoCache.set(pid, cache);

          await supabase.from("conversation_results").update({ call_status: "completed", last_updated: new Date().toISOString() }).eq("participant_id", pid);

          // check if primary has at least one doc
          const primaryHasDoc = cache.pendingDocs && cache.pendingDocs.length > 0 && (cache.pendingDocs[0].docs && cache.pendingDocs[0].docs.length > 0);
          if (!primaryHasDoc) {
            await sendWhatsAppTextMessage(from, `Thank you. I noted your details, but we still need at least one document for the primary attendee. You can upload it anytime by sending a photo of the document here. I will remind you politely later.`);
            return res.sendStatus(200);
          }

          await sendWhatsAppTextMessage(from, `All set — thank you ${displayName}. Your documents are recorded. You may reply 'Update' anytime to change details.`);
          return res.sendStatus(200);
        } else {
          await sendWhatsAppTextMessage(from, `Would you like to add another attendee's document? Reply Yes or No.`);
          return res.sendStatus(200);
        }
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
            await sendWhatsAppTextMessage(from, `You’re welcome, ${displayName}. If you change your mind later, feel free to message me anytime.`);
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
          // reopen doc flow
          cache.call_status = "awaiting_doc_name";
          cache.currentDoc = null;
          cache.pendingDocs = cache.pendingDocs || [];
          convoCache.set(pid, cache);

          await supabase.from("conversation_results").update({ call_status: "awaiting_doc_name", last_updated: new Date().toISOString() }).eq("participant_id", pid);

          await sendWhatsAppTextMessage(from, `Sure. Who is the first person you'd like to upload a document for? Please provide their full name as on the document.`);
          return res.sendStatus(200);
        }

        // otherwise use AI for helpful replies (no DB changes)
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
      // quick intent detection
      const quickIntent = detectQuickIntent(userText);
      if (quickIntent) {
        const newCallStatus = quickIntent === "Yes" ? "awaiting_guest_count" : "completed";
        // persist rsvp
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

        // sanitize parsed values
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
          await supabase.from("conversation_results").update({ number_of_guests: parsedGuests, last_updated: new Date().toISOString() }).eq("participant_id", pid);
          cache.lastUpdated = new Date();
          convoCache.set(pid, cache);
        }

        if (parsedNotes && typeof parsedNotes === "string" && parsedNotes.trim().length > 0) {
          await supabase.from("conversation_results").update({ notes: parsedNotes.trim(), last_updated: new Date().toISOString() }).eq("participant_id", pid);
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
