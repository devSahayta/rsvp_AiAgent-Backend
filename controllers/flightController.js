import { supabase } from "../config/supabase.js";
import { fetchAndCacheFlightStatus } from "../services/flightStatus.js";

import { getEvent } from "../models/eventModel.js";
import { getParticipantsById } from "../models/conversationModel.js";

export const verifyEventOwnership = async (eventId, userId) => {
  const event = await getEvent(eventId);

  if (!event) {
    return { ok: false, status: 404, error: "Event not found" };
  }

  if (event.user_id !== userId) {
    return { ok: false, status: 403, error: "Unauthorized access to event" };
  }

  return { ok: true, event };
};

export const getEventFlights = async (req, res) => {
  const { eventId } = req.params;

  const { user_id } = req.query;

  if (!user_id || !eventId)
    return res.status(400).json({ error: "user id and event id is required" });

  // 🔐 Check event ownership
  const auth = await verifyEventOwnership(eventId, user_id);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const { data, error } = await supabase
    .from("flight_status_cache")
    .select("*")
    .eq("event_id", eventId)
    .order("scheduled_arrival", { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ flights: data });
};

const REFRESH_COOLDOWN_HOURS = 6;

export const refreshEventFlightStatuses = async (req, res) => {
  try {
    const { eventId } = req.params;

    const { user_id } = req.query;

    if (!user_id || !eventId)
      return res
        .status(400)
        .json({ error: "user id and event id is required" });

    // 🔐 Check event ownership
    const auth = await verifyEventOwnership(eventId, user_id);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

    // 1️⃣ Get all participants with flight numbers for this event
    const { data: itineraries, error } = await supabase
      .from("travel_itinerary")
      .select(
        `
      participant_id,
      arrival_transport_no,
      arrival_date
    `
      )
      .eq("event_id", eventId)
      .not("arrival_transport_no", "is", null);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!itineraries.length) {
      return res.status(400).json({
        error: "No participants with flight details found for this event",
      });
    }

    // 2️⃣ Get existing cache to enforce 6-hour rule
    const { data: cachedStatuses } = await supabase
      .from("flight_status_cache")
      .select("participant_id, last_api_checked_at")
      .eq("event_id", eventId);

    const cacheMap = new Map();
    cachedStatuses?.forEach((c) =>
      cacheMap.set(c.participant_id, c.last_api_checked_at)
    );

    let refreshedCount = 0;
    let skippedCount = 0;

    // 3️⃣ Loop through each participant flight
    for (const item of itineraries) {
      const lastChecked = cacheMap.get(item.participant_id);

      if (lastChecked) {
        const hoursDiff = (Date.now() - new Date(lastChecked)) / 36e5;

        if (hoursDiff < REFRESH_COOLDOWN_HOURS) {
          skippedCount++;
          continue;
        }
      }

      const participantData = await getParticipantsById(item.participant_id);

      // console.log({ participantData, participantId: item.participant_id });

      // ⚠️ One API call per participant
      await fetchAndCacheFlightStatus({
        eventId,
        participantId: item.participant_id,
        participantName: participantData.full_name,
        participantPhoneNumber: participantData.phone_number,
        flightIata: item.arrival_transport_no,
        flightDate: item.arrival_date,
      });

      refreshedCount++;
    }

    res.json({
      message: "Flight refresh completed",
      refreshed: refreshedCount,
      skipped_due_to_cooldown: skippedCount,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
