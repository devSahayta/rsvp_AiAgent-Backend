/**
 * assistantEventController.js
 *
 * Step 1 — POST /api/events/assistant-create
 *   Internal server-to-server call from toolExecutor.js
 *   Creates the event row with agent details resolved.
 *   No Kinde JWT — reads user_id from req.body.
 *
 * Step 2 — POST /api/events/:eventId/upload-csv
 *   Called from the frontend EventCreatedCard "Upload now" button.
 *   Uses IDENTICAL logic to createEventWithCsv:
 *     - @fast-csv/parse for robust CSV parsing
 *     - Same findColumn() column detection
 *     - Same bulkInsertParticipants model function
 *     - Same Supabase Storage bucket (event-csvs) and key pattern
 *     - Same event_smart_fields copy for smart_fields agents
 *
 * Add to eventRoutes.js (before /:eventId param routes):
 *   import { assistantCreateEvent, assistantUploadCsv } from "../controllers/assistantEventController.js";
 *   router.post("/assistant-create", assistantCreateEvent);
 *   router.post("/:eventId/upload-csv", authenticateUser, upload.single("dataset"), assistantUploadCsv);
 */

import { Readable } from "stream";
import { parse } from "@fast-csv/parse";
import { supabase } from "../config/supabase.js";
import { bulkInsertParticipants } from "../models/eventModel.js";

// ── Identical to createEventWithCsv — find column by multiple aliases ─────────
const findColumn = (headers, candidates) => {
  const lower = headers.map((h) => h.toLowerCase());
  for (const c of candidates) {
    const i = lower.indexOf(c.toLowerCase());
    if (i !== -1) return headers[i];
  }
  return null;
};

// ── Slug helper for storage key (same as createEventWithCsv) ─────────────────
const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 60);

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — Create event row (server-to-server, no Kinde JWT needed)
// ─────────────────────────────────────────────────────────────────────────────
export async function assistantCreateEvent(req, res) {
  try {
    const { event_name, event_date, event_type, agent_id, user_id } = req.body;
    const userId = user_id;

    console.log("[assistantCreateEvent] Body received:", req.body);

    if (!userId)
      return res
        .status(400)
        .json({ success: false, error: "user_id is required" });
    if (!event_name)
      return res
        .status(400)
        .json({ success: false, error: "event_name is required" });
    if (!event_date)
      return res
        .status(400)
        .json({ success: false, error: "event_date is required" });

    const parsedDate = new Date(event_date);
    if (isNaN(parsedDate.getTime())) {
      return res
        .status(400)
        .json({ success: false, error: `Invalid date: ${event_date}` });
    }

    // Resolve agent details — same approach as createEventWithCsv
    let resolvedAgentId = null;
    let elevenlabsAgentId = null;
    let knowledgeBaseId = null;
    let elevenlabsKbId = null;
    let fieldMode = null;
    let eventType = event_type || null;

    if (agent_id) {
      const { data: ag, error: agErr } = await supabase
        .from("agents")
        .select(
          "agent_id, elevenlabs_agent_id, knowledge_base_id, field_mode, template_id, smart_fields",
        )
        .eq("agent_id", agent_id)
        .eq("user_id", userId)
        .maybeSingle();

      if (agErr)
        console.warn(
          "[assistantCreateEvent] Agent fetch warning:",
          agErr.message,
        );

      if (ag) {
        resolvedAgentId = ag.agent_id;
        elevenlabsAgentId = ag.elevenlabs_agent_id;
        knowledgeBaseId = ag.knowledge_base_id;
        fieldMode = ag.field_mode;

        // Fetch KB elevenlabs_kb_id if KB exists
        if (ag.knowledge_base_id) {
          const { data: kb } = await supabase
            .from("knowledge_bases")
            .select("elevenlabs_kb_id")
            .eq("id", ag.knowledge_base_id)
            .maybeSingle();
          elevenlabsKbId = kb?.elevenlabs_kb_id || null;
        }

        // Fetch event type from template if classic mode
        if (ag.field_mode === "classic" && ag.template_id) {
          const { data: template } = await supabase
            .from("agent_templates")
            .select("category")
            .eq("template_id", ag.template_id)
            .maybeSingle();
          if (template?.category) eventType = template.category;
        }
      }
    }

    // Insert event row — same columns as createEventWithCsv
    const { data: event, error: evErr } = await supabase
      .from("events")
      .insert([
        {
          user_id: userId,
          event_name,
          event_date: parsedDate.toISOString(),
          event_type: eventType,
          status: "Upcoming",
          agent_id: resolvedAgentId,
          elevenlabs_agent_id: elevenlabsAgentId,
          knowledge_base_id: knowledgeBaseId,
          elevenlabs_kb_id: elevenlabsKbId,
          field_mode: fieldMode || "classic",
          batch_status: "pending",
        },
      ])
      .select("event_id, event_name, event_date, status, agent_id, field_mode")
      .single();

    if (evErr) {
      console.error("[assistantCreateEvent] DB insert error:", evErr);
      return res.status(500).json({ success: false, error: evErr.message });
    }

    // Copy smart_fields into event_smart_fields (same as createEventWithCsv)
    if (resolvedAgentId && fieldMode === "smart_fields") {
      const { data: ag } = await supabase
        .from("agents")
        .select("smart_fields")
        .eq("agent_id", resolvedAgentId)
        .maybeSingle();

      if (
        ag?.smart_fields &&
        Array.isArray(ag.smart_fields) &&
        ag.smart_fields.length > 0
      ) {
        const sfRows = ag.smart_fields.map((f) => ({
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

        const { error: sfErr } = await supabase
          .from("event_smart_fields")
          .insert(sfRows);
        if (sfErr)
          console.warn(
            "[assistantCreateEvent] Smart fields insert warning:",
            sfErr.message,
          );
        else
          console.log(
            `[assistantCreateEvent] Inserted ${sfRows.length} smart fields`,
          );
      }
    }

    // Mark agent as assigned
    if (resolvedAgentId) {
      await supabase
        .from("agents")
        .update({ status: "assigned" })
        .eq("agent_id", resolvedAgentId);
    }

    console.log(
      `[assistantCreateEvent] Created event ${event.event_id} — "${event_name}"`,
    );
    return res.status(201).json({ success: true, data: event });
  } catch (err) {
    console.error("[assistantCreateEvent] Unexpected error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — Upload CSV and insert participants
// Uses IDENTICAL logic to createEventWithCsv:
//   - @fast-csv/parse stream parser
//   - findColumn() for column detection
//   - bulkInsertParticipants model
//   - Supabase Storage bucket "event-csvs"
// ─────────────────────────────────────────────────────────────────────────────
export async function assistantUploadCsv(req, res) {
  try {
    const userId = req.user?.user_id || req.body?.user_id;
    const { eventId } = req.params;

    console.log("[assistantUploadCsv] userId:", userId, "eventId:", eventId);
    console.log(
      "[assistantUploadCsv] file:",
      req.file?.originalname,
      "size:",
      req.file?.size,
    );

    if (!userId)
      return res.status(401).json({ success: false, error: "Unauthorized" });
    if (!req.file)
      return res
        .status(400)
        .json({
          success: false,
          error: "No file uploaded. Attach a CSV file.",
        });

    // Verify event belongs to user
    const { data: event, error: evErr } = await supabase
      .from("events")
      .select("event_id, event_name, user_id")
      .eq("event_id", eventId)
      .eq("user_id", userId)
      .maybeSingle();

    if (evErr || !event) {
      console.error("[assistantUploadCsv] Event not found:", evErr?.message);
      return res
        .status(404)
        .json({ success: false, error: "Event not found or access denied" });
    }

    const { buffer, originalname, mimetype } = req.file;

    // ── 1. Upload CSV to Supabase Storage (IDENTICAL to createEventWithCsv) ─
    const key = `${userId}/${Date.now()}_${slug(event.event_name)}.csv`;

    console.log("[assistantUploadCsv] Uploading to storage key:", key);

    const { error: storageErr } = await supabase.storage
      .from("event-csvs")
      .upload(key, buffer, {
        contentType: mimetype || "text/csv",
        upsert: false,
      });

    if (storageErr) {
      console.error(
        "[assistantUploadCsv] Storage upload error:",
        storageErr.message,
      );
      return res
        .status(500)
        .json({
          success: false,
          error: `Storage upload failed: ${storageErr.message}`,
        });
    }

    const { data: publicUrlData } = supabase.storage
      .from("event-csvs")
      .getPublicUrl(key);
    const uploaded_csv = publicUrlData?.publicUrl || null;

    console.log("[assistantUploadCsv] Storage URL:", uploaded_csv);

    // ── 2. Update event with CSV URL immediately ──────────────────────────────
    await supabase
      .from("events")
      .update({ uploaded_csv })
      .eq("event_id", eventId);

    // ── 3. Parse CSV with @fast-csv/parse (IDENTICAL to createEventWithCsv) ──
    const rows = [];
    const headers = [];

    await new Promise((resolve, reject) => {
      const stream = Readable.from(buffer);
      stream
        .pipe(parse({ headers: true, ignoreEmpty: true, trim: true }))
        .on("headers", (h) => headers.push(...h))
        .on("error", reject)
        .on("data", (row) => rows.push(row))
        .on("end", resolve);
    });

    console.log("[assistantUploadCsv] CSV headers detected:", headers);
    console.log("[assistantUploadCsv] Rows parsed:", rows.length);

    if (rows.length === 0) {
      return res.status(200).json({
        success: true,
        participants_added: 0,
        csv_url: uploaded_csv,
        message: "CSV uploaded but contained no data rows.",
      });
    }

    // ── 4. Resolve columns (IDENTICAL findColumn logic from createEventWithCsv)
    const nameCol = findColumn(headers, ["name", "full_name", "fullname"]);
    const phoneCol = findColumn(headers, [
      "phoneno",
      "phone",
      "phone_number",
      "mobile",
    ]);
    const emailCol = findColumn(headers, ["email", "email_address"]);

    console.log(
      "[assistantUploadCsv] Resolved columns — name:",
      nameCol,
      "phone:",
      phoneCol,
      "email:",
      emailCol,
    );

    if (!nameCol || !phoneCol) {
      return res.status(400).json({
        success: false,
        error: `CSV must have Name and Phone columns. Found headers: [${headers.join(", ")}]. Expected: name/full_name and phoneno/phone/phone_number/mobile`,
      });
    }

    // ── 5. Build participant records (IDENTICAL to createEventWithCsv) ────────
    const participants = [];
    for (const r of rows) {
      const full_name = (r[nameCol] || "").toString().trim();
      const phone_number = (r[phoneCol] || "").toString().trim();
      const email = emailCol ? (r[emailCol] || "").toString().trim() : null;

      if (!full_name || !phone_number) continue;

      participants.push({
        event_id: eventId,
        user_id: userId,
        full_name,
        phone_number,
        email: email || null,
      });
    }

    console.log(
      "[assistantUploadCsv] Valid participants to insert:",
      participants.length,
    );

    if (participants.length === 0) {
      return res.status(400).json({
        success: false,
        error:
          "No valid participants found. Each row must have both Name and Phone.",
      });
    }

    // ── 6. Insert via bulkInsertParticipants (IDENTICAL to createEventWithCsv)
    const inserted = await bulkInsertParticipants(participants);

    console.log(
      "[assistantUploadCsv] Inserted:",
      inserted.length,
      "participants for event",
      eventId,
    );

    return res.status(200).json({
      success: true,
      participants_added: inserted.length,
      csv_url: uploaded_csv,
      message: `${inserted.length} participants added successfully.`,
    });
  } catch (err) {
    console.error("[assistantUploadCsv] Unexpected error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
