// controllers/whatsappController.js
import groq from "../utils/groqClient.js";
import { sendWhatsAppMessage, sendWhatsAppTextMessage } from "../utils/whatsappClient.js";
import { supabase } from "../config/supabase.js";
import dotenv from "dotenv";
dotenv.config();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

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

Goal: Determine RSVP status, guest count (including the participant), and optional notes.
States:
- awaiting_rsvp: Expect Yes | No | Maybe (or close synonyms)
- awaiting_guest_count: Expect a positive integer (including participant)
- awaiting_notes: Expect free-text notes (optional)
- completed: No required info; only handle update requests — otherwise act as helpful assistant.

Rules:
1) Always output EXACTLY one JSON object as the model output. Format:
{
  "reply": "<string to send to user>",
  "rsvp_status": "Yes" | "No" | "Maybe" | null,
  "guest_count": number | null,
  "notes": string | null
}
2) Use participant's name in replies when provided.
3) S2 policy: If the user asks unrelated queries, politely redirect to RSVP:
   "I can only help with the wedding RSVP. Are you attending? Reply Yes / No / Maybe."
4) If ambiguous, ask a single clarifying question.
5) Keep replies brief, formal, and helpful.
`;

// -----------------------------
// Heuristics / helpers
// -----------------------------
const YES_SYNONYMS = [
  "yes", "yeah", "yep", "sure", "of course", "count me in",
  "i'll be there", "coming", "attending", "definitely", "absolutely"
];
const NO_SYNONYMS = [
  "no", "nah", "nope", "not coming", "can't make it", "cannot", "won't", "not attending"
];
const MAYBE_SYNONYMS = ["maybe", "not sure", "might", "possibly", "depends"];

// strict match to avoid "no" in "not"
function exactMatch(text, list) {
  const norm = text.toLowerCase();
  return list.some(
    w => norm === w || norm.startsWith(w + " ") || norm.endsWith(" " + w)
  );
}

function detectQuickIntent(text) {
  if (exactMatch(text, YES_SYNONYMS)) return "Yes";
  if (exactMatch(text, NO_SYNONYMS)) return "No";
  if (exactMatch(text, MAYBE_SYNONYMS)) return "Maybe";
  return null;
}

// --- Rest logic remains same ---
const UPDATE_KEYWORDS = ["update rsvp", "update", "edit", "change", "modify", "edit rsvp"];
const OFFTOPIC_KEYWORDS = ["who won","score","ipl","movie","weather","news","price","bitcoin","stock","youtube","google","facebook","instagram","translate","how to","where is","who is"];

function normalize(s = "") {
  return s.toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
}

function containsAnyNorm(text, arr) {
  const n = normalize(text);
  return arr.some(x => n.includes(x));
}

function detectOffTopic(text) {
  const norm = normalize(text);
  const rsvpHints = ["rsvp","attend","attending","guest","guests","invite","wedding","venue","date","time","when","where","status"];
  if (rsvpHints.some(h => norm.includes(h))) return false;
  return OFFTOPIC_KEYWORDS.some(k => norm.includes(k));
}

function extractJsonString(text) {
  const first = text.indexOf("{");
  if (first === -1) return null;
  let depth = 0;
  for (let i = first; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(first, i + 1);
    }
  }
  return null;
}
function stripCodeFences(s = "") {
  return s.replace(/(^```json|```json$|^```|```$)/g, "").trim();
}

function isUpdateIntent(text) {
  return containsAnyNorm(text, UPDATE_KEYWORDS);
}
// -----------------------------
// Webhook verification (Meta)
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
// Send initial batch (uses personalized message)
// -----------------------------
export const sendBatchInitialMessage = async (req, res) => {
  try {
    const { event_id } = req.body;
    if (!event_id) return res.status(400).json({ error: "event_id required" });

    const { data: participants } = await supabase
      .from("participants")
      .select("*")
      .eq("event_id", event_id);

    if (!participants?.length) return res.status(404).json({ error: "No participants found" });

    for (const p of participants) {
      const name = p.full_name?.trim() || "Guest";
      const msg = `Hello ${name},\nThis is ${WEDDING.couple_names}'s wedding RSVP assistant. Are you planning to attend on ${WEDDING.date}? Reply Yes / No / Maybe.`;
      const waResponse = await sendWhatsAppMessage(p.phone_number, msg);

      if (!waResponse?.error) {
        await supabase.from("conversation_results")
          .upsert({
            participant_id: p.participant_id,
            event_id: p.event_id,
            call_status: "awaiting_rsvp",
            last_updated: new Date().toISOString()
          }, { onConflict: "participant_id" });
      } else {
        console.log(`⚠️ Failed to send to ${p.phone_number}`, waResponse.error || waResponse);
      }
    }

    res.json({ message: "✅ Batch messages sent" });
  } catch (err) {
    console.error("❌ Batch error:", err);
    res.sendStatus(500);
  }
};

// -----------------------------
// MAIN MESSAGE HANDLER
// -----------------------------
export const handleIncomingMessage = async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const incomingType = message.type; // text, image, audio, interactive...
    const userText = message.text?.body?.trim() ?? "";

    console.log("📩 Incoming:", { from, incomingType, preview: userText.slice(0, 200) });

    // Lookup participant
    const { data: participant } = await supabase
      .from("participants")
      .select("*")
      .eq("phone_number", from)
      .maybeSingle();

    if (!participant) {
      console.warn("⚠️ Participant not found for phone:", from);
      // Do not spam unregistered users; keep silent
      return res.sendStatus(200);
    }

    const displayName = participant.full_name?.trim() || "Guest";

    // Ensure conversation record exists
    let { data: convo } = await supabase
      .from("conversation_results")
      .select("*")
      .eq("participant_id", participant.participant_id)
      .maybeSingle();

    if (!convo) {
      const { data: newConvo } = await supabase
        .from("conversation_results")
        .insert({
          participant_id: participant.participant_id,
          event_id: participant.event_id,
          call_status: "awaiting_rsvp",
          last_updated: new Date().toISOString()
        })
        .select()
        .maybeSingle();
      convo = newConvo;
    }

    let callStatus = convo.call_status || "awaiting_rsvp";
    let updatedRSVP = convo.rsvp_status ?? null;
    let updatedGuests = convo.number_of_guests ?? null;
    let updatedNotes = convo.notes ?? null;

    // === Commands that explicitly re-open RSVP flow
    if (isUpdateIntent(userText)) {
      await supabase.from("conversation_results")
        .update({
          rsvp_status: null,
          number_of_guests: null,
          notes: null,
          call_status: "awaiting_rsvp",
          last_updated: new Date().toISOString()
        })
        .eq("participant_id", participant.participant_id);

      await sendWhatsAppTextMessage(from, `Certainly ${displayName}. I will help you update your RSVP.\nWill you attend on ${WEDDING.date}? Reply Yes / No / Maybe.`);
      return res.sendStatus(200);
    }

    // === Non-text media handling (ask for text)
    if (incomingType !== "text" && incomingType !== "interactive") {
      await sendWhatsAppTextMessage(from, `Hello ${displayName}. I received your message but I can only process RSVP via text. Please reply Yes / No / Maybe or ask about the event.`);
      return res.sendStatus(200);
    }

    // === If awaiting guest count: accept numbers robustly
    if (callStatus === "awaiting_guest_count") {
      const numMatch = userText.match(/(\d+)/);
      if (numMatch) {
        const num = parseInt(numMatch[1], 10);
        if (!isNaN(num) && num > 0) {
          updatedGuests = num;
          callStatus = "awaiting_notes";
          await supabase.from("conversation_results").update({
            number_of_guests: updatedGuests,
            call_status: callStatus,
            last_updated: new Date().toISOString()
          }).eq("participant_id", participant.participant_id);

          await sendWhatsAppTextMessage(from, `Understood ${displayName}. How about any notes or special requirements? If none, reply "No".`);
          return res.sendStatus(200);
        }
      }
      await sendWhatsAppTextMessage(from, `${displayName}, please reply with a number like 1, 2, or 3 (including you).`);
      return res.sendStatus(200);
    }

    // === If awaiting notes: accept text and complete
    if (callStatus === "awaiting_notes") {
      updatedNotes = userText || "None";
      callStatus = "completed";
      await supabase.from("conversation_results").update({
        notes: updatedNotes,
        call_status: callStatus,
        rsvp_status: updatedRSVP,
        number_of_guests: updatedGuests,
        last_updated: new Date().toISOString()
      }).eq("participant_id", participant.participant_id);

      await sendWhatsAppTextMessage(from, `Thank you ${displayName}. Your RSVP has been saved.\n• Status: ${updatedRSVP ?? "—"}\n• Guests: ${updatedGuests ?? "—"}\n• Notes: ${updatedNotes}\nYou may reply 'Update' anytime to change.`);
      return res.sendStatus(200);
    }

    // === If already completed: enter helpful assistant mode (formal)
    if (callStatus === "completed") {
      // If user explicitly asked for status, return it directly
      const norm = normalize(userText);
      if (["status","my status","what is my status","what's my status","show my status"].some(k => norm.includes(k))) {
        await sendWhatsAppTextMessage(from, `✅ RSVP Status: ${convo.rsvp_status ?? "—"}\n👥 Guests: ${convo.number_of_guests ?? "—"}\n📝 Notes: ${convo.notes ?? "—"}\nIf you wish to change anything, reply 'Update'.`);
        return res.sendStatus(200);
      }

      // If user asked for common FAQ/local info, serve locally
      if (["venue","where is the venue","what's the venue","location","where is"].some(k => norm.includes(k))) {
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

      // Off-topic detection still applies (firm redirect S2)
      if (detectOffTopic(userText)) {
        await sendWhatsAppTextMessage(from, `I can only assist with the wedding RSVP and event details. Would you like to view your RSVP status or update it?`);
        return res.sendStatus(200);
      }

      // Otherwise, pass the message to AI in "helpful" mode (no automatic confirmations)
      const aiUserContent = [
        `Participant: ${displayName}`,
        `Mode: completed_helpful`,
        `Stored RSVP: ${convo.rsvp_status ?? "null"}`,
        `Guests: ${convo.number_of_guests ?? "null"}`,
        `Notes: ${convo.notes ?? "null"}`,
        `Wedding Info: ${JSON.stringify(WEDDING)}`,
        `UserMessage: "${userText}"`
      ].join("\n");

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
      if (!rawAiText) {
        await sendWhatsAppTextMessage(from, `Hello ${displayName}. I am here to help with event details or to update your RSVP. What would you like to do?`);
        return res.sendStatus(200);
      }

      // Prefer to send AI-crafted reply directly (avoid forcing DB changes in completed mode)
      const cleaned = stripCodeFences(rawAiText);
      // If AI returns JSON, prefer reply field
      let parsed = null;
      const jsonString = extractJsonString(cleaned);
      if (jsonString) {
        try {
          parsed = JSON.parse(jsonString);
        } catch (e) {
          parsed = null;
        }
      }

      let replyToSend = cleaned;
      if (parsed && parsed.reply) replyToSend = parsed.reply;

      // Ensure the reply is formal and uses the participant name (if not present)
      if (!replyToSend.toLowerCase().includes(displayName.toLowerCase())) {
        replyToSend = `${displayName}, ${replyToSend}`;
      }

      await sendWhatsAppTextMessage(from, replyToSend);
      return res.sendStatus(200);
    }

    // === If we reach here, we are in awaiting_rsvp (or unknown) and should process normally

    // Quick local intent detection (fast-path) only in awaiting_rsvp
    const quickIntent = detectQuickIntent(userText);
    if (quickIntent) {
      updatedRSVP = quickIntent;
      callStatus = quickIntent === "Yes" ? "awaiting_guest_count" : "completed";

      let reply;
      if (quickIntent === "Yes") reply = `${displayName}, thank you. How many people including you will attend?`;
      else if (quickIntent === "No") reply = `Understood ${displayName}. Your RSVP is recorded as Not Attending. Reply 'Update' if you change your mind.`;
      else reply = `${displayName}, noted as Maybe. Reply 'Update' if your plans change.`;

      await supabase.from("conversation_results").update({
        rsvp_status: updatedRSVP,
        number_of_guests: updatedGuests,
        notes: updatedNotes,
        call_status: callStatus,
        last_updated: new Date().toISOString()
      }).eq("participant_id", participant.participant_id);

      await sendWhatsAppTextMessage(from, reply);
      return res.sendStatus(200);
    }

    // Local FAQs (avoid AI call when possible)
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

    // Off-topic detection (S2) before AI call
    if (detectOffTopic(userText)) {
      await sendWhatsAppTextMessage(from, `I can only assist with the wedding RSVP and event details. Would you like to view or update your RSVP?`);
      return res.sendStatus(200);
    }

    // === Use AI to interpret ambiguous RSVP-related user messages (awaiting_rsvp)
    const userContent = [
      `Participant: ${displayName}`,
      `Step: ${callStatus}`,
      `RSVP: ${updatedRSVP ?? "null"}`,
      `Guests: ${updatedGuests ?? "null"}`,
      `Notes: ${updatedNotes ?? "null"}`,
      `Wedding Info: ${JSON.stringify(WEDDING)}`,
      `UserMessage: "${userText}"`
    ].join("\n");

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

    // Parse AI JSON if present
    const cleaned = stripCodeFences(rawAiText);
    const jsonString = extractJsonString(cleaned);
    let parsed = null;
    if (jsonString) {
      try {
        parsed = JSON.parse(jsonString);
      } catch (e) {
        parsed = null;
      }
    }

    // Fallback: if parsed missing, attempt intent detection
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

    // Sanitize parsed values
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

    // Apply state transitions
    if (parsedRsvp) {
      updatedRSVP = parsedRsvp;
      callStatus = parsedRsvp === "Yes" ? "awaiting_guest_count" : "completed";
      if (!reply || reply.length < 3) {
        reply = parsedRsvp === "Yes" ? `${displayName}, thank you. How many people including you will attend?` : `${displayName}, understood. Your RSVP has been recorded. Reply 'Update' to change.`;
      }
    }

    if (parsedGuests && Number.isInteger(parsedGuests) && parsedGuests > 0) {
      updatedGuests = parsedGuests;
      if (callStatus === "awaiting_guest_count") callStatus = "awaiting_notes";
    }

    if (parsedNotes && typeof parsedNotes === "string" && parsedNotes.trim().length > 0) {
      updatedNotes = parsedNotes.trim();
      if (callStatus === "awaiting_notes") callStatus = "completed";
    }

    // Persist updates
    await supabase.from("conversation_results").update({
      rsvp_status: updatedRSVP,
      number_of_guests: updatedGuests,
      notes: updatedNotes,
      call_status: callStatus,
      last_updated: new Date().toISOString()
    }).eq("participant_id", participant.participant_id);

    // Make sure reply uses formal tone and includes name
    if (!reply.toLowerCase().includes(displayName.toLowerCase())) {
      reply = `${displayName}, ${reply}`;
    }

    await sendWhatsAppTextMessage(from, reply);
    console.log(`✅ [${participant.participant_id}] state:${callStatus} rsvp:${updatedRSVP} guests:${updatedGuests}`);
    return res.sendStatus(200);

  } catch (err) {
    console.error("❌ Handler Error:", err);
    // Minimal user-safe fallback
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
