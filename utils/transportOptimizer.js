// utils/transportOptimizer.js - SMART COST-OPTIMIZED VERSION


import { supabase } from "../config/supabase.js";

/**
 * SMART COST-FIRST OPTIMIZATION ENGINE
 * Strategy: Group by time window, select BEST-FIT vehicle, maximize efficiency
 * Uses smallest vehicle that fits the passenger count
 */

const COST_PER_KM = {
  "Bus": 25,
  "SUV": 18,
  "Van": 20,
  "Sedan": 12,
  "Tempo Traveller": 25
};

/**
 * Main optimization function - SMART COST MINIMIZED
 */
export async function optimizeForCost(eventId, options = {}) {
  try {
    const {
      maxWaitMinutes = 120, // Default: guests can wait up to 2 hours
      avgDistanceKm = 30
    } = options;

    console.log("💰 Starting SMART COST-OPTIMIZED transport planning");
    console.log(`   Max wait time: ${maxWaitMinutes} minutes`);

    // Step 1: Fetch available vehicles defined by client
    const availableVehicles = await fetchAvailableVehicles(eventId);
    
    if (!availableVehicles || availableVehicles.length === 0) {
      return {
        success: false,
        error: "No vehicles available. Please add vehicles first in the dashboard."
      };
    }

    console.log(`🚗 Found ${availableVehicles.length} available vehicles`);

    // Step 2: Fetch all arrival data
    const arrivals = await fetchArrivalData(eventId);
    
    if (!arrivals || arrivals.length === 0) {
      return {
        success: false,
        error: "No arrival data found. Guests need to provide travel details first."
      };
    }

    console.log(`📊 Found ${arrivals.length} guest arrivals`);

    // Step 3: Group by location first
    const locationGroups = groupByLocation(arrivals);
    
    console.log(`📍 Locations: ${Object.keys(locationGroups).join(", ")}`);

    // Step 4: Optimize each location separately with SMART assignment
    const allGroups = [];
    let unassignedGuests = [];
    let vehicleCounter = 1;
    const usedVehicles = new Set();

    for (const [location, guests] of Object.entries(locationGroups)) {
      console.log(`\n📍 Optimizing ${location} (${guests.length} guests)`);
      
      // Get vehicles for this location (or unassigned vehicles)
      const locationKey = normalizeLocationKey(location);

const locationVehicles = availableVehicles.filter(v => {
  if (!v.assigned_location) return true;

  return normalizeLocationKey(v.assigned_location) === locationKey;
});

if (locationVehicles.length === 0) {
  console.warn(`⚠️  No vehicles available for ${location}`);

  // ✅ ADD THIS
  unassignedGuests.push(...guests);

  continue;
}
      console.log(`   🚙 ${locationVehicles.length} vehicles available for this location`);

      // Sort guests by arrival time
      const sortedGuests = [...guests].sort((a, b) => 
        new Date(a.arrival_datetime) - new Date(b.arrival_datetime)
      );

      // SMART: Fill vehicles with best-fit selection
      const locationAssignments = smartFillVehicles(
        sortedGuests,
        locationVehicles,
        maxWaitMinutes,
        location,
        usedVehicles
      );

      locationAssignments.forEach(group => {
        group.vehicle_number = vehicleCounter++;
        allGroups.push(group);
      });



    
      // Collect unassigned guests
      const assignedPassengerIds = locationAssignments.flatMap(g => g.passenger_ids);
      const locationUnassigned = sortedGuests.filter(
        g => !assignedPassengerIds.includes(g.participant_id)
      );
      if (locationUnassigned.length > 0) {
        unassignedGuests.push(...locationUnassigned);
      }
    }

    // Step 5: Calculate savings and statistics
    const totalVehiclesUsed = usedVehicles.size;
    const naiveVehicleCount = calculateNaiveVehicleCount(arrivals);
    const vehiclesSaved = naiveVehicleCount - totalVehiclesUsed;
    const totalCost = calculateTotalCost(allGroups, avgDistanceKm);
    const naiveCost = naiveVehicleCount * COST_PER_KM["SUV"] * avgDistanceKm * 2;
    const costSaved = naiveCost - totalCost;

    const summary = {
      total_vehicles_used: totalVehiclesUsed,
      total_vehicles_available: availableVehicles.length,
      total_passengers: arrivals.length,
      locations: Object.keys(locationGroups).length,
      vehicles_saved: vehiclesSaved,
      naive_vehicle_count: naiveVehicleCount,
      estimated_cost: totalCost,
      cost_saved: costSaved,
      avg_wait_time: calculateAverageWait(allGroups),
      max_wait_time: calculateMaxWait(allGroups),
      passengers_waiting_over_60min: countLongWaiters(allGroups, 60)
    };

    console.log("\n✅ SMART OPTIMIZATION COMPLETE:");
    console.log(`   Vehicles used: ${totalVehiclesUsed}/${availableVehicles.length}`);
    console.log(`   Vehicles saved: ${vehiclesSaved} (vs ${naiveVehicleCount} naive trips)`);
    console.log(`   Total cost: ₹${totalCost.toFixed(0)}`);
    console.log(`   Cost saved: ₹${costSaved.toFixed(0)}`);
    console.log(`   Avg wait: ${summary.avg_wait_time} min`);
    console.log(`   Max wait: ${summary.max_wait_time} min`);

          function groupUnassignedByLocation(unassignedGuests) {
  const result = {};

  unassignedGuests.forEach(g => {
    const location = g.location || "Unknown Location";
    if (!result[location]) {
      result[location] = {
        location,
        count: 0,
        passengers: []
      };
    }
    result[location].count++;
    result[location].passengers.push({
      name: g.name,
      arrival_time: g.arrival_datetime,
      transport_number: g.transport_number
    });
  });

  return Object.values(result);
}

    
const unassignedSummary = groupUnassignedByLocation(unassignedGuests);

   return {
  success: true,
  groups: allGroups,
  summary: summary,
  unassigned: {
    total: unassignedGuests.length,
    by_location: unassignedSummary
  },
  optimization_settings: { 
    strategy: 'smart_cost_minimized',
    maxWaitMinutes,
    avgDistanceKm
  }
};


  } catch (error) {
    console.error("❌ Cost optimization error:", error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * SMART ALGORITHM: Fill vehicles with BEST-FIT selection
 * Groups passengers by time window, then selects smallest vehicle that fits
 */
function smartFillVehicles(guests, vehicles, maxWaitMinutes, location, usedVehicles) {
  const groups = [];
  let remainingGuests = [...guests];

  while (remainingGuests.length > 0) {
    const firstGuest = remainingGuests[0];
    const firstArrivalTime = firstGuest.arrival_datetime;

    // Step 1: Collect ALL passengers within time window
    const timeWindowPassengers = [];
    for (const guest of remainingGuests) {
      const guestArrival = guest.arrival_datetime;
      
      if (isNaN(guestArrival.getTime())) {
        console.warn(`Invalid arrival time for ${guest.name}, skipping`);
        continue;
      }

      // Calculate wait time from first passenger
      const waitMinutes = Math.max(
        0,
        Math.floor((guestArrival - firstArrivalTime) / 60000)
      );

      // Add if within max wait time
      if (waitMinutes <= maxWaitMinutes) {
        timeWindowPassengers.push({
          ...guest,
          wait_minutes: waitMinutes,
          pickup_time: guestArrival.toISOString()
        });
      } else {
        break; // Guests are sorted, stop when exceeding limit
      }
    }

    if (timeWindowPassengers.length === 0) {
      console.warn(`⚠️  No valid passengers in time window, skipping`);
      remainingGuests.shift(); // Remove problematic guest
      continue;
    }

    // Step 2: Find BEST-FIT vehicle (smallest that can fit the group)
    const passengerCount = timeWindowPassengers.length;
    const bestVehicle = findBestFitVehicle(passengerCount, vehicles, usedVehicles);

    if (!bestVehicle) {
      console.warn(`⚠️  No available vehicle for ${passengerCount} passengers`);
      remainingGuests.shift(); // Move to next guest
      continue;
    }

    // Step 3: Assign passengers to best-fit vehicle
    const passengers = timeWindowPassengers.slice(0, bestVehicle.capacity);
    const vehicleArrival = new Date(firstArrivalTime.getTime() - 30 * 60000);
    const lastPassenger = passengers[passengers.length - 1];
    const departureTime = new Date(lastPassenger.pickup_time);

    // Calculate wait statistics
    const totalWait = passengers.reduce((sum, p) => sum + p.wait_minutes, 0);
    const avgWait = Math.floor(totalWait / passengers.length);
    const maxWait = Math.max(...passengers.map(p => p.wait_minutes));

    const utilization = Math.round((passengers.length / bestVehicle.capacity) * 100);

    groups.push({
      vehicle_id: bestVehicle.vehicle_id,
      vehicle_name: bestVehicle.vehicle_name,
      vehicle_type: bestVehicle.vehicle_type,
      capacity: bestVehicle.capacity,
      pickup_location: location,
      vehicle_arrival_time: vehicleArrival.toISOString(),
      first_passenger_arrival: firstArrivalTime.toISOString(),
      last_passenger_arrival: departureTime.toISOString(),
      vehicle_departure_time: departureTime.toISOString(),
      passenger_count: passengers.length,
      passengers_details: passengers,
      passenger_ids: passengers.map(p => p.participant_id),
      total_wait_time_minutes: totalWait,
      avg_wait_time_minutes: avgWait,
      max_wait_time_minutes: maxWait,
      driver_instructions: generateDriverInstructions(
        bestVehicle,
        location,
        passengers,
        vehicleArrival,
        departureTime
      ),
      contact_person: passengers[0].name,
      contact_phone: passengers[0].phone
    });

    // Mark vehicle as used
    usedVehicles.add(bestVehicle.vehicle_id);

    // Remove assigned passengers
    remainingGuests = remainingGuests.filter(g =>
      !passengers.find(p => p.participant_id === g.participant_id)
    );

    console.log(`   ✅ ${bestVehicle.vehicle_name} (${bestVehicle.capacity} seats) → ${passengers.length} passengers [${utilization}% utilization]`);
  }

  // Warn if guests remain unassigned
  if (remainingGuests.length > 0) {
    console.warn(`⚠️  ${remainingGuests.length} guests could not be assigned (need more vehicles or increase max wait)`);
  }

  return groups;
}

/**
 * BEST-FIT VEHICLE SELECTION
 * Finds the smallest available vehicle that can fit the passenger count
 */
function findBestFitVehicle(passengerCount, vehicles, usedVehicles) {
  // Sort vehicles by capacity (smallest first)
  const sortedVehicles = [...vehicles].sort((a, b) => a.capacity - b.capacity);

  // Step 1: Try smallest vehicle >= passenger count
  for (const vehicle of sortedVehicles) {
    if (!usedVehicles.has(vehicle.vehicle_id) && vehicle.capacity >= passengerCount) {
      return vehicle;
    }
  }

  // Step 2: If no exact fit, try **any larger vehicle** that's unused
  for (const vehicle of sortedVehicles) {
    if (!usedVehicles.has(vehicle.vehicle_id)) {
      return vehicle; // assign larger vehicle
    }
  }

  // Step 3: If still none, return null (no vehicles available at all)
  return null;
}


/**
 * Fetch client-defined available vehicles
 */
async function fetchAvailableVehicles(eventId) {
  try {
    const { data, error } = await supabase
      .from("available_vehicles")
      .select("*")
      .eq("event_id", eventId)
      .eq("is_active", true);

    if (error) {
      console.error("❌ Error fetching vehicles:", error);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error("❌ fetchAvailableVehicles exception:", err);
    return [];
  }
}

/**
 * Fetch arrival data from travel_itinerary
 */
async function fetchArrivalData(eventId) {
  try {
    const { data, error } = await supabase
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
      .eq("event_id", eventId)
      .not("arrival_date", "is", null)
      .order("arrival_date", { ascending: true });

    if (error) {
      console.error("❌ Error fetching arrivals:", error);
      return [];
    }

    if (!data || data.length === 0) {
      return [];
    }

    return data.map(item => ({
      itinerary_id: item.itinerary_id,
      participant_id: item.participant_id,
      name: item.participants.full_name,
      phone: item.participants.phone_number,
      arrival_date: item.arrival_date,
      arrival_time: item.arrival_time,
      arrival_datetime: combineDateTime(item.arrival_date, item.arrival_time),
      transport_number: item.arrival_transport_no,
      location: extractLocation(item),
      raw_ai_data: item.ai_json_extracted
    }));
  } catch (err) {
    console.error("❌ fetchArrivalData exception:", err);
    return [];
  }
}

/**
 * Group arrivals by location
 */
function groupByLocation(arrivals) {
  const groups = {};
  arrivals.forEach(arrival => {
    const location = arrival.location || "Unknown Location";
    
    if (!groups[location]) groups[location] = [];
    groups[location].push(arrival);
  });
  return groups;
}

/**
 * Calculate how many vehicles needed with naive approach
 */
function calculateNaiveVehicleCount(arrivals) {
  // Assume one vehicle per passenger (worst case)
  return arrivals.length;
}

/**
 * Calculate total cost
 */
function calculateTotalCost(groups, avgDistanceKm) {
  let total = 0;
  groups.forEach(group => {
    const costPerKm = COST_PER_KM[group.vehicle_type] || 18;
    total += costPerKm * avgDistanceKm * 2; // Round trip
  });
  return Math.round(total);
}

/**
 * Calculate average wait time across all passengers
 */
function calculateAverageWait(groups) {
  let totalWait = 0;
  let totalPassengers = 0;
  
  groups.forEach(group => {
    totalWait += group.total_wait_time_minutes;
    totalPassengers += group.passenger_count;
  });
  
  return totalPassengers > 0 ? Math.floor(totalWait / totalPassengers) : 0;
}

/**
 * Calculate maximum wait time
 */
function calculateMaxWait(groups) {
  if (!groups.length) return 0;
  return Math.max(...groups.map(g => g.max_wait_time_minutes));
}

/**
 * Count passengers waiting longer than threshold
 */
function countLongWaiters(groups, thresholdMinutes) {
  let count = 0;
  groups.forEach(group => {
    group.passengers_details.forEach(p => {
      if (p.wait_minutes > thresholdMinutes) count++;
    });
  });
  return count;
}

/**
 * Generate driver instructions
 */
function generateDriverInstructions(vehicle, location, passengers, arrivalTime, departureTime) {
  const arrival = new Date(arrivalTime).toLocaleTimeString('en-IN', { 
    hour: '2-digit', minute: '2-digit', hour12: true 
  });
  const departure = new Date(departureTime).toLocaleTimeString('en-IN', { 
    hour: '2-digit', minute: '2-digit', hour12: true 
  });
  
  const passengerList = passengers.map(p => 
    `${p.name} (${new Date(p.pickup_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })})`
  ).join(", ");

  return `${vehicle.vehicle_name} - Arrive at ${location} by ${arrival}. ` +
         `Pick up ${passengers.length} passengers between ${arrival} and ${departure}. ` +
         `Passengers: ${passengerList}. ` +
         `Depart at ${departure}. ` +
         `Contact: ${passengers[0].name} (${passengers[0].phone}).`;
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
      throw new Error(`Invalid datetime: ${dateStr} ${timeStr}`);
    }

    return dt; // ✅ RETURN DATE OBJECT
  } catch (err) {
    console.error("Error combining date/time:", err);
    return null;
  }
}

/**
 * Extract location from itinerary record
 */
function extractLocation(itineraryRecord) {
  if (itineraryRecord.arrival_location) {
    return extractDetailedLocation(itineraryRecord.arrival_location);
  }
  
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
  
  const transportNum = itineraryRecord.transport_number || "";
  if (/^(AI|6E|UK|SG|G8)/i.test(transportNum)) return "Airport";
  if (/^\d{5}$/i.test(transportNum)) return "Railway Station";
  
  return "Unknown Location";
}

/**
 * ENHANCED: Extract detailed location with terminal/sub-location support
 * Handles ALL variations: Terminal 1, T1, IGI Terminal 1, Delhi T1, etc.
 */
function extractDetailedLocation(locationString) {
  if (!locationString) return "Unknown Location";
  
  const loc = locationString.toLowerCase().trim();
  
  // ✅ Airport with terminal/sub-location
  if (loc.includes('airport') || loc.includes('terminal') || /\bt\d+\b/.test(loc) || loc.includes('igi')) {
    
    // COMPREHENSIVE terminal number detection (handles ALL variations)
    // Matches: T1, T2, T3, Terminal 1, Terminal 2, Terminal 3, etc.
    const terminalMatch = loc.match(/\bt(\d+)\b|terminal\s*(\d+)/i);
    
    if (terminalMatch) {
      const termNum = terminalMatch[1] || terminalMatch[2];
      return `Airport Terminal ${termNum}`;
    }
    
    // Check for domestic/international
    if (loc.includes('international')) {
      return 'Airport International';
    }
    if (loc.includes('domestic')) {
      return 'Airport Domestic';
    }
    
    // Check for city-specific airport (without terminal)
    const cityMatch = loc.match(/(\w+)\s+airport/i);
    if (cityMatch && cityMatch[1] && cityMatch[1] !== 'airport') {
      const city = cityMatch[1].charAt(0).toUpperCase() + cityMatch[1].slice(1);
      return `${city} Airport`;
    }
    
    // Generic fallback
    return 'Airport';
  }
  
  // ✅ Railway with station name
  if (loc.includes('railway') || loc.includes('station') || loc.includes('train')) {
    const stationMatch = loc.match(/(\w+)\s+(railway|station)/i);
    if (stationMatch && stationMatch[1] && stationMatch[1] !== 'railway' && stationMatch[1] !== 'train') {
      const station = stationMatch[1].charAt(0).toUpperCase() + stationMatch[1].slice(1);
      return `${station} Railway Station`;
    }
    return 'Railway Station';
  }
  
  if (loc.includes('bus')) return 'Bus Station';
  
  return locationString;
}

/**
 * Normalize location names (now uses enhanced extraction)
 */
function normalizeLocationKey(location) {
  if (!location) return null;
  const loc = location.toLowerCase();

  if (loc.includes('t1') || loc.includes('terminal 1')) return 'airport_terminal_1';
  if (loc.includes('t3') || loc.includes('terminal 3')) return 'airport_terminal_3';
  if (loc.includes('railway') || loc.includes('railway station')) {
  return 'railway_station';
}


  if (loc.includes('airport')) return 'airport';
  return loc.replace(/\s+/g, '_');
}


export { COST_PER_KM };