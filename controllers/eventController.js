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

// ✅ NEW: Credit system imports
import {
  CREDIT_PRICING,
  calculateVoiceCredits,
  formatCredits,
} from "../config/creditPricing.js";
import { getUserById, updateUserCredits } from "../models/userModel.js";

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
    wedding: process.env.ELEVENLABS_AGENT_ID,
  };

  try {
    const { user_id, event_name, event_date, agent_id } = req.body;
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

    if (!agent_id) {
      return res.status(400).json({
        error: "agent_id are required",
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
    };
    const event = await createEvent(eventPayload);

    //Fetch agent
    const { data: ag, error: agError } = await supabase
      .from("agents")
      .select("*")
      .eq("agent_id", agent_id)
      .single();

    if (agError || !ag) {
      return res.status(400).json({ error: "Invalid Agent ID" });
    }

    //Fetch agent_template
    let eventType = null;

    if (ag.field_mode === "classic") {
      const { data: template, error: templateError } = await supabase
        .from("agent_templates")
        .select("*")
        .eq("template_id", ag.template_id)
        .single();

      if (templateError || !template) {
        return res.status(400).json({ error: "No Agent Template Found" });
      }

      // Use template category as event type if available
      if (template.category) {
        eventType = template.category;
      }
    }

    // Fetch KB from DB (optional for smart_fields agents)
    let kb = null;
    if (ag.knowledge_base_id) {
      const { data: kbData, error: kbError } = await supabase
        .from("knowledge_bases")
        .select("*")
        .eq("id", ag.knowledge_base_id)
        .single();

      if (kbError || !kbData) {
        return res.status(400).json({ error: "Invalid knowledge base" });
      }
      kb = kbData;
    }

    //F) Update event row
    await supabase
      .from("events")
      .update({
        elevenlabs_agent_id: ag.elevenlabs_agent_id,
        knowledge_base_id: ag.knowledge_base_id || null,
        agent_id: ag.agent_id,
        event_type: eventType,
        elevenlabs_kb_id: kb?.elevenlabs_kb_id || null,
        field_mode: ag.field_mode || "classic",
      })
      .eq("event_id", event.event_id);

    // G) If smart_fields agent, copy field definitions into event_smart_fields
    if (
      ag.field_mode === "smart_fields" &&
      Array.isArray(ag.smart_fields) &&
      ag.smart_fields.length > 0
    ) {
      const smartFieldRows = ag.smart_fields.map((f) => ({
        event_id: event.event_id,
        field_key: f.field_key,
        field_label: f.field_label,
        field_type: f.field_type,
        ai_question: f.ai_question,
        options: f.options || [],
        condition: f.condition || null,
        is_required: f.is_required !== undefined ? f.is_required : true,
        display_order: f.display_order || 0,
      }));

      const { error: sfError } = await supabase
        .from("event_smart_fields")
        .insert(smartFieldRows);

      if (sfError) {
        console.error("Warning: failed to insert smart fields:", sfError);
      }
    }

    //update agents status
    await supabase
      .from("agents")
      .update({
        status: "assigned",
      })
      .eq("agent_id", ag.agent_id);

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
        "participant_id, status, proof_uploaded, document_url, created_at",
      )
      .in("participant_id", participantIds);

    if (cError) throw cError;

    // 3️⃣ Merge participants + conversations
    const rsvpData = participants.map((p) => {
      const convo = conversations.find(
        (c) => c.participant_id === p.participant_id,
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

    // Fetch event to determine field_mode
    const { data: eventData, error: eventErr } = await supabase
      .from("events")
      .select("field_mode")
      .eq("event_id", eventId)
      .single();

    if (eventErr) return res.status(400).json({ error: eventErr.message });

    // Get Participants
    const { data: participants, error: pError } = await supabase
      .from("participants")
      .select("*")
      .eq("event_id", eventId);

    if (pError) return res.status(400).json({ error: pError });
    if (!participants.length) return res.json([]);

    // --- SMART FIELDS mode ---
    if (eventData?.field_mode === "smart_fields") {
      const [{ data: smartFields }, { data: responses }] = await Promise.all([
        supabase
          .from("event_smart_fields")
          .select("*")
          .eq("event_id", eventId)
          .order("display_order", { ascending: true }),
        supabase
          .from("event_rsvp_responses")
          .select("*")
          .eq("event_id", eventId),
      ]);

      // Group responses by participant_id
      const byParticipant = {};
      (responses || []).forEach((r) => {
        if (!byParticipant[r.participant_id])
          byParticipant[r.participant_id] = {};
        byParticipant[r.participant_id][r.field_key] = r.response_value;
      });

      const data = participants.map((p) => {
        const participantResponses = byParticipant[p.participant_id] || {};
        const row = {
          id: p.participant_id,
          fullName: p.full_name,
          phoneNumber: p.phone_number,
          timestamp: p.uploaded_at,
        };
        (smartFields || []).forEach((f) => {
          row[f.field_key] = participantResponses[f.field_key] ?? null;
        });
        return row;
      });

      return res.json({
        field_mode: "smart_fields",
        fields: smartFields || [],
        data,
      });
    }

    // --- CLASSIC mode (existing behavior) ---
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
          eventName: p.event_id,
        };
      }),
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

    if (eventError || !eventData) {
      console.error("Event not found:", eventError);
      return res.status(404).json({ error: "Event not found" });
    }

    console.log("✅ Event found:", eventData.event_name);

    const user_id = eventData.user_id; // ✅ Get user_id from event

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

    // ✅ ============================================
    // ✅ CHECK CREDITS BEFORE STARTING BATCH
    // ✅ ============================================
    console.log("💰 Checking production batch call credits for user:", user_id);

    const user = await getUserById(user_id);

    if (!user) {
      console.error("❌ User not found:", user_id);
      return res.status(404).json({ error: "User not found" });
    }

    // Estimate credits needed (assume 3 minutes average per call)
    const ESTIMATED_MINUTES_PER_CALL = 3;
    const totalEstimatedMinutes =
      participants.length * ESTIMATED_MINUTES_PER_CALL;
    const estimatedCredits =
      totalEstimatedMinutes * CREDIT_PRICING.BATCH_CALL_PER_MINUTE;

    console.log(`📊 Batch credit estimation:`);
    console.log(`   - Participants: ${participants.length}`);
    console.log(
      `   - Estimated minutes: ${totalEstimatedMinutes} (${ESTIMATED_MINUTES_PER_CALL} min/call)`,
    );
    console.log(`   - Estimated credits: ${estimatedCredits}`);
    console.log(`   - User balance: ${user.credits}`);

    if (user.credits < estimatedCredits) {
      console.log(
        `❌ Insufficient credits: ${user.credits} < ${estimatedCredits}`,
      );

      return res.status(402).json({
        error: "Insufficient credits to start batch call",
        current_balance: formatCredits(user.credits),
        estimated_credits: formatCredits(estimatedCredits),
        shortfall: formatCredits(estimatedCredits - user.credits),
        participants_count: participants.length,
        estimated_minutes: totalEstimatedMinutes,
        note: "Credits will be deducted based on actual call duration after calls complete",
      });
    }

    console.log(
      `✅ Credit check passed: ${user.credits} >= ${estimatedCredits}`,
    );
    // ✅ ============================================

    // 3️⃣ Fetch agent row once — need first_message and elevenlabs_agent_id for recipients
    const { data: agentData, error: agentError } = await supabase
      .from("agents")
      .select("elevenlabs_agent_id, first_message")
      .eq("agent_id", eventData.agent_id)
      .single();

    if (agentError || !agentData?.elevenlabs_agent_id) {
      console.error("❌ ElevenLabs agent missing");
      return res.status(400).json({
        error: "ElevenLabs agent not configured properly",
      });
    }

    const elevenAgentId = agentData.elevenlabs_agent_id;
    const agentFirstMessage = agentData.first_message || null;

    // 4️⃣ Prepare recipients with proper phone number format
    const isSmartFields = eventData.field_mode === "smart_fields";

    // For smart_fields: fetch field definitions once and build the question block
    // that tells the AI exactly what to ask and which field_key to map each answer to.
    let smart_fields_block = "";
    if (isSmartFields) {
      const { data: smartFields } = await supabase
        .from("event_smart_fields")
        .select(
          "field_key, field_label, field_type, ai_question, options, display_order",
        )
        .eq("event_id", eventId)
        .order("display_order", { ascending: true });

      if (smartFields && smartFields.length > 0) {
        smart_fields_block = smartFields
          .map((f, i) => {
            let typeLine = `Type: ${f.field_type}`;
            if (
              f.field_type === "choice" &&
              Array.isArray(f.options) &&
              f.options.length
            ) {
              typeLine += ` | Options: ${f.options.join(", ")}`;
            }
            return (
              `${i + 1}. Ask: "${f.ai_question}"\n` +
              `   field_key: ${f.field_key}\n` +
              `   ${typeLine}`
            );
          })
          .join("\n\n");
      }
    }

    const recipients = participants.map((p) => {
      let formattedPhone = String(p.phone_number || "").trim();

      if (formattedPhone && !formattedPhone.startsWith("+")) {
        formattedPhone = "+" + formattedPhone;
      }

      console.log(`📱 Participant ${p.participant_id} phone:`, formattedPhone);

      // Smart fields: pass event_id + participant_id (snake_case) so the
      // ElevenLabs tool can include them in the POST body to /api/events/rsvp-responses.
      // Classic: keep original camelCase variables used by the fixed agent prompt.
      const dynamic_variables = isSmartFields
        ? {
            event_id: String(eventId),
            event_name: String(eventData.event_name),
            participant_id: String(p.participant_id),
            guest_name: String(p.full_name),
            knowledge_base_id: String(eventData.knowledge_base_id),
            smart_fields_block,
          }
        : {
            eventId: String(eventId),
            eventName: String(eventData.event_name),
          };

      const recipient = {
        id: String(p.participant_id),
        conversation_initiation_client_data: {
          conversation_config_override: {
            agent: {
              prompt: null,
              first_message: agentFirstMessage,
              language: null,
            },
            tts: {
              voice_id: null,
            },
          },
          dynamic_variables,
        },
        phone_number: formattedPhone,
      };

      return recipient;
    });

    console.log("📞 First recipient structure:");
    console.log(JSON.stringify(recipients[0], null, 2));

    const scheduledUnix = Math.floor(Date.now() / 1000) + 60;
    console.log(
      "⏰ Scheduled for:",
      new Date(scheduledUnix * 1000).toISOString(),
    );

    console.log("🤖 Using ElevenLabs Agent:", elevenAgentId);

    const payload = {
      call_name: `event-${eventId}-${Date.now()}`,
      agent_id: elevenAgentId,
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
      },
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

    // 5️⃣ Update event with batch_id + status + user_id (for credit tracking)
    // ✅ RESET credit tracking for NEW batch
    const { error: updateError } = await supabase
      .from("events")
      .update({
        batch_id: data.id,
        batch_status: data.status || "queued",
        batch_created_at: new Date().toISOString(),
        user_id: user_id,
        credits_deducted: null, // ✅ RESET - allow new batch to be tracked
        total_call_duration: null, // ✅ RESET
        successful_calls: null, // ✅ RESET
      })
      .eq("event_id", eventId);

    if (updateError) {
      console.error("⚠️ Error updating event with batch_id:", updateError);
    } else {
      console.log("✅ Event updated with batch_id");
    }

    // 6️⃣ Create placeholder conversation_results for each participant if missing
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
            insertError,
          );
        } else {
          console.log(
            `✅ Placeholder created for participant ${participant.participant_id}`,
          );
        }
      } else {
        console.log(
          `ℹ️ Conversation result already exists for participant ${participant.participant_id}`,
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
      credit_info: {
        estimated_credits: formatCredits(estimatedCredits),
        current_balance: formatCredits(user.credits),
        note: "Actual credits will be deducted after calls complete based on real duration",
      },
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

/* ============================================
   🔥 RETRY BATCH CALL - WITH CREDITS
   ============================================ */
export const retryBatchCall = async (req, res) => {
  try {
    const { eventId } = req.params;

    // 1️⃣ Fetch event data
    const { data: eventData, error: eventError } = await supabase
      .from("events")
      .select("*")
      .eq("event_id", eventId)
      .single();

    if (eventError || !eventData) {
      return res.status(404).json({ error: "Event not found" });
    }

    if (!eventData.batch_id) {
      return res.status(400).json({ error: "No batch found for this event" });
    }

    const user_id = eventData.user_id;

    // ✅ ============================================
    // ✅ CHECK CREDITS BEFORE RETRY
    // ✅ ============================================
    console.log("💰 Checking credits for batch retry, user:", user_id);

    // Fetch batch details to count failed/pending calls
    const batchResponse = await fetch(
      `https://api.elevenlabs.io/v1/convai/batch-calling/${eventData.batch_id}`,
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
      },
    );

    const batchData = await batchResponse.json();

    // Count failed/pending calls that will be retried
    const failedCount = (batchData.recipients || []).filter(
      (r) =>
        r.status === "failed" || r.status === "error" || r.status === "pending",
    ).length;

    console.log(`📊 Retry estimation: ${failedCount} calls to retry`);

    if (failedCount === 0) {
      return res.status(400).json({
        error: "No failed calls to retry",
        batch_status: batchData.status,
      });
    }

    const user = await getUserById(user_id);

    if (!user) {
      console.error("❌ User not found:", user_id);
      return res.status(404).json({ error: "User not found" });
    }

    // Estimate credits needed (assume 3 minutes average per retry call)
    const ESTIMATED_MINUTES_PER_CALL = 3;
    const totalEstimatedMinutes = failedCount * ESTIMATED_MINUTES_PER_CALL;
    const estimatedCredits =
      totalEstimatedMinutes * CREDIT_PRICING.BATCH_CALL_PER_MINUTE;

    console.log(`📊 Retry credit estimation:`);
    console.log(`   - Failed calls: ${failedCount}`);
    console.log(`   - Estimated minutes: ${totalEstimatedMinutes}`);
    console.log(`   - Estimated credits: ${estimatedCredits}`);
    console.log(`   - User balance: ${user.credits}`);

    if (user.credits < estimatedCredits) {
      console.log(
        `❌ Insufficient credits: ${user.credits} < ${estimatedCredits}`,
      );

      return res.status(402).json({
        error: "Insufficient credits to retry batch call",
        current_balance: formatCredits(user.credits),
        estimated_credits: formatCredits(estimatedCredits),
        shortfall: formatCredits(estimatedCredits - user.credits),
        failed_calls_count: failedCount,
        note: "Credits will be deducted based on actual call duration after retry completes",
      });
    }

    console.log(
      `✅ Credit check passed: ${user.credits} >= ${estimatedCredits}`,
    );
    // ✅ ============================================

    // 2️⃣ Call ElevenLabs Retry API
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/batch-calling/${eventData.batch_id}/retry`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
      },
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
    // ✅ RESET credit tracking for retry
    await supabase
      .from("events")
      .update({
        batch_id: data.id || eventData.batch_id,
        batch_status: data.status || "retrying",
        batch_created_at: new Date().toISOString(),
        credits_deducted: null, // ✅ RESET - allow retry to be tracked
        total_call_duration: null, // ✅ RESET
        successful_calls: null, // ✅ RESET
      })
      .eq("event_id", eventId);

    return res.status(200).json({
      message: "✅ Retry batch call started successfully",
      batch: data,
      failed_calls_count: failedCount,
      credit_info: {
        estimated_credits: formatCredits(estimatedCredits),
        current_balance: formatCredits(user.credits),
        note: "Actual credits will be deducted after retry completes",
      },
    });
  } catch (err) {
    console.error("retryBatchCall error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

export const syncBatchStatuses = async (req, res) => {
  try {
    const { eventId } = req.params;

    // 1. Fetch event — need batch_id and field_mode
    const { data: eventData, error: eventError } = await supabase
      .from("events")
      .select("batch_id, field_mode")
      .eq("event_id", eventId)
      .single();

    if (eventError || !eventData?.batch_id) {
      return res.status(404).json({ error: "Batch not found for this event" });
    }

    const { batch_id: batchId, field_mode } = eventData;
    const isSmartFields = field_mode === "smart_fields";

    // 2. Fetch ElevenLabs batch details
    const elevenResponse = await fetch(
      `https://api.elevenlabs.io/v1/convai/batch-calling/${batchId}`,
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
      },
    );

    const batchData = await elevenResponse.json();

    if (!elevenResponse.ok) {
      console.error("ElevenLabs API error:", batchData);
      return res
        .status(500)
        .json({ error: "Failed to fetch batch details", details: batchData });
    }

    const recipients = batchData.recipients || [];
    if (recipients.length === 0)
      return res.status(400).json({ error: "No recipients found in batch" });

    let updatedCount = 0;

    // ─── SMART FIELDS MODE ───────────────────────────────────────────────────
    if (isSmartFields) {
      const { data: existingLogs } = await supabase
        .from("event_call_logs")
        .select("call_log_id, participant_id")
        .eq("event_id", eventId);

      const logByParticipant = {};
      (existingLogs || []).forEach((log) => {
        logByParticipant[log.participant_id] = log.call_log_id;
      });

      for (const recipient of recipients) {
        const participantId =
          recipient.conversation_initiation_client_data?.dynamic_variables
            ?.participant_id;

        if (!participantId) continue;

        const existingLogId = logByParticipant[participantId];

        if (existingLogId) {
          const { error: updateError } = await supabase
            .from("event_call_logs")
            .update({
              recipient_status: recipient.status,
              conversation_id: recipient.conversation_id || null,
              updated_at: new Date().toISOString(),
            })
            .eq("call_log_id", existingLogId);

          if (!updateError) updatedCount++;
        } else {
          const { error: insertError } = await supabase
            .from("event_call_logs")
            .insert({
              event_id: eventId,
              participant_id: participantId,
              recipient_status: recipient.status,
              conversation_id: recipient.conversation_id || null,
              call_outcome: "pending",
            });

          if (!insertError) updatedCount++;
        }
      }
    } else {
      // ─── CLASSIC MODE ────────────────────────────────────────────────────
      const { data: participants, error: partError } = await supabase
        .from("participants")
        .select("participant_id, phone_number")
        .eq("event_id", eventId);

      if (partError) throw partError;

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

      for (const recipient of recipients) {
        const participant = participants.find(
          (p) => p.phone_number === recipient.phone_number,
        );

        if (!participant) continue;

        const { data: existing } = await supabase
          .from("conversation_results")
          .select("call_status")
          .eq("participant_id", participant.participant_id)
          .maybeSingle();

        if (protectedStatuses.includes(existing?.call_status)) continue;

        const { error: updateError } = await supabase
          .from("conversation_results")
          .update({ call_status: recipient.status })
          .eq("participant_id", participant.participant_id);

        if (!updateError) updatedCount++;
      }
    }

    // 4. Update events — batch_status + call counts (both modes)
    await supabase
      .from("events")
      .update({
        batch_status: batchData.status,
        total_calls_dispatched: batchData.total_calls_dispatched ?? 0,
        total_calls_finished: batchData.total_calls_finished ?? 0,
      })
      .eq("event_id", eventId);

    return res.status(200).json({
      message: "Batch call statuses synced successfully",
      field_mode,
      updated: updatedCount,
      total: recipients.length,
      batch_status: batchData.status,
      total_calls_dispatched: batchData.total_calls_dispatched,
      total_calls_finished: batchData.total_calls_finished,
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
      },
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
      // Delete smart RSVP responses linked to participants
      await supabase
        .from("event_rsvp_responses")
        .delete()
        .in("participant_id", participantIds);
    }

    // Delete smart field definitions for the event
    await supabase.from("event_smart_fields").delete().eq("event_id", eventId);
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

    // // 6.1) 🔍 Get ElevenLabs agent ID for this event
    // const { data: eventData, error: eventErr } = await supabase
    //   .from("events")
    //   .select("elevenlabs_agent_id")
    //   .eq("event_id", eventId)
    //   .single();

    // if (eventErr) {
    //   console.warn("⚠️ Could not fetch event agent:", eventErr.message);
    // }

    // // 6.2) 🤖 Delete ElevenLabs agent (if exists)
    // if (eventData?.elevenlabs_agent_id) {
    //   try {
    //     await deleteAgent(eventData.elevenlabs_agent_id);
    //     console.log(
    //       `🗑️ ElevenLabs agent deleted: ${eventData.elevenlabs_agent_id}`,
    //     );
    //   } catch (agentErr) {
    //     console.warn(
    //       "⚠️ Failed to delete ElevenLabs agent:",
    //       agentErr.response?.data || agentErr.message,
    //     );
    //     // DO NOT throw — event deletion must continue
    //   }
    // }

    // 7) :wastebasket: Delete the event itself
    await supabase.from("events").delete().eq("event_id", eventId);
    return res.status(200).json({ message: "Event deleted successfully" });
  } catch (error) {
    console.error("Delete event error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
