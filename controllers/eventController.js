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

import {
  getAgent,
  duplicateAgent,
  updateAgent,
  deleteAgent,
} from "../utils/elevenlabsApi.js";

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
  const BASE_AGENTS = {
    wedding: "agent_4101k6yqrwh1e2ysgw5fvtzbb0qw",
  };

  try {
    const { user_id, event_name, event_date, event_type, knowledge_base_id } =
      req.body;
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

    if (!event_type || !knowledge_base_id) {
      return res.status(400).json({
        error: "event_type and knowledge_base_id are required",
      });
    }

    // 1) Upload CSV to Supabase Storage
    const key = `${user_id}/${Date.now()}_${slug(event_name)}.csv`;
    const upload = await supabase.storage
      .from("event-csvs")
      .upload(key, file.buffer, {
        contentType: file.mimetype || "text/csv",
        upsert: false,
      });

    if (upload.error) {
      return res
        .status(500)
        .json({ error: `Storage upload failed: ${upload.error.message}` });
    }

    const { data: publicUrlData } = supabase.storage
      .from("event-csvs")
      .getPublicUrl(key);
    const uploaded_csv = publicUrlData.publicUrl;

    // 2) Create the event row
    const eventPayload = {
      user_id,
      event_name,
      event_date: new Date(event_date).toISOString(),
      uploaded_csv,
      status: "Upcoming",
      event_type,
    };
    const event = await createEvent(eventPayload);

    //A) Fetch KB from DB
    const { data: kb, error: kbError } = await supabase
      .from("knowledge_bases")
      .select("*")
      .eq("id", knowledge_base_id)
      .single();

    if (kbError || !kb) {
      return res.status(400).json({ error: "Invalid knowledge base" });
    }

    //B) Duplicate agent
    const baseAgentId = BASE_AGENTS[event_type];

    if (!baseAgentId) {
      return res.status(400).json({ error: "Invalid Event Type" });
    }

    const duplicatedAgent = await duplicateAgent({
      agentId: baseAgentId,
      name: `${event_name} Agent`,
    });

    //C) Get duplicated agent config
    const agentConfig = await getAgent(duplicatedAgent.agent_id);

    //D) Inject TEXT knowledge base
    agentConfig.conversation_config.agent.prompt.knowledge_base = [
      {
        type: "text",
        id: kb.elevenlabs_kb_id,
        name: kb.name,
        usage_mode: "auto",
      },
    ];

    //E) Update agent (PATCH)
    await updateAgent({
      agentId: duplicatedAgent.agent_id,
      payload: agentConfig,
    });

    //F) Update event row
    await supabase
      .from("events")
      .update({
        elevenlabs_agent_id: duplicatedAgent.agent_id,
        knowledge_base_id,
      })
      .eq("event_id", event.event_id);

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
    const phoneCol = findColumn(headers, [
      "phoneno",
      "phone",
      "phone_number",
      "mobile",
    ]);
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
      .select(
        "participant_id, status, proof_uploaded, document_url, created_at"
      )
      .in("participant_id", participantIds);

    if (cError) throw cError;

    // 3️⃣ Merge participants + conversations
    const rsvpData = participants.map((p) => {
      const convo = conversations.find(
        (c) => c.participant_id === p.participant_id
      );

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
// ✅ Get single event + participants securely with user check
export const getEventDetails = async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user.user_id;

    // ✅ Enforce that event belongs to the logged-in user
    const event = await getEventWithParticipants(eventId);

    if (!event || event.user_id !== userId) {
      return res.status(404).json({ error: "Event not found or unauthorized" });
    }

    return res.status(200).json(event);
  } catch (err) {
    console.error("getEventDetails error:", err);
    return res.status(500).json({ error: "Server error fetching event" });
  }
};

// GET /api/events/:eventId/conversation-status
export const getConversationStatus = async (req, res) => {
  const { eventId } = req.params;

  const { count, error } = await supabase
    .from("conversation_results")
    .select("*", { count: "exact", head: true })
    .eq("event_id", eventId);

  if (error) return res.status(500).json({ error });

  res.json({ hasConversations: count > 0 });
};

export const getEventRSVPData = async (req, res) => {
  try {
    const { eventId } = req.params;

    // ✅ Get Participants
    const { data: participants, error: pError } = await supabase
      .from("participants")
      .select("*")
      .eq("event_id", eventId);

    if (pError) return res.status(400).json({ error: pError });

    if (!participants.length) return res.json([]);

    const finalData = await Promise.all(
      participants.map(async (p) => {
        const { data: conv } = await supabase
          .from("conversation_results")
          .select("*")
          .eq("participant_id", p.participant_id)
          .order("last_updated", { ascending: false })
          .limit(1);

        const { data: upload } = await supabase
          .from("uploads")
          .select("*")
          .eq("participant_id", p.participant_id)
          .limit(1);

        return {
          id: p.participant_id,
          fullName: p.full_name,
          phoneNumber: p.phone_number,
          timestamp: conv?.[0]?.last_updated || p.uploaded_at,
          rsvpStatus: conv?.[0]?.rsvp_status || "Pending",
          numberOfGuests: conv?.[0]?.number_of_guests || 0,
          notes: conv?.[0]?.notes || "-",
          callStatus: conv?.[0]?.call_status || "Pending",
          proofUploaded: !!upload?.[0],
          documentUpload: upload?.[0] || null,
          eventName: p.event_id, // Optional: You can JOIN event name also
        };
      })
    );

    res.json(finalData);
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ error: "Server Error" });
  }
};

// GET /api/events/:eventId/dashboard
export const getDashboardData = async (req, res) => {
  try {
    const eventId = req.params.eventId;

    const { data, error } = await supabase
      .from("conversation_results")
      .select("result_id")
      .eq("event_id", eventId);

    if (error) throw error;

    res.json({
      event_id: eventId,
      conversations: data || [],
    });
  } catch (err) {
    console.error("Dashboard fetch error:", err);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
};

// GET /api/uploads/:participantId
export const getUploadsForParticipant = async (req, res) => {
  const { participantId } = req.params;

  const { data, error } = await supabase
    .from("uploads")
    .select("*")
    .eq("participant_id", participantId);

  if (error) return res.status(500).json({ error });

  res.json(data);
};

export const triggerBatchCall = async (req, res) => {
  try {
    const { eventId } = req.params;
    console.log("🚀 Starting batch call for eventId:", eventId);

    // 1️⃣ Fetch event details
    const { data: eventData, error: eventError } = await supabase
      .from("events")
      .select("*")
      .eq("event_id", eventId)
      .single();

    // console.log({eventData})
    // return res.status(404).json({ eventData }) 


    if (eventError || !eventData) {
      console.error("Event not found:", eventError);
      return res.status(404).json({ error: "Event not found" });
    }

    console.log("✅ Event found:", eventData.event_name);

    // 2️⃣ Fetch participants linked to this event
    const { data: participants, error: participantError } = await supabase
      .from("participants")
      .select("participant_id, full_name, phone_number, event_id")
      .eq("event_id", eventId);

    if (participantError) throw participantError;

    if (!participants || participants.length === 0) {
      console.log("❌ No participants found");
      return res
        .status(400)
        .json({ error: "No participants found for this event" });
    }

    console.log(`✅ Found ${participants.length} participants`);

    // 3️⃣ Prepare recipients with proper phone number format
    const recipients = participants.map((p) => {
      // Format phone number to E.164 format (with + prefix)
      let formattedPhone = String(p.phone_number || "").trim();

      // Add + if missing
      if (formattedPhone && !formattedPhone.startsWith("+")) {
        formattedPhone = "+" + formattedPhone;
      }

      console.log(`📱 Participant ${p.participant_id} phone:`, formattedPhone);

      const recipient = {
        id: String(p.participant_id),
        conversation_initiation_client_data: {
          conversation_config_override: {
            agent: {
              prompt: null,
              first_message: null,
              language: null,
            },
            tts: {
              voice_id: null,
            },
          },
          dynamic_variables: {
            eventId: String(eventId),
            eventName: String(eventData.event_name),
          },
        },
        phone_number: formattedPhone, // ✅ Now with + prefix
      };

      return recipient;
    });

    console.log("📞 First recipient structure:");
    console.log(JSON.stringify(recipients[0], null, 2));

    const scheduledUnix = Math.floor(Date.now() / 1000) + 60;
    console.log(
      "⏰ Scheduled for:",
      new Date(scheduledUnix * 1000).toISOString()
    );

    const agentConfig = await getAgent(eventData.elevenlabs_agent_id);
  
    if(!agentConfig)
    {
      return res.status(404).json({ error: "agent not found" }) 
    }


    const payload = {
      call_name: `event-${eventId}-${Date.now()}`,
      agent_id: eventData.elevenlabs_agent_id,
      agent_phone_number_id: process.env.ELEVENLABS_PHONE_NUMBER_ID,
      whatsapp_params: null,
      recipients: recipients,
      scheduled_time_unix: scheduledUnix,
    };

    console.log("\n📦 FULL PAYLOAD:");
    console.log(JSON.stringify(payload, null, 2));
    console.log("\n");

    // 4️⃣ Trigger ElevenLabs Batch
    console.log("🔄 Sending request to ElevenLabs...");
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
    console.log("📥 ElevenLabs Response Status:", response.status);
    console.log("📥 ElevenLabs Response Data:");
    console.log(JSON.stringify(data, null, 2));

    if (!response.ok) {
      console.error("❌ ElevenLabs API Error:", data);
      return res
        .status(500)
        .json({ error: "Batch call failed", details: data });
    }

    console.log("✅ Batch call created successfully, batch_id:", data.id);

    // 5️⃣ Update event with batch_id + status
    const { error: updateError } = await supabase
      .from("events")
      .update({
        batch_id: data.id,
        batch_status: data.status || "queued",
      })
      .eq("event_id", eventId);

    if (updateError) {
      console.error("⚠️ Error updating event with batch_id:", updateError);
    } else {
      console.log("✅ Event updated with batch_id");
    }

    // 6️⃣ 🔥 Create placeholder conversation_results for each participant if missing
    console.log("🔄 Creating placeholder conversation results...");
    for (const participant of participants) {
      const { data: existing, error: existingError } = await supabase
        .from("conversation_results")
        .select("participant_id")
        .eq("participant_id", participant.participant_id)
        .eq("event_id", eventId)
        .maybeSingle();

      if (existingError) {
        console.warn("⚠️ Check existing conversation error:", existingError);
        continue;
      }

      if (!existing) {
        const { error: insertError } = await supabase
          .from("conversation_results")
          .insert([
            {
              participant_id: participant.participant_id,
              event_id: eventId,
              call_status: "pending",
              rsvp_status: null,
              number_of_guests: 0,
              notes: null,
              last_updated: new Date().toISOString(),
            },
          ]);

        if (insertError) {
          console.error(
            `❌ Error inserting placeholder for participant ${participant.participant_id}:`,
            insertError
          );
        } else {
          console.log(
            `✅ Placeholder created for participant ${participant.participant_id}`
          );
        }
      } else {
        console.log(
          `ℹ️ Conversation result already exists for participant ${participant.participant_id}`
        );
      }
    }

    console.log("🎉 Batch call process completed successfully!");

    // 7️⃣ Return success response
    return res.status(200).json({
      message: "✅ Batch call started successfully & placeholders created",
      batch: data,
      batch_id: data.id,
      recipients_count: participants.length,
      debug: {
        event_id: eventId,
        event_name: eventData.event_name,
        scheduled_time: new Date(scheduledUnix * 1000).toISOString(),
        sample_recipient: recipients[0] || null,
      },
    });
  } catch (err) {
    console.error("💥 triggerBatchCall error:", err);
    console.error("Stack trace:", err.stack);
    return res.status(500).json({
      error: "Failed to trigger batch call",
      details: err.message,
    });
  }
};

export const retryBatchCall = async (req, res) => {
  try {
    const { eventId } = req.params;

    // 1️⃣ Fetch event batch_id
    const { data: eventData, error: eventError } = await supabase
      .from("events")
      .select("event_name, batch_id")
      .eq("event_id", eventId)
      .single();

    if (eventError || !eventData) {
      return res.status(404).json({ error: "Event not found" });
    }

    if (!eventData.batch_id) {
      return res.status(400).json({ error: "No batch found for this event" });
    }

    // 2️⃣ Call ElevenLabs Retry API
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/batch-calling/${eventData.batch_id}/retry`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ ElevenLabs Retry API error:", data);
      return res.status(500).json({
        error: "Retry batch call failed",
        details: data,
      });
    }

    // 3️⃣ Update event with new batch_id and status
    await supabase
      .from("events")
      .update({
        batch_id: data.id || eventData.batch_id,
        batch_status: data.status || "retrying",
        batch_created_at: new Date().toISOString(),
      })
      .eq("event_id", eventId);

    return res.status(200).json({
      message: "✅ Retry batch call started successfully",
      batch: data,
    });
  } catch (err) {
    console.error("retryBatchCall error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

export const syncBatchStatuses = async (req, res) => {
  try {
    const { eventId } = req.params;

    // 1. Fetch event to get batch_id
    const { data: eventData, error: eventError } = await supabase
      .from("events")
      .select("batch_id")
      .eq("event_id", eventId)
      .single();

    if (eventError || !eventData?.batch_id) {
      return res.status(404).json({ error: "Batch not found for this event" });
    }

    const batchId = eventData.batch_id;

    // 2. Fetch ElevenLabs batch details
    const elevenResponse = await fetch(
      `https://api.elevenlabs.io/v1/convai/batch-calling/${batchId}`,
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const batchData = await elevenResponse.json();

    if (!elevenResponse.ok) {
      console.error("ElevenLabs API error:", batchData);
      return res.status(500).json({
        error: "Failed to fetch batch details",
        details: batchData,
      });
    }

    const recipients = batchData.recipients || [];
    if (recipients.length === 0)
      return res.status(400).json({ error: "No recipients found in batch" });

    // 3. Fetch all participants for the event
    const { data: participants, error: partError } = await supabase
      .from("participants")
      .select("participant_id, phone_number")
      .eq("event_id", eventId);

    if (partError) throw partError;

    // 🚫 Chatbot-managed protected call statuses (DO NOT OVERWRITE)
    const protectedStatuses = [
      "awaiting_rsvp",
      "awaiting_additional_attendee_name",
      "awaiting_id_proof",
      "awaiting_travel_doc_upload",
      "awaiting_guest_count",
      "awaiting_notes",
      "awaiting_doc_role",
      "awaiting_travel_docs_choice",
      "awaiting_travel_doc_type",
      "awaiting_arrival_info",
      "awaiting_more_attendees",
      "awaiting_more_travel_docs",
      "completed",
    ];

    // 4. Map recipients to participants via phone number
    let updatedCount = 0;

    for (const recipient of recipients) {
      const participant = participants.find(
        (p) => p.phone_number === recipient.phone_number
      );

      if (!participant) continue;

      // Fetch current stored status
      const { data: existing } = await supabase
        .from("conversation_results")
        .select("call_status")
        .eq("participant_id", participant.participant_id)
        .maybeSingle();

      // 🚫 If Chatbot controls this state → do NOT overwrite
      if (protectedStatuses.includes(existing?.call_status)) {
        continue;
      }

      // ✅ Safe to update with ElevenLabs status
      const { error: updateError } = await supabase
        .from("conversation_results")
        .update({ call_status: recipient.status })
        .eq("participant_id", participant.participant_id);

      if (!updateError) updatedCount++;
    }

    // 5. Update batch_status in events
    await supabase
      .from("events")
      .update({ batch_status: batchData.status })
      .eq("event_id", eventId);

    return res.status(200).json({
      message: "Batch call statuses synced successfully",
      updated: updatedCount,
      total: recipients.length,
      batch_status: batchData.status,
    });
  } catch (err) {
    console.error("syncBatchStatuses error:", err);
    return res.status(500).json({ error: "Failed to sync batch statuses" });
  }
};

export const getBatchStatus = async (req, res) => {
  try {
    const { eventId } = req.params;

    // Fetch event to get batch_id
    const { data: eventData, error } = await supabase
      .from("events")
      .select("batch_id")
      .eq("event_id", eventId)
      .single();

    if (error || !eventData?.batch_id) {
      return res.status(404).json({ error: "No batch found for this event" });
    }

    const batchId = eventData.batch_id;

    // Fetch batch details from ElevenLabs
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/batch-calling/${batchId}`,
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error("getBatchStatus error:", err);
    return res.status(500).json({ error: "Failed to fetch batch status" });
  }
};

// GET all participants for a specific event
export const getEventParticipants = async (req, res) => {
  try {
    const event_id = req.params.event_id;
    const user_id = req.query.user_id; // ensure user owns the event

    if (!event_id) {
      return res.status(400).json({ error: "event_id is required" });
    }

    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    // Fetch event + participants
    const eventData = await getEventWithParticipants(event_id);

    if (!eventData) {
      return res.status(404).json({ error: "Event not found" });
    }

    // Validate this event belongs to the user
    if (eventData.user_id !== user_id) {
      return res.status(403).json({ error: "Unauthorized access to event" });
    }

    return res.json({
      event: eventData,
      participants: eventData.participants,
    });
  } catch (err) {
    console.error("Error fetching event participants:", err);
    res.status(500).json({ error: "Server error fetching participants" });
  }
};

// ------------------------------------delete ----------------------------------------

// export const deleteEvent = async (req, res) => {
//   try {
//     const { eventId } = req.params;

//     // 1️⃣ Check event exists
//     const { data: eventData, error: eventError } = await supabase
//       .from("events")
//       .select("event_id")
//       .eq("event_id", eventId)
//       .single();

//     if (eventError || !eventData) {
//       return res.status(404).json({ error: "Event not found" });
//     }

//     // 2️⃣ Delete event (triggers cascade delete)
//     const { error } = await supabase
//       .from("events")
//       .delete()
//       .eq("event_id", eventId);

//     if (error) {
//       return res.status(500).json({ error: "Delete failed", details: error });
//     }

//     return res.status(200).json({ message: "Event deleted successfully" });
//   } catch (err) {
//     return res.status(500).json({ error: "Internal server error" });
//   }
// };

export const deleteEvent = async (req, res) => {
  try {
    const { eventId } = req.params;
    if (!eventId) {
      return res.status(400).json({ error: "Event ID missing" });
    }
    // 1) :mag_right: Get all chats for this event
    const { data: chats } = await supabase
      .from("chats")
      .select("chat_id")
      .eq("event_id", eventId);
    const chatIds = chats?.map((c) => c.chat_id) || [];
    // 2) :wastebasket: Delete messages under those chats
    if (chatIds.length > 0) {
      await supabase.from("messages").delete().in("chat_id", chatIds);
    }
    // 3) :mag_right: Get participants for this event
    const { data: participants } = await supabase
      .from("participants")
      .select("participant_id")
      .eq("event_id", eventId);
    const participantIds = participants?.map((p) => p.participant_id) || [];
    // 4) :wastebasket: Delete participant-linked data (DB)
    if (participantIds.length > 0) {
      await supabase
        .from("uploads")
        .delete()
        .in("participant_id", participantIds);
      await supabase
        .from("travel_itinerary")
        .delete()
        .in("participant_id", participantIds);
      await supabase
        .from("conversation_results")
        .delete()
        .in("participant_id", participantIds);
    }
    // :star::star::star: NEW STEP: DELETE FILES FROM SUPABASE STORAGE :star::star::star:
    try {
      if (participantIds.length > 0) {
        // bucket name: participant-docs
        for (let pid of participantIds) {
          // Delete folder for each participant
          await supabase.storage.from("participant-docs").remove([`${pid}/`]); // :warning: deletes everything in the folder
        }
      }
    } catch (storageErr) {
      console.error(":warning: Storage cleanup failed:", storageErr);
    }
    // 5) :wastebasket: Delete chats for event
    await supabase.from("chats").delete().eq("event_id", eventId);
    // 6) :wastebasket: Delete participants
    await supabase.from("participants").delete().eq("event_id", eventId);

    // 6.1) 🔍 Get ElevenLabs agent ID for this event
    const { data: eventData, error: eventErr } = await supabase
      .from("events")
      .select("elevenlabs_agent_id")
      .eq("event_id", eventId)
      .single();

    if (eventErr) {
      console.warn("⚠️ Could not fetch event agent:", eventErr.message);
    }

    // 6.2) 🤖 Delete ElevenLabs agent (if exists)
    if (eventData?.elevenlabs_agent_id) {
      try {
        await deleteAgent(eventData.elevenlabs_agent_id);
        console.log(
          `🗑️ ElevenLabs agent deleted: ${eventData.elevenlabs_agent_id}`
        );
      } catch (agentErr) {
        console.warn(
          "⚠️ Failed to delete ElevenLabs agent:",
          agentErr.response?.data || agentErr.message
        );
        // DO NOT throw — event deletion must continue
      }
    }

    // 7) :wastebasket: Delete the event itself
    await supabase.from("events").delete().eq("event_id", eventId);
    return res.status(200).json({ message: "Event deleted successfully" });
  } catch (error) {
    console.error("Delete event error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
