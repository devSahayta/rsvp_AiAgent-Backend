// controllers/uploadController.js
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper: check ownership
const verifyParticipantOwnership = async (participantId, currentUserId) => {
  if (!participantId || !currentUserId) return false;

  const { data, error } = await supabase
    .from("participants")
    .select("participant_id, event_id, user_id")
    .eq("participant_id", participantId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("verifyParticipantOwnership supabase error:", error);
    return false;
  }
  if (!data) return false;
  return data.user_id === currentUserId;
};

// Submit upload (same as your code)
export const submitUpload = async (req, res) => {
  try {
    const { participant_id } = req.body;
    if (!participant_id) return res.status(400).json({ error: "participant_id is required" });

    // Ownership check
    if (req.user && req.user.user_id) {
      const ok = await verifyParticipantOwnership(participant_id, req.user.user_id);
      if (!ok) return res.status(403).json({ error: "Not authorized to upload for this participant" });
    }

    // Bulk or single logic (kept same as yours)
    if (req.body.members) {
      const members = JSON.parse(req.body.members);
      const files = req.files || [];

      if (!members || members.length === 0) {
        return res.status(400).json({ error: "No members provided" });
      }
      if (!files || files.length !== members.length) {
        return res.status(400).json({
          error: `Files count (${files?.length || 0}) must match members count (${members.length})`
        });
      }

      const results = [];

      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        const file = files[i];

        const filePath = `primary/${Date.now()}_${file.originalname}`;

        const { error: uploadError } = await supabase.storage
          .from("participant-docs")
          .upload(filePath, file.buffer, {
            upsert: true,
            contentType: file.mimetype || "application/octet-stream",
          });

        if (uploadError) {
          console.error("Supabase upload error (bulk):", uploadError);
          throw uploadError;
        }

        const documentPath = filePath;

        const { data, error } = await supabase
          .from("uploads")
          .insert({
            participant_id,
            participant_relatives_name: member.full_name,
            document_url: documentPath,
            document_type: member.document_type,
            role: member.role,
            proof_uploaded: true,
          })
          .select()
          .single();

        if (error) {
          console.error("Database insert error (bulk):", error);
          throw error;
        }

        results.push(data);
      }

      return res.status(201).json({ message: "Bulk upload successful", uploads: results });
    }

    // Single
    const file = req.files?.find((f) => f.fieldname === "file") || req.files?.[0];
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const { full_name, role, document_type } = req.body;
    const filePath = `primary/${Date.now()}_${file.originalname}`;

    const { error: uploadError } = await supabase.storage
      .from("participant-docs")
      .upload(filePath, file.buffer, {
        upsert: true,
        contentType: file.mimetype || "application/octet-stream",
      });

    if (uploadError) {
      console.error("Supabase upload error (single):", uploadError);
      throw uploadError;
    }

    const documentPath = filePath;

    const { data, error } = await supabase
      .from("uploads")
      .insert({
        participant_id,
        participant_relatives_name: full_name,
        document_url: documentPath,
        document_type,
        role,
        proof_uploaded: true,
      })
      .select()
      .single();

    if (error) {
      console.error("Database insert error (single):", error);
      throw error;
    }

    return res.status(201).json({ message: "Upload saved successfully", upload: data });
  } catch (err) {
    console.error("submitUpload error:", err);
    return res.status(500).json({ error: "Failed to save upload", details: err.message || err });
  }
};

// GET /api/uploads/:participant_id
export const getUploadsByParticipant = async (req, res) => {
  try {
    const { participant_id } = req.params;
    if (!participant_id) return res.status(400).json({ error: "participant_id is required" });

    // Ownership check
    if (req.user && req.user.user_id) {
      const ok = await verifyParticipantOwnership(participant_id, req.user.user_id);
      if (!ok) return res.status(403).json({ error: "Not authorized to view uploads for this participant" });
    }

    const { data, error } = await supabase
      .from("uploads")
      .select("*")
      .eq("participant_id", participant_id)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("getUploadsByParticipant supabase error:", error);
      throw error;
    }

    return res.status(200).json({ message: "Uploads fetched successfully", count: data.length, uploads: data });
  } catch (err) {
    console.error("getUploadsByParticipant error:", err);
    return res.status(500).json({ error: "Failed to fetch uploads", details: err.message || err });
  }
};

export const updateUpload = async (req, res) => {
  try {
    const { uploadId } = req.params;
    const { full_name, document_type } = req.body;
    const file = req.file;

    if (!uploadId) return res.status(400).json({ error: "uploadId is required" });

    const { data: existing, error: fetchErr } = await supabase
      .from("uploads")
      .select("participant_id")
      .eq("upload_id", uploadId)
      .limit(1)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ error: "Upload not found" });

    if (req.user && req.user.user_id) {
      const ok = await verifyParticipantOwnership(existing.participant_id, req.user.user_id);
      if (!ok) return res.status(403).json({ error: "Not authorized to edit this upload" });
    }

    const updateData = {
      participant_relatives_name: full_name,
      document_type,
      created_at: new Date().toISOString(),
    };

    if (file) {
      const fileName = `${uploadId}-${Date.now()}_${file.originalname}`;
      const { error: uploadError } = await supabase.storage
        .from("participant-docs")
        .upload(fileName, file.buffer, {
          upsert: true,
          contentType: file.mimetype || "application/octet-stream",
        });

      if (uploadError) throw uploadError;
      updateData.document_url = fileName;
    }

    const { error } = await supabase
      .from("uploads")
      .update(updateData)
      .eq("upload_id", uploadId);

    if (error) throw error;

    res.status(200).json({ message: "Document updated successfully" });
  } catch (err) {
    console.error("updateUpload error:", err);
    return res.status(500).json({ error: "Failed to update document", details: err.message || err });
  }
};

export const getConversationByParticipant = async (req, res) => {
  try {
    const { participantId } = req.params;
    if (!participantId) return res.status(400).json({ error: "participantId is required" });

    if (req.user && req.user.user_id) {
      const ok = await verifyParticipantOwnership(participantId, req.user.user_id);
      if (!ok) return res.status(403).json({ error: "Not authorized to view this conversation" });
    }

    const { data, error } = await supabase
      .from("conversation_results")
      .select("rsvp_status, number_of_guests, notes")
      .eq("participant_id", participantId)
      .single();

    if (error || !data) {
      console.error("getConversationByParticipant fetch error:", error);
      return res.status(404).json({ message: "Conversation not found" });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("getConversationByParticipant error:", err);
    return res.status(500).json({ error: "Failed to fetch conversation", details: err.message || err });
  }
};

export const updateConversation = async (req, res) => {
  try {
    const { participantId } = req.params;
    const { rsvp_status, number_of_guests, notes } = req.body;

    if (!participantId) return res.status(400).json({ error: "participantId is required" });

    if (req.user && req.user.user_id) {
      const ok = await verifyParticipantOwnership(participantId, req.user.user_id);
      if (!ok) return res.status(403).json({ error: "Not authorized to update this conversation" });
    }

    const updateFields = {
      rsvp_status,
      number_of_guests,
      notes,
      last_updated: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("conversation_results")
      .update(updateFields)
      .eq("participant_id", participantId)
      .select()
      .single();

    if (error) {
      console.error("updateConversation supabase error:", error);
      throw error;
    }

    res.status(200).json({ message: "Conversation updated successfully", data });
  } catch (err) {
    console.error("updateConversation error:", err);
    return res.status(500).json({ error: "Failed to update conversation", details: err.message || err });
  }
};

/**
 * POST /api/uploads/signed-url
 * Body: { filePath: "primary/..." } and/or { upload_id: "<uuid>" }
 * Generates signed URL for private bucket and validates ownership
 */
export const getSignedDocumentUrl = async (req, res) => {
  try {
    let { filePath, upload_id } = req.body;

    if (!filePath && !upload_id) {
      return res.status(400).json({ error: "filePath or upload_id is required" });
    }

    // Fetch upload record using whichever info is given
    let uploadRecord;
    if (upload_id) {
      const { data, error } = await supabase
        .from("uploads")
        .select("upload_id, participant_id, document_url")
        .eq("upload_id", upload_id)
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      uploadRecord = data;
    }

    if (!uploadRecord && filePath) {
      const { data, error } = await supabase
        .from("uploads")
        .select("upload_id, participant_id, document_url")
        .eq("document_url", filePath)
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      uploadRecord = data;
    }

    if (!uploadRecord) return res.status(404).json({ error: "Upload record not found" });

    // 🔥 Ownership check
    if (!req.user || !req.user.user_id) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const owns = await verifyParticipantOwnership(uploadRecord.participant_id, req.user.user_id);
    if (!owns) return res.status(403).json({ error: "Not authorized" });

    // ✅ Always normalize path to Storage key only
    let cleanPath = uploadRecord.document_url;

    if (cleanPath.includes("participant-docs/")) {
      cleanPath = cleanPath.split("participant-docs/")[1];
    }

    console.log("✅ Final storage path:", cleanPath);

    const { data: signed, error: signedError } = await supabase.storage
      .from("participant-docs")
      .createSignedUrl(cleanPath, 60 * 5);

    if (signedError) throw signedError;

    return res.status(200).json({
      signedUrl: signed.signedUrl,
      expiresAt: signed.expiresAt,
    });

  } catch (err) {
    console.error("getSignedDocumentUrl error:", err);
    return res.status(500).json({
      error: "Failed to generate signed URL",
      details: err.message || err,
    });
  }
};
