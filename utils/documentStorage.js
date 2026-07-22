// utils/documentStorage.js
//
// Extracted from controllers/whatsappController.js (exact copy of the
// existing saveUploadRow / saveTravelItinerary logic — no behavior change).
//
// WHY THIS FILE EXISTS: whatsappController.js imports agentChatEngine.js,
// which needs to call these same functions for the new document/travel_ticket
// smart field types. Importing them straight from whatsappController.js
// would create a circular import (controller → engine → controller), so
// they live here instead, and whatsappController.js now imports them
// from here too.
//
// ACTION NEEDED in whatsappController.js:
//   1. Delete the local `saveUploadRow` and `saveTravelItinerary` function
//      definitions.
//   2. Add: import { saveUploadRow, saveTravelItinerary } from "../utils/documentStorage.js";
//   Every existing call site keeps working unchanged — same names, same signatures.

import { supabase } from "../config/supabase.js";

export async function saveUploadRow({
  participant_id,
  participant_relatives_name,
  document_url,
  document_type,
  role,
}) {
  try {
    const { data, error } = await supabase
      .from("uploads")
      .insert({
        participant_id,
        participant_relatives_name: participant_relatives_name || null,
        document_url: document_url || null,
        document_type: document_type || "Document",
        role: role || "Self",
        proof_uploaded: true,
        created_at: new Date().toISOString(),
      })
      .select();

    if (error) {
      console.error("❌ Error inserting upload row:", error);
      return null;
    }

    console.log("✅ Upload row saved:", data);
    return data;
  } catch (err) {
    console.error("❌ saveUploadRow error:", err);
    return null;
  }
}

export async function saveTravelItinerary({
  participant_id,
  upload_id,
  event_id,
  extractedData,
  direction,
  document_type = "ticket",
  participant_relatives_name,
}) {
  try {
    console.log("💾 Saving travel itinerary:", {
      participant_id,
      participant_relatives_name,
      direction,
      extractedData,
    });

    const { data: existing } = await supabase
      .from("travel_itinerary")
      .select("*")
      .eq("participant_id", participant_id)
      .eq("event_id", event_id)
      .eq("participant_relatives_name", participant_relatives_name)
      .maybeSingle();

    const itineraryData = {
      participant_id,
      upload_id,
      event_id,
      participant_relatives_name,
      document_type: document_type || "ticket",
      raw_text_extracted: JSON.stringify(extractedData),
      ai_json_extracted: extractedData,
      direction,
      updated_at: new Date().toISOString(),
    };

    if (direction === "arrival") {
      itineraryData.arrival_date = extractedData.date || null;
      itineraryData.arrival_time = extractedData.time || null;
      itineraryData.arrival_transport_no =
        extractedData.transport_number || null;
    } else if (direction === "return") {
      itineraryData.return_date = extractedData.date || null;
      itineraryData.return_time = extractedData.time || null;
      itineraryData.return_transport_no =
        extractedData.transport_number || null;
    }

    if (existing) {
      const updateFields = { ...itineraryData };
      delete updateFields.participant_id;
      delete updateFields.event_id;
      delete updateFields.participant_relatives_name;

      if (direction === "return" && existing.arrival_date) {
        updateFields.arrival_date = existing.arrival_date;
        updateFields.arrival_time = existing.arrival_time;
        updateFields.arrival_transport_no = existing.arrival_transport_no;
      }
      if (direction === "arrival" && existing.return_date) {
        updateFields.return_date = existing.return_date;
        updateFields.return_time = existing.return_time;
        updateFields.return_transport_no = existing.return_transport_no;
      }

      const { data: updated, error: updateError } = await supabase
        .from("travel_itinerary")
        .update(updateFields)
        .eq("itinerary_id", existing.itinerary_id)
        .select();

      if (updateError) {
        console.error("❌ Error updating travel_itinerary:", updateError);
        return null;
      }
      console.log(
        `✅ Travel itinerary updated for ${participant_relatives_name}:`,
        updated,
      );
      return updated;
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from("travel_itinerary")
        .insert(itineraryData)
        .select();

      if (insertError) {
        console.error("❌ Error inserting travel_itinerary:", insertError);
        return null;
      }
      console.log(
        `✅ Travel itinerary created for ${participant_relatives_name}:`,
        inserted,
      );
      return inserted;
    }
  } catch (err) {
    console.error("❌ saveTravelItinerary error:", err);
    return null;
  }
}
