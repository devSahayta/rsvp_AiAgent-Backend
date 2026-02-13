// controllers/transportController.js - COST-OPTIMIZED VERSION
import { supabase } from "../config/supabase.js";
import { optimizeForCost } from "../utils/transportOptimizer.js";

/**
 * Add available vehicle
 * POST /api/transport/add-vehicle
 */
export const addVehicle = async (req, res) => {
  try {
    const { 
      event_id, 
      vehicle_name, 
      vehicle_type, 
      capacity,
      earliest_start_time,
      assigned_location 
    } = req.body;

    if (!event_id || !vehicle_name || !vehicle_type || !capacity) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: event_id, vehicle_name, vehicle_type, capacity"
      });
    }

    console.log(`➕ Adding vehicle: ${vehicle_name} (${capacity} seats)`);

    const { data, error } = await supabase
      .from("available_vehicles")
      .insert({
        event_id,
        vehicle_name,
        vehicle_type,
        capacity: parseInt(capacity),
        earliest_start_time,
        assigned_location,
        is_active: true
      })
      .select()
      .single();

    if (error) {
      console.error("❌ Error adding vehicle:", error);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    return res.json({
      success: true,
      message: "Vehicle added successfully",
      data: data
    });

  } catch (error) {
    console.error("❌ addVehicle error:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Get available vehicles for an event
 * GET /api/transport/vehicles/:event_id
 */
export const getVehicles = async (req, res) => {
  try {
    const { event_id } = req.params;

    const { data, error } = await supabase
      .from("available_vehicles")
      .select("*")
      .eq("event_id", event_id)
      .order("created_at", { ascending: true });

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    return res.json({
      success: true,
      data: data || []
    });

  } catch (error) {
    console.error("❌ getVehicles error:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Update vehicle
 * PUT /api/transport/vehicle/:vehicle_id
 */
export const updateVehicle = async (req, res) => {
  try {
    const { vehicle_id } = req.params;
    const updates = req.body;

    const { data, error } = await supabase
      .from("available_vehicles")
      .update(updates)
      .eq("vehicle_id", vehicle_id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    return res.json({
      success: true,
      message: "Vehicle updated successfully",
      data: data
    });

  } catch (error) {
    console.error("❌ updateVehicle error:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Delete vehicle
 * DELETE /api/transport/vehicle/:vehicle_id
 */
export const deleteVehicle = async (req, res) => {
  try {
    const { vehicle_id } = req.params;

    // 1️⃣ Check if vehicle is used in pickup groups
    const { data: usage, error: usageError } = await supabase
      .from("pickup_groups")
      .select("group_id")
      .eq("vehicle_id", vehicle_id)
      .limit(1);

    if (usageError) {
      throw usageError;
    }

    if (usage.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Vehicle is already used in a pickup plan. Delete the plan first."
      });
    }

    // 2️⃣ Safe delete
    const { error } = await supabase
      .from("available_vehicles")
      .delete()
      .eq("vehicle_id", vehicle_id);

    if (error) {
      throw error;
    }

    return res.json({
      success: true,
      message: "Vehicle deleted successfully"
    });

  } catch (error) {
    console.error("❌ deleteVehicle error:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};



/**
 * Generate cost-optimized pickup plan
 * POST /api/transport/generate-plan
 */
export const generatePickupPlan = async (req, res) => {
  try {
    const { event_id, max_wait_minutes, avg_distance_km } = req.body;
    
    if (!event_id) {
      return res.status(400).json({ 
        success: false,
        error: "event_id is required" 
      });
    }

    console.log("💰 Generating cost-optimized pickup plan for event:", event_id);

    // Run cost optimization
    const optimization = await optimizeForCost(event_id, {
      maxWaitMinutes: max_wait_minutes || 120,
      avgDistanceKm: avg_distance_km || 30
    });
    
    if (!optimization.success) {
      return res.status(400).json({
        success: false,
        error: optimization.error
      });
    }

    // Save master plan
    const { data: plan, error: planError } = await supabase
      .from("pickup_plans")
      .insert({
        event_id: event_id,
        optimization_strategy: 'cost_minimized',
        max_wait_time_minutes: optimization.optimization_settings.maxWaitMinutes,
        total_vehicles_used: optimization.summary.total_vehicles_used,
        total_vehicles_available: optimization.summary.total_vehicles_available,
        total_passengers: optimization.summary.total_passengers,
        total_locations: optimization.summary.locations,
        vehicles_saved: optimization.summary.vehicles_saved,
        estimated_cost: optimization.summary.estimated_cost,
        cost_saved: optimization.summary.cost_saved,
        avg_wait_time_minutes: optimization.summary.avg_wait_time,
        max_wait_time_minutes_actual: optimization.summary.max_wait_time,
        passengers_waiting_over_60min: optimization.summary.passengers_waiting_over_60min,
        optimization_summary: optimization.summary,
        vehicle_breakdown: {}, // Can populate if needed
        status: 'draft',
        generated_by: req.user?.id || null
      })
      .select()
      .single();

    if (planError) {
      console.error("❌ Error saving plan:", planError);
      return res.status(500).json({ 
        success: false,
        error: "Failed to save pickup plan" 
      });
    }

    console.log("✅ Plan saved:", plan.plan_id);

    // Save pickup groups
    const groupsToInsert = optimization.groups.map(group => ({
      plan_id: plan.plan_id,
      vehicle_id: group.vehicle_id,
      vehicle_number: group.vehicle_number,
      vehicle_name: group.vehicle_name,
      vehicle_type: group.vehicle_type,
      vehicle_capacity: group.capacity,
      pickup_location: group.pickup_location,
      vehicle_arrival_time: group.vehicle_arrival_time,
      first_passenger_arrival: group.first_passenger_arrival,
      last_passenger_arrival: group.last_passenger_arrival,
      vehicle_departure_time: group.vehicle_departure_time,
      passenger_count: group.passenger_count,
      passenger_ids: group.passenger_ids,
      passengers_details: group.passengers_details,
      total_wait_time_minutes: group.total_wait_time_minutes,
      avg_wait_time_minutes: group.avg_wait_time_minutes,
      max_wait_time_minutes: group.max_wait_time_minutes,
      driver_instructions: group.driver_instructions,
      contact_person: group.contact_person,
      contact_phone: group.contact_phone,
      dispatch_status: 'pending'
    }));

    const { data: savedGroups, error: groupsError } = await supabase
      .from("pickup_groups")
      .insert(groupsToInsert)
      .select();

    if (groupsError) {
      console.error("❌ Error saving groups:", groupsError);
      await supabase.from("pickup_plans").delete().eq("plan_id", plan.plan_id);
      return res.status(500).json({ 
        success: false,
        error: "Failed to save pickup groups" 
      });
    }

    console.log(`✅ Saved ${savedGroups.length} pickup groups`);

    // Update travel_itinerary with wait times
    for (const group of savedGroups) {
      if (group.passengers_details && group.passengers_details.length > 0) {
        for (const passenger of group.passengers_details) {
          await supabase
            .from("travel_itinerary")
            .update({ 
              assigned_group_id: group.group_id,
              estimated_wait_minutes: passenger.wait_minutes,
              pickup_confirmed: false 
            })
            .eq("participant_id", passenger.participant_id)
            .eq("event_id", event_id);
        }
      }
    }

    return res.json({
      success: true,
      message: "Cost-optimized pickup plan generated successfully",
      data: {
        plan_id: plan.plan_id,
        summary: optimization.summary,
        groups_count: savedGroups.length,
        cost_analysis: {
          total_cost: optimization.summary.estimated_cost,
          cost_saved: optimization.summary.cost_saved,
          vehicles_used: optimization.summary.total_vehicles_used,
          vehicles_saved: optimization.summary.vehicles_saved
        },
        wait_time_analysis: {
          avg_wait: optimization.summary.avg_wait_time,
          max_wait: optimization.summary.max_wait_time,
          long_waiters: optimization.summary.passengers_waiting_over_60min
        }
      }
    });

  } catch (error) {
    console.error("❌ generatePickupPlan error:", error);
    return res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
};

/**
 * Get pickup plan
 * GET /api/transport/plan/:event_id
 */
export const getPickupPlan = async (req, res) => {
  try {
    const { event_id } = req.params;

    const { data: plan, error: planError } = await supabase
      .from("pickup_plans")
      .select(`
        *,
        pickup_groups (*)
      `)
      .eq("event_id", event_id)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (planError) {
      return res.status(500).json({ 
        success: false,
        error: planError.message 
      });
    }

    if (!plan) {
      return res.status(404).json({ 
        success: false,
        error: "No pickup plan found" 
      });
    }

    if (plan.pickup_groups) {
      plan.pickup_groups.sort((a, b) => a.vehicle_number - b.vehicle_number);
    }

    return res.json({
      success: true,
      data: plan
    });

  } catch (error) {
    console.error("❌ getPickupPlan error:", error);
    return res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
};

/**
 * Finalize plan
 * POST /api/transport/finalize/:plan_id
 */
export const finalizePlan = async (req, res) => {
  try {
    const { plan_id } = req.params;

    const { data, error } = await supabase
      .from("pickup_plans")
      .update({
        status: 'finalized',
        finalized_at: new Date().toISOString()
      })
      .eq("plan_id", plan_id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }

    return res.json({
      success: true,
      message: "Plan finalized successfully",
      data: data
    });

  } catch (error) {
    console.error("❌ finalizePlan error:", error);
    return res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
};

/**
 * Delete plan
 * DELETE /api/transport/plan/:plan_id
 */
export const deletePlan = async (req, res) => {
  try {
    const { plan_id } = req.params;

    const { error } = await supabase
      .from("pickup_plans")
      .delete()
      .eq("plan_id", plan_id);

    if (error) {
      return res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }

    return res.json({
      success: true,
      message: "Plan deleted successfully"
    });

  } catch (error) {
    console.error("❌ deletePlan error:", error);
    return res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
};

/**
 * Update dispatch status
 * POST /api/transport/update-status/:group_id
 */
export const updateDispatchStatus = async (req, res) => {
  try {
    const { group_id } = req.params;
    const { status } = req.body;

    if (!['pending', 'dispatched', 'completed'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: "Invalid status"
      });
    }

    const { data, error } = await supabase
      .from("pickup_groups")
      .update({ dispatch_status: status })
      .eq("group_id", group_id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }

    return res.json({
      success: true,
      message: `Status updated to ${status}`,
      data: data
    });

  } catch (error) {
    console.error("❌ updateDispatchStatus error:", error);
    return res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
};

/**
 * GET /api/transport/location-summary/:event_id
 * Returns grouped passengers by pickup location with counts
 */
export const getLocationSummary = async (req, res) => {
  try {
    const { event_id } = req.params;

    // Fetch all arrivals with passenger details
    const { data: arrivals, error } = await supabase
      .from("travel_itinerary")
      .select(`
        itinerary_id,
        participant_id,
        arrival_date,
        arrival_time,
        arrival_transport_no,
        ai_json_extracted,
        participants!inner(
          full_name,
          phone_number
        )
      `)
      .eq("event_id", event_id)
      .not("arrival_date", "is", null)
      .order("arrival_date", { ascending: true })
      .order("arrival_time", { ascending: true });

    if (error) {
      console.error("❌ Error fetching arrivals:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to fetch arrival data"
      });
    }

    if (!arrivals || arrivals.length === 0) {
      return res.json({
        success: true,
        data: {
          total_passengers: 0,
          total_locations: 0,
          locations: []
        }
      });
    }

    // Extract location for each passenger
    const passengersWithLocations = arrivals.map(item => {
      const location = extractLocationFromRecord(item);
      
      return {
        participant_id: item.participant_id,
        name: item.participants.full_name,
        phone: item.participants.phone_number,
        location: location,
        arrival_date: item.arrival_date,
        arrival_time: item.arrival_time,
        arrival_datetime: combineDateTime(item.arrival_date, item.arrival_time),
        transport_number: item.arrival_transport_no
      };
    });

    // Group by location
    const locationGroups = {};
    
    passengersWithLocations.forEach(passenger => {
      const loc = passenger.location || "Unknown Location";
      
      if (!locationGroups[loc]) {
        locationGroups[loc] = {
          location: loc,
          passenger_count: 0,
          passengers: [],
          earliest_arrival: passenger.arrival_datetime,
          latest_arrival: passenger.arrival_datetime
        };
      }
      
      locationGroups[loc].passenger_count++;
      locationGroups[loc].passengers.push({
        name: passenger.name,
        phone: passenger.phone,
        arrival_time: passenger.arrival_time,
        arrival_datetime: passenger.arrival_datetime,
        transport_number: passenger.transport_number
      });
      
      // Update earliest/latest arrival times
      if (passenger.arrival_datetime < locationGroups[loc].earliest_arrival) {
        locationGroups[loc].earliest_arrival = passenger.arrival_datetime;
      }
      if (passenger.arrival_datetime > locationGroups[loc].latest_arrival) {
        locationGroups[loc].latest_arrival = passenger.arrival_datetime;
      }
    });

    // Convert to array and sort by passenger count (descending)
    const locationArray = Object.values(locationGroups)
      .sort((a, b) => b.passenger_count - a.passenger_count);

    // Add time span for each location
    locationArray.forEach(loc => {
      const spanMinutes = Math.floor(
        (loc.latest_arrival - loc.earliest_arrival) / 60000
      );
      loc.time_span_minutes = spanMinutes;
      loc.earliest_arrival_formatted = formatTime(loc.earliest_arrival);
      loc.latest_arrival_formatted = formatTime(loc.latest_arrival);
      
      // Sort passengers by arrival time within location
      loc.passengers.sort((a, b) => 
        new Date(a.arrival_datetime) - new Date(b.arrival_datetime)
      );
    });

    res.json({
      success: true,
      data: {
        total_passengers: passengersWithLocations.length,
        total_locations: locationArray.length,
        locations: locationArray
      }
    });

  } catch (error) {
    console.error("❌ Location summary error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Helper: Extract location from travel itinerary record
 * Uses same logic as optimizer
 */
function extractLocationFromRecord(itineraryRecord) {
  if (itineraryRecord.ai_json_extracted) {
    const aiData = itineraryRecord.ai_json_extracted;
    
    // Try departure field first (most detailed)
    if (aiData.departure) {
      return extractDetailedLocation(aiData.departure);
    }
    
    // Try from_location
    if (aiData.from_location) {
      return extractDetailedLocation(aiData.from_location);
    }
  }
  
  const transportNum = itineraryRecord.arrival_transport_no || "";
  if (/^(AI|6E|UK|SG|G8)/i.test(transportNum)) return "Airport";
  if (/^\d{5}$/i.test(transportNum)) return "Railway Station";
  
  return "Unknown Location";
}

/**
 * Extract detailed location - SAME as optimizer
 */
function extractDetailedLocation(locationString) {
  if (!locationString) return "Unknown Location";
  
  const loc = locationString.toLowerCase().trim();
  
  // ✅ BUS STATIONS - CHECK FIRST
  if (loc.includes('bus')) {
    return 'Bus Station';
  }
  
  // ✅ Airport with terminal/sub-location
  if (loc.includes('airport') || loc.includes('terminal') || /\bt\d+\b/.test(loc) || loc.includes('igi')) {
    
    const terminalMatch = loc.match(/\bt(\d+)\b|terminal\s*(\d+)/i);
    
    if (terminalMatch) {
      const termNum = terminalMatch[1] || terminalMatch[2];
      return `Airport Terminal ${termNum}`;
    }
    
    if (loc.includes('international')) {
      return 'Airport Terminal 2';
    }
    if (loc.includes('domestic')) {
      return 'Airport Terminal 1';
    }
    
    const cityMatch = loc.match(/(\w+)\s+airport/i);
    if (cityMatch && cityMatch[1] && cityMatch[1] !== 'airport') {
      const city = cityMatch[1].charAt(0).toUpperCase() + cityMatch[1].slice(1);
      return `${city} Airport`;
    }
    
    return 'Airport';
  }
  
  // ✅ Railway with station name
  if (loc.includes('railway') || loc.includes('station') || loc.includes('train') || loc.includes('cst')) {
    
    if (loc.includes('cst')) {
      return 'Cst Railway Station';
    }
    
    if (loc.includes('pune')) {
      return 'Pune Railway Station';
    }
    
    const stationMatch = loc.match(/(\w+)\s+(railway|station)/i);
    if (stationMatch && stationMatch[1] && stationMatch[1] !== 'railway' && stationMatch[1] !== 'train') {
      const station = stationMatch[1].charAt(0).toUpperCase() + stationMatch[1].slice(1);
      return `${station} Railway Station`;
    }
    return 'Railway Station';
  }
  
  return locationString;
}

/**
 * Helper: Combine date and time
 */
function combineDateTime(date, time) {
  if (!date) return null;

  try {
    const dateStr = date.includes('T') ? date.split('T')[0] : date;
    const timeStr = time && time.includes(':') ? time : '00:00';

    const dt = new Date(`${dateStr}T${timeStr}`);

    if (isNaN(dt.getTime())) {
      return null;
    }

    return dt;
  } catch (err) {
    console.error("Error combining date/time:", err);
    return null;
  }
}

/**
 * Helper: Format time
 */
function formatTime(datetime) {
  if (!datetime) return '';
  
  return new Date(datetime).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}