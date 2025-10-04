// import { createClient } from "@supabase/supabase-js";

// export const supabase = createClient(
//   process.env.SUPABASE_URL,
//   process.env.SUPABASE_SERVICE_ROLE_KEY
// );

// export const submitUpload = async (req, res) => {
//   try {
//     const { participant_id } = req.body;

//     // Case 1: members array (bulk upload)
//     if (req.body.members) {
//       const members = JSON.parse(req.body.members);
//       const files = req.files;

//       if (!members || members.length === 0) {
//         return res.status(400).json({ error: "No members provided" });
//       }

//       if (!files || files.length !== members.length) {
//         return res
//           .status(400)
//           .json({ error: "Files count must match members count" });
//       }

//       const results = [];

//       for (let i = 0; i < members.length; i++) {
//         const member = members[i];
//         const file = files[i];

//         const filePath = `primary/${Date.now()}_${file.originalname}`;
//         const { error: uploadError } = await supabase.storage
//           .from("participant-docs")
//           .upload(filePath, file.buffer, { upsert: true });

//         if (uploadError) throw uploadError;

//         const { data: publicData } = supabase.storage
//           .from("participant-docs")
//           .getPublicUrl(filePath);

//         const documentUrl = publicData.publicUrl;

//         const { data, error } = await supabase
//           .from("uploads")
//           .insert({
//             participant_id,
//             participant_relatives_name:
//               member.role === "Self" ? null : member.full_name,
//             document_url: documentUrl,
//             document_type: member.document_type,
//             role: member.role,
//             proof_uploaded: true,
//           })
//           .select()
//           .single();

//         if (error) throw error;
//         results.push(data);
//       }

//       return res.status(201).json({
//         message: "Bulk upload successful",
//         uploads: results,
//       });
//     }

//     // Case 2: single member (Self or Guest)
//     const file = req.file; // This works with the alternative router
//     if (!file) return res.status(400).json({ error: "No file uploaded" });

//     const { full_name, role, document_type } = req.body;

//     const filePath = `primary/${Date.now()}_${file.originalname}`;
//     const { error: uploadError } = await supabase.storage
//       .from("participant-docs")
//       .upload(filePath, file.buffer, { upsert: true });

//     if (uploadError) throw uploadError;

//     const { data: publicData } = supabase.storage
//       .from("participant-docs")
//       .getPublicUrl(filePath);

//     const documentUrl = publicData.publicUrl;

//     const { data, error } = await supabase
//       .from("uploads")
//       .insert({
//         participant_id,
//         participant_relatives_name: role === "Self" ? null : full_name,
//         document_url: documentUrl,
//         document_type,
//         role,
//         proof_uploaded: true,
//       })
//       .select()
//       .single();

//     if (error) throw error;

//     return res
//       .status(201)
//       .json({ message: "Upload saved successfully", upload: data });
//   } catch (err) {
//     console.error("submitUpload error:", err);
//     return res.status(500).json({ error: "Failed to save upload" });
//   }
// };

import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const submitUpload = async (req, res) => {
  try {
    console.log('req.body:', req.body);
    console.log('req.files:', req.files);
    
    const { participant_id } = req.body;

    if (!participant_id) {
      return res.status(400).json({ error: "participant_id is required" });
    }

    // Case 1: members array (bulk upload)
    if (req.body.members) {
      const members = JSON.parse(req.body.members);
      const files = req.files;

      console.log('Bulk upload detected');
      console.log('Members:', members);
      console.log('Files count:', files?.length);

      if (!members || members.length === 0) {
        return res.status(400).json({ error: "No members provided" });
      }

      if (!files || files.length !== members.length) {
        return res
          .status(400)
          .json({ 
            error: `Files count (${files?.length || 0}) must match members count (${members.length})` 
          });
      }

      const results = [];

      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        const file = files[i];

        console.log(`Processing member ${i + 1}:`, member.full_name);

        const filePath = `primary/${Date.now()}_${file.originalname}`;
        const { error: uploadError } = await supabase.storage
          .from("participant-docs")
          .upload(filePath, file.buffer, { upsert: true,  contentType: file.mimetype  });

        if (uploadError) {
          console.error('Supabase upload error:', uploadError);
          throw uploadError;
        }

        const { data: publicData } = supabase.storage
          .from("participant-docs")
          .getPublicUrl(filePath);

        const documentUrl = publicData.publicUrl;

        const { data, error } = await supabase
          .from("uploads")
          .insert({
            participant_id,
            participant_relatives_name: member.full_name,
            document_url: documentUrl,
            document_type: member.document_type,
            role: member.role,
            proof_uploaded: true,
          })
          .select()
          .single();

        if (error) {
          console.error('Database insert error:', error);
          throw error;
        }
        
        results.push(data);
      }

      return res.status(201).json({
        message: "Bulk upload successful",
        uploads: results,
      });
    }

    // Case 2: single member (Self or Guest)
    console.log('Single upload detected');
    
    // For single uploads, find the file (could be named 'file' or 'files')
    const file = req.files?.find(f => f.fieldname === 'file') || req.files?.[0];
    
    if (!file) {
      console.log('Available files:', req.files?.map(f => ({ fieldname: f.fieldname, filename: f.originalname })));
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { full_name, role, document_type } = req.body;

    console.log('Single upload data:', { full_name, role, document_type });

    const filePath = `primary/${Date.now()}_${file.originalname}`;
    const { error: uploadError } = await supabase.storage
      .from("participant-docs")
      .upload(filePath, file.buffer, { upsert: true,  contentType: file.mimetype  });

    if (uploadError) {
      console.error('Supabase upload error:', uploadError);
      throw uploadError;
    }

    const { data: publicData } = supabase.storage
      .from("participant-docs")
      .getPublicUrl(filePath);

    const documentUrl = publicData.publicUrl;

    const { data, error } = await supabase
      .from("uploads")
      .insert({
        participant_id,
        participant_relatives_name: full_name ,
        document_url: documentUrl,
        document_type,
        role,
        proof_uploaded: true,
      })
      .select()
      .single();

    if (error) {
      console.error('Database insert error:', error);
      throw error;
    }

    return res
      .status(201)
      .json({ message: "Upload saved successfully", upload: data });
  } catch (err) {
    console.error("submitUpload error:", err);
    return res.status(500).json({ 
      error: "Failed to save upload", 
      details: err.message 
    });
  }
};

// ✅ Get all uploads for a given participant_id
export const getUploadsByParticipant = async (req, res) => {
  try {
    const { participant_id } = req.params;

    if (!participant_id) {
      return res.status(400).json({ error: "participant_id is required" });
    }

    // Fetch all uploads linked to this participant_id
    const { data, error } = await supabase
      .from("uploads")
      .select("*")
      .eq("participant_id", participant_id)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Error fetching uploads:", error);
      throw error;
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ message: "No uploads found for this participant" });
    }

    return res.status(200).json({
      message: "Uploads fetched successfully",
      count: data.length,
      uploads: data,
    });
  } catch (err) {
    console.error("getUploadsByParticipant error:", err);
    return res.status(500).json({
      error: "Failed to fetch uploads",
      details: err.message,
    });
  }
};

// PUT /api/uploads/:uploadId
export const updateUpload = async (req, res) => {
  try {
    const { uploadId } = req.params;
    const { full_name, document_type } = req.body;
    const file = req.file;

    let updateData = {
      participant_relatives_name: full_name,
      document_type: document_type,
      created_at: new Date().toISOString()
    };

    // If new file uploaded, handle file upload to Supabase storage
    if (file) {
      // Upload new file logic here
      const fileExt = file.originalname.split('.').pop();
      const fileName = `${uploadId}-${Date.now()}.${fileExt}`;
      
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('participant-docs')
        .upload(fileName, file.buffer, { upsert: true,  contentType: file.mimetype  });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('participant-docs')
        .getPublicUrl(fileName);

      updateData.document_url = urlData.publicUrl;
    }

    const { error } = await supabase
      .from('uploads')
      .update(updateData)
      .eq('upload_id', uploadId);

    if (error) throw error;

    res.status(200).json({ message: 'Document updated successfully' });
  } catch (error) {
    console.error('Error updating upload:', error);
    res.status(500).json({ error: 'Failed to update document' });
  }
};

// ✅ Get conversation details for a participant
export const getConversationByParticipant = async (req, res) => {
  try {
    const { participantId } = req.params;

    if (!participantId) {
      return res.status(400).json({ error: "participantId is required" });
    }

    const { data, error } = await supabase
      .from("conversation_results")
      .select("rsvp_status, number_of_guests, notes")
      .eq("participant_id", participantId)
      .single();

    if (error || !data) {
      console.error("Error fetching conversation:", error);
      return res.status(404).json({ message: "Conversation not found" });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error("getConversationByParticipant error:", error);
    res.status(500).json({ error: "Failed to fetch conversation", details: error.message });
  }
};

// ✅ Update conversation details for a participant
export const updateConversation = async (req, res) => {
  try {
    const { participantId } = req.params;
    const { rsvp_status, number_of_guests, notes } = req.body;

    if (!participantId) {
      return res.status(400).json({ error: "participantId is required" });
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
      console.error("Error updating conversation:", error);
      throw error;
    }

    res.status(200).json({ message: "Conversation updated successfully", data });
  } catch (error) {
    console.error("updateConversation error:", error);
    res.status(500).json({ error: "Failed to update conversation", details: error.message });
  }
};
