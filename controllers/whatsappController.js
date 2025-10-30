import groq from "../utils/groqClient.js";
import { sendWhatsAppMessage, sendWhatsAppTextMessage } from "../utils/whatsappClient.js";
import { supabase } from "../config/supabase.js";
import dotenv from "dotenv";
dotenv.config();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// ✅ Webhook Verification (Meta requirement)
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

// ✅ AI SYSTEM RULES
const systemPrompt = `
You are a WhatsApp RSVP bot for a wedding 💍

States:
1️⃣ awaiting_rsvp → Expect Yes / No / Maybe
2️⃣ awaiting_guest_count → Expect a number
3️⃣ awaiting_notes → Expect one message
4️⃣ completed → Only update fields on request

Rules:
✅ Guest count should include the participant
✅ Validate only when needed
✅ JSON output ONLY

JSON format:
{
  "reply": "msg",
  "rsvp_status": "Yes" | "No" | "Maybe" | null,
  "guest_count": number | null,
  "notes": string | null
}
`;

// ✅ Initial Template Sending Batch
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
      const sanitizedName = p.full_name?.trim() || "Guest";
      const waResponse = await sendWhatsAppMessage(p.phone_number, sanitizedName);

      if (!waResponse?.error) {
        await supabase.from("conversation_results")
          .upsert({
            participant_id: p.participant_id,
            event_id: p.event_id,
            call_status: "awaiting_rsvp",
            last_updated: new Date().toISOString()
          }, { onConflict: "participant_id" });
      } else {
        console.log(`⚠️ Failed to send to ${p.phone_number}`);
      }
    }

    res.json({ message: "✅ Batch messages sent" });

  } catch (err) {
    console.error("❌ Batch error:", err);
    res.sendStatus(500);
  }
};

// ✅ MAIN BOT MESSAGE HANDLER
export const handleIncomingMessage = async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const userText = message.text?.body?.trim() ?? "";

    console.log("📩 Incoming:", userText);

    // ✅ Fetch participant
    const { data: participant } = await supabase
      .from("participants")
      .select("*")
      .eq("phone_number", from)
      .maybeSingle();

    if (!participant) return res.sendStatus(200);

    // ✅ Fetch/Create conversation
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

    let callStatus = convo.call_status;
    let updatedRSVP = convo.rsvp_status;
    let updatedGuests = convo.number_of_guests;
    let updatedNotes = convo.notes;

    // ✅ Restart RSVP
    if (userText.toLowerCase() === "update rsvp") {
      await supabase
        .from("conversation_results")
        .update({
          rsvp_status: null,
          number_of_guests: null,
          notes: null,
          call_status: "awaiting_rsvp",
          last_updated: new Date().toISOString()
        })
        .eq("participant_id", participant.participant_id);

      await sendWhatsAppTextMessage(
        from,
        "Sure! ✅ Let's update your RSVP.\nWill you attend?\nReply Yes / No / Maybe"
      );

      return res.sendStatus(200);
    }

    // ✅ If expecting guest count → force number
    if (callStatus === "awaiting_guest_count") {
      const num = parseInt(userText);
      if (!isNaN(num) && num > 0) {
        updatedGuests = num;
        callStatus = "awaiting_notes";

        await supabase
          .from("conversation_results")
          .update({
            number_of_guests: updatedGuests,
            call_status: callStatus,
            last_updated: new Date().toISOString()
          })
          .eq("participant_id", participant.participant_id);

        await sendWhatsAppTextMessage(
          from,
          "Got it! ✅ Any notes or special arrangements? 🙂"
        );
        return res.sendStatus(200);
      } else {
        await sendWhatsAppTextMessage(
          from,
          "Please send a number like 3 or 5 😊 (including you)"
        );
        return res.sendStatus(200);
      }
    }

    // ✅ If expecting notes → complete RSVP
    if (callStatus === "awaiting_notes") {
      updatedNotes = userText || "None";
      callStatus = "completed";

      await supabase
        .from("conversation_results")
        .update({
          notes: updatedNotes,
          call_status: callStatus,
          rsvp_status: updatedRSVP,
          number_of_guests: updatedGuests,
          last_updated: new Date().toISOString()
        })
        .eq("participant_id", participant.participant_id);

      await sendWhatsAppTextMessage(
        from,
        `🎉 RSVP Confirmed!\n• Status: ${updatedRSVP}\n• Guests: ${updatedGuests}\n• Notes: ${updatedNotes}\nReply *Update RSVP* anytime to edit ✅`
      );
      return res.sendStatus(200);
    }

    // ✅ TALK TO AI for RSVP decision
    const aiResponse = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Step: ${callStatus}\nRSVP: ${updatedRSVP}\nGuests: ${updatedGuests}\nNotes: ${updatedNotes}\nUser: "${userText}"`,
        },
      ],
      temperature: 0.2,
    });

    const parsed = JSON.parse(aiResponse.choices[0].message.content);

    let reply = parsed.reply;

    // ✅ State Machine
    if (callStatus === "awaiting_rsvp" && parsed.rsvp_status) {
      updatedRSVP = parsed.rsvp_status;
      callStatus = parsed.rsvp_status === "Yes" ? "awaiting_guest_count" : "completed";

      reply = parsed.rsvp_status === "Yes"
        ? "Lovely! 😊 How many people including you?"
        : "All right! ✅ Marked as not attending.\nReply *Update RSVP* anytime later.";
    }

    // ✅ Send the reply
    await sendWhatsAppTextMessage(from, reply);

    // ✅ Save updated state
    await supabase.from("conversation_results")
      .update({
        rsvp_status: updatedRSVP,
        number_of_guests: updatedGuests,
        notes: updatedNotes,
        call_status: callStatus,
        last_updated: new Date().toISOString()
      })
      .eq("participant_id", participant.participant_id);

    console.log(`✅ Updated state → ${callStatus}`);
    return res.sendStatus(200);

  } catch (err) {
    console.error("❌ Handler Error:", err);
    res.sendStatus(500);
  }
};
