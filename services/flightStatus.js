import axios from "axios";
import { supabase } from "../config/supabase.js";

const AVIATIONSTACK_URL = process.env.AVIATIONSTACK_URL;
const API_KEY = process.env.AVIATIONSTACK_API_KEY;

export const fetchAndCacheFlightStatus = async ({
  eventId,
  participantId,
  participantName,
  participantPhoneNumber,
  flightIata,
  flightDate,
}) => {
  // 1️⃣ Call AviationStack
  const response = await axios.get(AVIATIONSTACK_URL, {
    params: {
      access_key: API_KEY,
      flight_iata: flightIata,
    },
  });

  const flights = response.data?.data || [];

  // 2️⃣ Match correct date
  const matchedFlight = flights.find((f) => f.flight_date === flightDate);

  let payload;

  if (!matchedFlight) {
    payload = {
      event_id: eventId,
      participant_id: participantId,
      full_name: participantName,
      phone_number: participantPhoneNumber,
      flight_iata: flightIata,
      flight_date: flightDate,
      flight_status: "NOT_FOUND",
      last_api_checked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      raw_api_response: response.data,
    };
  } else {
    const delay =
      matchedFlight.arrival?.delay || matchedFlight.departure?.delay || 0;

    payload = {
      event_id: eventId,
      participant_id: participantId,
      full_name: participantName,
      phone_number: participantPhoneNumber,
      flight_iata: flightIata,
      flight_date: flightDate,

      airline_name: matchedFlight.airline?.name || null,

      departure_airport_iata: matchedFlight.departure?.iata || null,
      departure_airport_name: matchedFlight.departure?.airport || null,

      arrival_airport_iata: matchedFlight.arrival?.iata || null,
      arrival_airport_name: matchedFlight.arrival?.airport || null,

      scheduled_arrival: matchedFlight.arrival?.scheduled || null,
      estimated_arrival: matchedFlight.arrival?.estimated || null,

      arrival_terminal: matchedFlight.arrival?.terminal || null,
      arrival_gate: matchedFlight.arrival?.gate || null,

      arrival_delay_minutes: delay,

      flight_status:
        delay > 0
          ? "DELAYED"
          : matchedFlight.flight_status === "active"
          ? "IN_AIR"
          : matchedFlight.flight_status.toUpperCase(),

      is_live: Boolean(matchedFlight.live),

      last_api_checked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      raw_api_response: matchedFlight,
    };
  }

  //insert data
  // await supabase.from("flight_status_cache").insert(payload);

  await supabase.from("flight_status_cache").upsert(payload, {
    onConflict: "participant_id",
  });

  return payload;
};
