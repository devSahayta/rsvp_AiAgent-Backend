// controllers/eventController.js
import { Readable } from "stream";
import { parse } from "@fast-csv/parse";
import { supabase } from "../config/supabase.js";
import {
  createEvent,
  listEventsByUser,
  getEvent,
  bulkInsertParticipants,
} from "../models/eventModel.js";
import { getEventWithParticipants } from "../models/eventModel.js";

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import fetch from "node-fetch";

const eleven = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY, // ✅ keep it secret
});

// simple key-safe filename
const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 60);

// find column by multiple candidates (case-insensitive)
const findColumn = (headers, candidates) => {
  const lower = headers.map((h) => h.toLowerCase());
  for (const c of candidates) {
    const i = lower.indexOf(c.toLowerCase());
    if (i !== -1) return headers[i];
  }
  return null;
};

export const createEventWithCsv = async (req, res) => {
  try {
    const { user_id, event_name, event_date } = req.body;
    const file = req.file;

    if (!user_id || !event_name || !event_date) {
      return res
        .status(400)
        .json({ error: "user_id, event_name, and event_date are required" });
    }
    if (!file) {
      return res
        .status(400)
        .json({ error: "CSV file (field name: dataset) is required" });
    }

    // 1) Upload CSV to Supabase Storage
    const key = `${user_id}/${Date.now()}_${slug(event_name)}.csv`;
    const upload = await supabase.storage
      .from("event-csvs")
      .upload(key, file.buffer, { contentType: file.mimetype || "text/csv", upsert: false });

    if (upload.error) {
      return res
        .status(500)
        .json({ error: `Storage upload failed: ${upload.error.message}` });
    }

    const { data: publicUrlData } = supabase.storage.from("event-csvs").getPublicUrl(key);
    const uploaded_csv = publicUrlData.publicUrl;

    // 2) Create the event row
    const eventPayload = {
      user_id,
      event_name,
      event_date: new Date(event_date).toISOString(),
      uploaded_csv,
      status: "Upcoming",
    };
    const event = await createEvent(eventPayload);

    // 3) Parse CSV → gather participants
    const rows = [];
    const headers = [];
    await new Promise((resolve, reject) => {
      const stream = Readable.from(file.buffer);
      stream
        .pipe(parse({ headers: true, ignoreEmpty: true, trim: true }))
        .on("headers", (h) => headers.push(...h))
        .on("error", reject)
        .on("data", (row) => rows.push(row))
        .on("end", resolve);
    });

    if (rows.length === 0) {
      // No rows—still return event success
      return res.status(201).json({
        message: "Event created. CSV uploaded but contained no rows.",
        event,
        participantsInserted: 0,
      });
    }

    // 4) Resolve column names (case-insensitive)
    const nameCol = findColumn(headers, ["name", "full_name", "fullname"]);
    const phoneCol = findColumn(headers, ["phoneno", "phone", "phone_number", "mobile"]);
    const emailCol = findColumn(headers, ["email", "email_address"]); // email optional

    if (!nameCol || !phoneCol) {
      return res.status(400).json({
        error:
          "CSV must include 'Name' and 'phoneNo' columns (case-insensitive). Accepted: Name/full_name, phoneNo/phone/phone_number/mobile",
      });
    }

    // 5) Build participant records
    const participants = [];
    for (const r of rows) {
      const full_name = (r[nameCol] || "").toString().trim();
      const phone_number = (r[phoneCol] || "").toString().trim();
      const email = emailCol ? (r[emailCol] || "").toString().trim() : null;

      if (!full_name || !phone_number) continue;

      participants.push({
        event_id: event.event_id,
        user_id,
        full_name,
        phone_number,
        email: email || null,
      });
    }

    // 6) Insert participants into DB
    let insertedCount = 0;
    if (participants.length > 0) {
      const inserted = await bulkInsertParticipants(participants);
      insertedCount = inserted.length;
    }

    return res.status(201).json({
      message: "Event created and participants inserted",
      event,
      participantsInserted: insertedCount,
      uploaded_csv,
    });
  } catch (err) {
    console.error("createEventWithCsv error:", err);
    return res.status(500).json({ error: "Server error creating event" });
  }
};

// Get all events for a user
export const getEventsByUser = async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    const events = await listEventsByUser(user_id);
    return res.status(200).json(events);
  } catch (err) {
    console.error("getEventsByUser error:", err);
    return res.status(500).json({ error: "Server error fetching events" });
  }
};

// Get single event by ID
// Get single event by ID
export const getEventById = async (req, res) => {
  try {
    let { eventId } = req.params;
    eventId = eventId.trim();

    const event = await getEventWithParticipants(eventId);

    if (!event) return res.status(404).json({ error: "Event not found" });

    return res.status(200).json(event);
  } catch (err) {
    console.error("getEventById error:", err);
    return res.status(500).json({ error: "Server error fetching event" });
  }
};

// Get RSVP data for an event (participants + conversation results)
export const getRSVPDataByEvent = async (req, res) => {
  try {
    const { eventId } = req.params;

    if (!eventId) return res.status(400).json({ error: "eventId is required" });

    // 1️⃣ Get participants
    const { data: participants, error: pError } = await supabase
      .from("participants")
      .select("participant_id, full_name, phone_number, email, uploaded_at")
      .eq("event_id", eventId);

    if (pError) throw pError;
    if (!participants || participants.length === 0)
      return res.status(404).json({ error: "No participants found" });

    // 2️⃣ Get conversation results for all participants
    const participantIds = participants.map((p) => p.participant_id);
    const { data: conversations, error: cError } = await supabase
      .from("conversation_results")
      .select("participant_id, status, proof_uploaded, document_url, created_at")
      .in("participant_id", participantIds);

    if (cError) throw cError;

    // 3️⃣ Merge participants + conversations
    const rsvpData = participants.map((p) => {
      const convo = conversations.find((c) => c.participant_id === p.participant_id);

      let status = "Pending";
      if (convo?.status === "yes") status = "Confirmed";
      else if (convo?.status === "no") status = "Declined";

      return {
        id: p.participant_id,
        fullName: p.full_name,
        phoneNumber: p.phone_number,
        email: p.email,
        rsvpStatus: status,
        proofUploaded: convo?.proof_uploaded || false,
        documentUpload: convo?.document_url
          ? [{ url: convo.document_url, filename: "Document" }]
          : null,
        timestamp: convo?.created_at || p.uploaded_at,
      };
    });

    res.status(200).json(rsvpData);
  } catch (err) {
    console.error("getRSVPDataByEvent error:", err);
    res.status(500).json({ error: "Failed to fetch RSVP data" });
  }
};



export const triggerBatchCall = async (req, res) => {
  try {
    const { eventId } = req.params;

    // 1️⃣ Fetch event details from events table
    const { data: eventData, error: eventError } = await supabase
      .from("events")
      .select("event_name")
      .eq("event_id", eventId)
      .single();

    if (eventError || !eventData) {
      console.error("Event not found:", eventError);
      return res.status(404).json({ error: "Event not found" });
    }

    // 2️⃣ Fetch participants linked to this event
    const { data: participants, error: participantError } = await supabase
      .from("participants")
      .select("participant_id, full_name, phone_number, event_id")
      .eq("event_id", eventId);

    if (participantError) throw participantError;

    if (!participants || participants.length === 0) {
      return res.status(400).json({ error: "No participants found for this event" });
    }

    // 3️⃣ Prepare recipient data for ElevenLabs
    const recipients = participants.map((p) => ({
      phone_number: p.phone_number,
      // dynamic_variables: {
      //   event_id: p.event_id,
      //   event_name: eventData.event_name,
      //   full_name: p.full_name,
      //   participant_id: p.participant_id, // optional: helpful for tracking responses
      // },
    }));
    console.log(recipients)

    // 4️⃣ Schedule call batch for 1 minute in future
    const scheduledUnix = Math.floor(Date.now() / 1000) + 60;

    // 5️⃣ Build ElevenLabs API payload
    const payload = {
      call_name: `event-${eventId}-${Date.now()}`,
      agent_id: process.env.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: process.env.ELEVENLABS_PHONE_NUMBER_ID,
      scheduled_time_unix: scheduledUnix,
      recipients,
    };

    console.log("Payload to ElevenLabs:", JSON.stringify(payload, null, 2));

    // 6️⃣ Send batch call request to ElevenLabs
    const response = await fetch(
      "https://api.elevenlabs.io/v1/convai/batch-calling/submit",
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    const data = await response.json();
    console.log(data)

    

    if (!response.ok) {
      console.error("❌ ElevenLabs API Error:", data);
      return res.status(500).json({ error: "Batch call failed", details: data });
    }

        // 7️⃣ Update event table with batch_id from ElevenLabs
    const { error: updateError } = await supabase
      .from("events")
      .update({
        batch_id: data.id,
        // batch_status: data.status,
        // batch_created_at: new Date().toISOString(),
      })
      .eq("event_id", eventId);

    if (updateError) {
      console.error("Error updating event with batch_id:", updateError);
      // Still return success since the batch was created
      return res.status(200).json({
        message: "Batch call started but failed to update event",
        batch: data,
        recipients_count: participants.length,
        warning: "Batch ID not saved to database"
      });
    }

    // 7️⃣ (Optional) Store batch info in DB
    // await supabase.from("call_batches").insert([
    //   {
    //     event_id: eventId,
    //     batch_id: data.id,
    //     status: data.status,
    //     created_at: new Date().toISOString(),
    //   },
    // ]);

    return res.status(200).json({
      message: "✅ Batch call started successfully",
      batch: data,
      recipients_count: participants.length,
    });

  } catch (err) {
    console.error("triggerBatchCall error:", err);
    return res.status(500).json({ error: "Failed to trigger batch call" });
  }
};

export const retryBatchCall = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { batch_id } = req.body;

    // Fetch event details
    const { data: eventData, error: eventError } = await supabase
      .from("events")
      .select("event_name")
      .eq("event_id", eventId)
      .single();

    if (eventError || !eventData) {
      return res.status(404).json({ error: "Event not found" });
    }

    // Fetch participants
    const { data: participants, error: participantError } = await supabase
      .from("participants")
      .select("participant_id, full_name, phone_number")
      .eq("event_id", eventId);

    if (participantError || !participants || participants.length === 0) {
      return res.status(400).json({ error: "No participants found" });
    }

    // Prepare recipients
    const recipients = participants.map((p) => ({
      phone_number: p.phone_number,
    }));

    // Schedule for 1 minute in future
    const scheduledUnix = Math.floor(Date.now() / 1000) + 60;

    // Build payload
    const payload = {
      call_name: `${eventData.event_name}-retry-${Date.now()}`,
      agent_id: process.env.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: process.env.ELEVENLABS_PHONE_NUMBER_ID,
      scheduled_time_unix: scheduledUnix,
      recipients,
    };

    // Call ElevenLabs API
    const response = await fetch(
      "https://api.elevenlabs.io/v1/convai/batch-calling/submit",
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("ElevenLabs API error:", data);
      return res.status(500).json({ error: "Batch call retry failed", details: data });
    }

    // Update event table with new batch_id
    await supabase
      .from("events")
      .update({
        batch_id: data.batch_id,
        batch_status: data.status,
        batch_created_at: new Date().toISOString(),
      })
      .eq("event_id", eventId);

    return res.status(200).json({
      message: "Batch call retry started successfully",
      batch: data,
      recipients_count: participants.length,
    });

  } catch (err) {
    console.error("retryBatchCall error:", err);
    return res.status(500).json({ error: "Failed to retry batch call" });
  }
};


// export const triggerBatchCall = async (req, res) => {
//   try {
//     const { eventId } = req.params;

//     // 1. Get all participants for this event
//     const { data: participants, error } = await supabase
//       .from("participants")
//       .select("full_name, phone_number")
//       .eq("event_id", eventId);

//     if (error) throw error;
//     if (!participants || participants.length === 0) {
//       return res.status(400).json({ error: "No participants found" });
//     }

//     // 2. Prepare recipients list
//     const recipients = participants.map((p) => ({
//       phone_number: p.phone_number, // ✅ correct format
//     }));

//     // 3. Schedule for 1 minute in the future
//     const scheduledUnix = Math.floor(Date.now() / 1000) + 60;

//     // 4. Build payload
//     const payload = {
//       call_name: `event-${eventId}-${Date.now()}`,
//       agent_id: process.env.ELEVENLABS_AGENT_ID,
//       agent_phone_number_id: process.env.ELEVENLABS_PHONE_NUMBER_ID,
//       scheduled_time_unix: scheduledUnix,
//       recipients,
//     };

//     // 5. Call ElevenLabs API
//     const response = await fetch(
//       "https://api.elevenlabs.io/v1/convai/batch-calling/submit",
//       {
//         method: "POST",
//         headers: {
//           "xi-api-key": process.env.ELEVENLABS_API_KEY,
//           "Content-Type": "application/json",
//         },
//         body: JSON.stringify(payload),
//       }
//     );

//     const data = await response.json();
//     // console.log(data)

//     if (!response.ok) {
//       console.error("ElevenLabs API error:", data);
//       return res.status(500).json({ error: "Batch call failed", details: data });
//     }

//     // 6. Optional: Save to DB
//     // await supabase.from("call_batches").insert([
//     //   {
//     //     event_id: eventId,
//     //     job_id: data.id,
//     //     status: data.status,
//     //     created_at: new Date().toISOString(),
//     //   },
//     // ]);

//     return res.status(200).json({ message: "Batch call started", batch: data });
//   } catch (err) {
//     console.error("triggerBatchCall error:", err);
//     return res.status(500).json({ error: "Failed to trigger batch call" });
//   }
// };



