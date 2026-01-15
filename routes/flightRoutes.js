import express from "express";
import {
  getEventFlights,
  refreshEventFlightStatuses,
} from "../controllers/flightController.js";

const router = express.Router();

/**
 * Get all cached flight statuses for an event
 */
router.get("/event/:eventId", getEventFlights);

/**
 * Manually refresh flight status for a participant
 * (restricted to once every 6 hours)
 */

router.post("/event/:eventId/refresh", refreshEventFlightStatuses);

export default router;
