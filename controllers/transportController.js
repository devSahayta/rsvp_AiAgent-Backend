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