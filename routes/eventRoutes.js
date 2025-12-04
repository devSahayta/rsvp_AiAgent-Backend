// routes/eventRoutes.js
import express from "express";
import multer from "multer";
import {
  createEventWithCsv,
  getEventsByUser,
  getEventById,
   getEventRSVPData,
   getEventDetails,
   getConversationStatus,

} from "../controllers/eventController.js";

import {authenticateUser} from "../middleware/authMiddleware.js"

import { triggerBatchCall ,getRSVPDataByEvent,retryBatchCall,syncBatchStatuses,getBatchStatus,getDashboardData } from "../controllers/eventController.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// Create event + upload CSV + parse and insert participants
// multipart/form-data fields: user_id, event_name, event_date, dataset(file)
router.post("/", upload.single("dataset"), createEventWithCsv);

// Get all events for a user: /api/events?user_id=kp_xxx
router.get("/", getEventsByUser);

// Get single event by id
router.get("/:eventId", getEventById);

router.post("/:eventId/call-batch", triggerBatchCall);
// Get RSVP data for a single event
router.get("/:eventId/rsvps", getRSVPDataByEvent);
router.post("/:eventId/retry-batch", retryBatchCall);
router.post("/:eventId/sync-batch-status", syncBatchStatuses);

router.get("/:eventId/batch-status", getBatchStatus);

router.get("/:eventId/rsvp-data", getEventRSVPData);

router.get("/:eventId", authenticateUser, getEventDetails);
router.get("/:eventId/conversation-status", authenticateUser, getConversationStatus);
router.get("/:eventId/dashboard", getDashboardData);



export default router;
