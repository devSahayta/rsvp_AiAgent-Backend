
import groq from "../utils/groqClient.js";
import { sendWhatsAppMessage,sendWhatsAppTextMessage } from "../utils/whatsappClient.js";
import { supabase } from "../config/supabase.js";
import dotenv from "dotenv";
dotenv.config();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// ✅ Webhook Verification for Meta
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

// ✅ AI system prompt
const systemPrompt = `
You are a WhatsApp RSVP bot for Arshia & Aditya's wedding 💍

ONLY FOLLOW THIS STATE MACHINE:

1️⃣ awaiting_rsvp → Expect Yes / No / Maybe
2️⃣ awaiting_guest_count → Expect number
3️⃣ awaiting_notes → Expect one short note (optional)
4️⃣ completed → Ask user to reply "Update RSVP" to change

✅ NEVER change RSVP status after it's set the first time
✅ If step = awaiting_guest_count → ONLY fill guest_count
✅ If step = awaiting_notes → ONLY fill notes
✅ Never ask irrelevant questions

Respond STRICT JSON ONLY:
{
  "reply": "short friendly reply",
  "rsvp_status": "Yes" | "No" | "Maybe" | null,
  "guest_count": number | null,
  "notes": string | null
}
`;


export const sendBatchInitialMessage = async (req, res) => {
  try {
    const { event_id } = req.body;
    if (!event_id) {
      return res.status(400).json({ error: "event_id required" });
    }

    const { data: participants } = await supabase
      .from("participants")
      .select("participant_id, phone_number, full_name, event_id")
      .eq("event_id", event_id);

    if (!participants || participants.length === 0) {
      return res.status(404).json({ error: "No participants found" });
    }

    for (const p of participants) {
      console.log(`📤 Sending to: ${p.phone_number}`);

      const sanitizedName = p.full_name?.replace(/\s+/g, " ").trim() || "Guest";
const waResponse = await sendWhatsAppMessage(p.phone_number, sanitizedName);


      if (!waResponse?.error) {
        // ✅ Check if conversation already exists
        const { data: existing } = await supabase
          .from("conversation_results")
          .select("*")
          .eq("participant_id", p.participant_id)
          .single();

        if (!existing) {
          // ✅ Create the conversation row
          await supabase.from("conversation_results").insert([
           {
  participant_id: p.participant_id,
  event_id: p.event_id,
 rsvp_status: null,
  number_of_guests: null,
  notes: null,
  call_status: "awaiting_rsvp",
  last_updated: new Date().toISOString()
}


          ]);
          console.log("🆕 New conversation created & awaiting RSVP ✅");
        } else {
          // ✅ Update state if exists
          await supabase
            .from("conversation_results")
            .update({
              call_status: "awaiting_rsvp",
              last_updated: new Date().toISOString()
            })
            .eq("participant_id", p.participant_id);
        }
      } else {
        console.log(`⚠️ Failed sending to ${p.phone_number}, skipping DB update`);
      }
    }

    return res.json({ message: "Batch initiated ✅" });

  } catch (err) {
    console.error("❌ Batch sending error:", err);
    return res.sendStatus(500);
  }
};



export const handleIncomingMessage = async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const userText = message.text?.body?.trim() ?? "";
    console.log("📩 Incoming message:", userText);

    // ✅ Fetch participant
    const { data: participant } = await supabase
      .from("participants")
      .select("*")
      .eq("phone_number", from)
      .single();

    if (!participant) {
      console.log("❌ No participant found", from);
      return res.sendStatus(200);
    }

// ✅ Fetch conversation row
let { data: convo } = await supabase
  .from("conversation_results")
  .select("*")
  .eq("participant_id", participant.participant_id)
  .maybeSingle();

// ✅ If no conversation exists — create one NOW
if (!convo) {
  const { data: newConvo, error: insertError } = await supabase
    .from("conversation_results")
    .insert([
      {
        participant_id: participant.participant_id,
        event_id: participant.event_id,
       rsvp_status: null,
        number_of_guests: null,
        notes: null,
        call_status: "awaiting_rsvp",
        last_updated: new Date().toISOString()
      }
    ])
    .select("*")
    .maybeSingle();

  if (insertError || !newConvo) {
    console.error("❌ Failed to create new conversation:", insertError);
    return res.sendStatus(500);
  }

  convo = newConvo;
  console.log("🆕 Conversation created on first incoming message ✅");
}


// ✅ Now it's safe to read properties
let callStatus = convo.call_status || "awaiting_rsvp";
let updatedRSVP = convo.rsvp_status || "None";
let updatedGuests = convo.number_of_guests || null;
let updatedNotes = convo.notes || null;


    // ✅ Normalize state
    if (!callStatus || callStatus === "None" || callStatus === "message_initiated") {
      callStatus = "awaiting_rsvp";
    }

    console.log("📌 Current State:", callStatus);

    // ✅ Send info + text to AI
    const aiResponse = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: systemPrompt },
        {
  role: "user",
  content: `
Current Conversation State:
- Step: ${callStatus}
- RSVP So Far: ${updatedRSVP}
- Guests So Far: ${updatedGuests}
- Notes So Far: ${updatedNotes}

User Says: "${userText}"

Rules:
If step = awaiting_guest_count → ONLY fill guest_count.
If step = awaiting_notes → ONLY fill notes.
If RSVP already locked → Do NOT change RSVP status.
Return only JSON.
`
}

      ],
      temperature: 0.4
    });

    const parsed = JSON.parse(aiResponse.choices[0].message.content);
    console.log("🤖 AI Parsed:", parsed);

    let reply = parsed.reply;

   if (callStatus === "awaiting_rsvp") {

  if (parsed.rsvp_status === "Yes") {
    updatedRSVP = "Yes";
    callStatus = "awaiting_guest_count";
    reply = "Lovely! 😊 How many guests including you?";
  }

  else if (parsed.rsvp_status === "No") {
    updatedRSVP = "No";
    callStatus = "completed";
    reply = "No worries! ✅\nWe’ll mark that you are not attending.\nIf plans change, reply: *Update RSVP*";
  }

  else if (parsed.rsvp_status === "Maybe") {
    updatedRSVP = "Maybe";
    callStatus = "completed";
    reply = "Sure! 😊\nWe’ll mark you as *Maybe*.\nLet us know anytime if you confirm ✅";
  }

  else {
    reply = "Just checking — will you be attending? ✅\nYes / No / Maybe";
  }
}


    else if (callStatus === "awaiting_guest_count") {
      if (parsed.guest_count !== null) {
        updatedGuests = parsed.guest_count;
        callStatus = "awaiting_notes";
        reply = "Great! Any notes or special arrangements? 🙂";
      } else {
        reply = "Please send the number of people.\nEg: 0 / 1 / 2";
      }
    }

    else if (callStatus === "awaiting_notes") {
      updatedNotes = parsed.notes || "";
      callStatus = "completed";
      reply =
        `🎉 Your RSVP is confirmed!\n\n• Status: ${updatedRSVP}\n• Guests: ${updatedGuests}\n• Notes: ${updatedNotes || "None"}\n\nLooking forward to seeing you! 🥳`;
    }

    else if (callStatus === "completed") {
      reply = "Your RSVP is already confirmed ✅\nReply *Update RSVP* if you want changes.";
    }

   // ✅ Try sending reply first
const waResponse = await sendWhatsAppTextMessage(from, reply);

if (waResponse?.error) {
  console.log("🚫 WA message failed — NOT updating convo state");
  return res.sendStatus(200); // stop the flow
}

// ✅ Only if success → update DB
await supabase
  .from("conversation_results")
  .update({
    rsvp_status: updatedRSVP,
    number_of_guests: updatedGuests,
    notes: updatedNotes,
    call_status: callStatus,
    last_updated: new Date().toISOString()
  })
  .eq("result_id", convo.result_id);

console.log("✅ Reply sent & DB updated:", reply);
return res.sendStatus(200);


  } catch (error) {
    console.error("❌ WA Handler Error:", error);
    return res.sendStatus(500);
  }
};



