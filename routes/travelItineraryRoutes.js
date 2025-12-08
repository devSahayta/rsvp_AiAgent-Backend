// routes/travelItineraryRoutes.js - NEW FILE
import express from "express";
import {
  getEventTravelItineraries,
  getParticipantTravelItinerary,
  getEventTravelSummary,
  deleteTravelItinerary,getTravelItinerary
} from "../controllers/travelItineraryController.js";

const router = express.Router();

// Get all travel itineraries for an event
router.get("/event/:event_id", getEventTravelItineraries);

// Get travel summary/statistics for an event
router.get("/event/:event_id/summary", getEventTravelSummary);

// Get travel itinerary for a specific participant (all their attendees)
router.get("/participant/:participant_id", getParticipantTravelItinerary);

// Delete a travel itinerary
router.delete("/:itinerary_id", deleteTravelItinerary);

router.get("/travel-itinerary/:participantId", getTravelItinerary);

export default router;