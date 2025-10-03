// models/eventModel.js
import { supabase } from "../config/supabase.js";

export const createEvent = async (payload) => {
  const { data, error } = await supabase
    .from("events")
    .insert([payload])
    .select()
    .single();

  if (error) throw error;
  return data;
};

export const listEventsByUser = async (user_id) => {
  const { data, error } = await supabase
  .from("events")
  .select("*")
  .eq("user_id", user_id)
  .order("created_at", { ascending: false });


  if (error) throw error;
  return data;
};

export const getEvent = async (event_id) => {
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .eq("event_id", event_id)
    .single();

  if (error && error.code !== "PGRST116") throw error; // PGRST116 = no rows
  return data || null;
};

export const bulkInsertParticipants = async (rows) => {
  const { data, error } = await supabase
    .from("participants")
    .insert(rows)
    .select();

  if (error) throw error;
  return data;
};

// Fetch event along with participants
export const getEventWithParticipants = async (event_id) => {
  // 1) Fetch event
  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("*")
    .eq("event_id", event_id)
    .single();

  if (eventError || !event) return null;

  // 2) Fetch participants for that event
  const { data: participants, error: participantsError } = await supabase
    .from("participants")
    .select(" participant_id,full_name, phone_number, email")
    .eq("event_id", event_id);

  if (participantsError) throw participantsError;

  return {
    ...event,
    participants: participants || [],
  };
};

