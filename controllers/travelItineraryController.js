// controllers/travelItineraryController.js - NEW FILE
import { supabase } from "../config/supabase.js";

/**
 * Get all travel itineraries for an event
 * GET /api/travel-itinerary/event/:event_id
 */
export const getEventTravelItineraries = async (req, res) => {
  try {
    const { event_id } = req.params;

    if (!event_id) {
      return res.status(400).json({ error: "event_id is required" });
    }

    // Fetch travel itineraries with participant details
    const { data: itineraries, error } = await supabase
      .from("travel_itinerary")
      .select(
        `
        *,
        participants!inner(
          participant_id,
          full_name,
          phone_number,
          email
        )
      `
      )
      .eq("event_id", event_id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("❌ Error fetching travel itineraries:", error);
      return res
        .status(500)
        .json({ error: "Failed to fetch travel itineraries" });
    }

    // Format the response
    const formatted = itineraries.map((item) => ({
      itinerary_id: item.itinerary_id,
      participant_id: item.participant_id,
      participant_name: item.participants.full_name,
      participant_phone: item.participants.phone_number,
      participant_email: item.participants.email,
      attendee_name: item.participant_relatives_name,

      // Arrival details
      arrival: {
        date: item.arrival_date,
        time: item.arrival_time,
        transport_no: item.arrival_transport_no,
        has_data: !!(item.arrival_date && item.arrival_time),
      },

      // Return details
      return: {
        date: item.return_date,
        time: item.return_time,
        transport_no: item.return_transport_no,
        has_data: !!(item.return_date && item.return_time),
      },

      // Extracted data
      extracted_data: item.ai_json_extracted,
      document_type: item.document_type,
      direction: item.direction,

      created_at: item.created_at,
      updated_at: item.updated_at,
    }));

    return res.json({
      success: true,
      count: formatted.length,
      itineraries: formatted,
    });
  } catch (error) {
    console.error("❌ getEventTravelItineraries error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * Get travel itinerary for a specific participant
 * GET /api/travel-itinerary/participant/:participant_id
 */
export const getParticipantTravelItinerary = async (req, res) => {
  try {
    const { participant_id } = req.params;

    if (!participant_id) {
      return res.status(400).json({ error: "participant_id is required" });
    }

    const { data: itineraries, error } = await supabase
      .from("travel_itinerary")
      .select("*")
      .eq("participant_id", participant_id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("❌ Error fetching participant itineraries:", error);
      return res.status(500).json({ error: "Failed to fetch itineraries" });
    }

    // Group by person
    const groupedByPerson = {};

    for (const item of itineraries) {
      const personName = item.participant_relatives_name;

      if (!groupedByPerson[personName]) {
        groupedByPerson[personName] = {
          attendee_name: personName,
          arrival: null,
          return: null,
        };
      }

      // Add arrival or return data
      if (item.arrival_date && item.arrival_time) {
        groupedByPerson[personName].arrival = {
          date: item.arrival_date,
          time: item.arrival_time,
          transport_no: item.arrival_transport_no,
          from: item.ai_json_extracted?.from_location,
          to: item.ai_json_extracted?.to_location,
          pnr: item.ai_json_extracted?.pnr,
        };
      }

      if (item.return_date && item.return_time) {
        groupedByPerson[personName].return = {
          date: item.return_date,
          time: item.return_time,
          transport_no: item.return_transport_no,
          from: item.ai_json_extracted?.from_location,
          to: item.ai_json_extracted?.to_location,
          pnr: item.ai_json_extracted?.pnr,
        };
      }
    }

    return res.json({
      success: true,
      participant_id,
      attendees: Object.values(groupedByPerson),
    });
  } catch (error) {
    console.error("❌ getParticipantTravelItinerary error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * Get travel summary for an event (statistics)
 * GET /api/travel-itinerary/event/:event_id/summary
 */
export const getEventTravelSummary = async (req, res) => {
  try {
    const { event_id } = req.params;

    if (!event_id) {
      return res.status(400).json({ error: "event_id is required" });
    }

    const { data: itineraries, error } = await supabase
      .from("travel_itinerary")
      .select("*")
      .eq("event_id", event_id);

    if (error) {
      console.error("❌ Error fetching travel summary:", error);
      return res.status(500).json({ error: "Failed to fetch summary" });
    }

    // Calculate statistics
    const stats = {
      total_travelers: itineraries.length,
      with_arrival: 0,
      with_return: 0,
      complete_itinerary: 0,
      pending_arrival: 0,
      pending_return: 0,
      arrival_dates: {},
      return_dates: {},
    };

    for (const item of itineraries) {
      const hasArrival = !!(item.arrival_date && item.arrival_time);
      const hasReturn = !!(item.return_date && item.return_time);

      if (hasArrival) {
        stats.with_arrival++;
        const date = item.arrival_date;
        stats.arrival_dates[date] = (stats.arrival_dates[date] || 0) + 1;
      } else {
        stats.pending_arrival++;
      }

      if (hasReturn) {
        stats.with_return++;
        const date = item.return_date;
        stats.return_dates[date] = (stats.return_dates[date] || 0) + 1;
      } else {
        stats.pending_return++;
      }

      if (hasArrival && hasReturn) {
        stats.complete_itinerary++;
      }
    }

    return res.json({
      success: true,
      event_id,
      summary: stats,
    });
  } catch (error) {
    console.error("❌ getEventTravelSummary error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * Delete a travel itinerary
 * DELETE /api/travel-itinerary/:itinerary_id
 */
export const deleteTravelItinerary = async (req, res) => {
  try {
    const { itinerary_id } = req.params;

    if (!itinerary_id) {
      return res.status(400).json({ error: "itinerary_id is required" });
    }

    const { error } = await supabase
      .from("travel_itinerary")
      .delete()
      .eq("itinerary_id", itinerary_id);

    if (error) {
      console.error("❌ Error deleting travel itinerary:", error);
      return res.status(500).json({ error: "Failed to delete itinerary" });
    }

    return res.json({
      success: true,
      message: "Travel itinerary deleted successfully",
    });
  } catch (error) {
    console.error("❌ deleteTravelItinerary error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getTravelItinerary = async (req, res) => {
  try {
    const { participantId } = req.params;

    // 1. Fetch participant
    const { data: participant, error: participantError } = await supabase
      .from("participants")
      .select("*")
      .eq("participant_id", participantId)
      .single();

    if (participantError || !participant) {
      return res.status(404).json({ error: "Participant not found" });
    }

    // 2. Fetch uploads for that participant
    const { data: uploads, error: uploadError } = await supabase
      .from("uploads")
      .select("*")
      .eq("participant_id", participantId);

    if (uploadError) {
      return res.status(500).json({ error: "Error fetching uploads" });
    }

    // 3. Fetch travel itinerary for participant
    const { data: itineraries, error: itineraryError } = await supabase
      .from("travel_itinerary")
      .select("*")
      .eq("participant_id", participantId)
      .order("created_at", { ascending: false });

    if (itineraryError) {
      return res.status(500).json({ error: "Error fetching travel itinerary" });
    }

    // ⬇️ FORMAT ARRIVAL + RETURN DATA GROUPED BY NAME
    const grouped = {};

    for (const item of itineraries) {
      const name = item.participant_relatives_name || "Unknown";

      if (!grouped[name]) {
        grouped[name] = {
          attendee_name: name,
          arrival: null,
          return: null,
        };
      }

      if (item.arrival_date || item.arrival_time) {
        grouped[name].arrival = {
          date: item.arrival_date,
          time: item.arrival_time,
          transport_no: item.arrival_transport_no,
          from: item.ai_json_extracted?.from_location,
          to: item.ai_json_extracted?.to_location,
          pnr: item.ai_json_extracted?.pnr,
        };
      }

      if (item.return_date || item.return_time) {
        grouped[name].return = {
          date: item.return_date,
          time: item.return_time,
          transport_no: item.return_transport_no,
          from: item.ai_json_extracted?.from_location,
          to: item.ai_json_extracted?.to_location,
          pnr: item.ai_json_extracted?.pnr,
        };
      }
    }

    // 4. Latest conversation result
    const { data: conversationResult, error: convoError } = await supabase
      .from("conversation_results")
      .select("*")
      .eq("participant_id", participantId)
      .order("last_updated", { ascending: false })
      .limit(1)
      .single();

    if (convoError && convoError.code !== "PGRST116") {
      return res
        .status(500)
        .json({ error: "Error fetching conversation result" });
    }

    // 5. Proof uploaded status
    const proofUploaded =
      uploads?.some((u) => u.proof_uploaded === true) ?? false;

    // 6. FINAL RESPONSE
    return res.json({
      participant,
      uploads,
      itinerary: Object.values(grouped), // ⬅️ arrival / return
      conversationResult,
      proof_uploaded: proofUploaded,
    });
  } catch (err) {
    console.error("getTravelItinerary Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};
