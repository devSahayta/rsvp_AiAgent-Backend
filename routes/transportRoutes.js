// routes/transportRoutes.js - COST-OPTIMIZED VERSION
import express from 'express';
import {
  addVehicle,
  getVehicles,
  updateVehicle,
  deleteVehicle,
  generatePickupPlan,
  getPickupPlan,
  finalizePlan,
  deletePlan,
  updateDispatchStatus,
  getLocationSummary 
} from '../controllers/transportController.js';

import { exportPlanPDF, exportPlanExcel } from '../controllers/transportExportController.js';

const router = express.Router();

/**
 * VEHICLE MANAGEMENT ROUTES
 */

// Add available vehicle
router.post('/add-vehicle', addVehicle);

// Get all vehicles for an event
router.get('/vehicles/:event_id', getVehicles);

// Update vehicle
router.put('/vehicle/:vehicle_id', updateVehicle);

// Delete vehicle
router.delete('/vehicle/:vehicle_id', deleteVehicle);

/**
 * PICKUP PLAN ROUTES
 */

// Generate cost-optimized pickup plan
router.post('/generate-plan', generatePickupPlan);

// Get pickup plan by event_id
router.get('/plan/:event_id', getPickupPlan);

// Finalize plan
router.post('/finalize/:plan_id', finalizePlan);

// Delete plan
router.delete('/plan/:plan_id', deletePlan);

// Update dispatch status
router.post('/update-status/:group_id', updateDispatchStatus);


// Export routes
router.get('/export/pdf/:plan_id', exportPlanPDF);
router.get('/export/excel/:plan_id', exportPlanExcel);

router.get('/location-summary/:event_id', getLocationSummary);
  
export default router;