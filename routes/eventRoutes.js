// // routes/eventRoutes.js

// import { deleteEvent } from "../controllers/eventController.js";

// import express from "express";
// import multer from "multer";
// import {
//   createEventWithCsv,
//   getEventsByUser,
//   getEventById,
//   getEventRSVPData,
//   getEventDetails,
//   getConversationStatus,
// } from "../controllers/eventController.js";

// import { authenticateUser } from "../middleware/authMiddleware.js";

// import {
//   triggerBatchCall,
//   getRSVPDataByEvent,
//   retryBatchCall,
//   syncBatchStatuses,
//   getBatchStatus,
//   getDashboardData,
// } from "../controllers/eventController.js";

// const router = express.Router();
// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: { fileSize: 10 * 1024 * 1024 },
// }); // 10MB

// // Create event + upload CSV + parse and insert participants
// // multipart/form-data fields: user_id, event_name, event_date, dataset(file)
// router.post("/", upload.single("dataset"), createEventWithCsv);

// // Get all events for a user: /api/events?user_id=kp_xxx
// router.get("/", getEventsByUser);

// // Get single event by id
// router.get("/:eventId", getEventById);

// router.post("/:eventId/call-batch", triggerBatchCall);
// // Get RSVP data for a single event
// router.get("/:eventId/rsvps", getRSVPDataByEvent);
// router.post("/:eventId/retry-batch", retryBatchCall);
// router.post("/:eventId/sync-batch-status", syncBatchStatuses);

// router.get("/:eventId/batch-status", getBatchStatus);

// router.get("/:eventId/rsvp-data", getEventRSVPData);

// router.get("/:eventId", authenticateUser, getEventDetails);
// router.get(
//   "/:eventId/conversation-status",
//   authenticateUser,
//   getConversationStatus
// );
// router.get("/:eventId/dashboard", getDashboardData);
// router.delete("/:eventId", deleteEvent);

// export default router;

// --------------------------updated router ----------------------------------------------

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
  getEventParticipants,
  triggerBatchCall,
  getRSVPDataByEvent,
  retryBatchCall,
  syncBatchStatuses,
  getBatchStatus,
  getDashboardData,
  deleteEvent,
} from "../controllers/eventController.js";

import { authenticateUser } from "../middleware/authMiddleware.js";

import {
  getEventSmartFields,
  getSmartRsvpData,
  saveRsvpResponses,
} from "../controllers/smartFieldController.js";

import {
  getParticipantTranscript,
  getParticipantAudio,
} from "../controllers/transcriptController.js";

const router = express.Router();

// File upload config
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ---------- ROUTES ----------

// Create event + CSV upload
router.post("/", upload.single("dataset"), createEventWithCsv);

// Get user events
router.get("/", getEventsByUser);

// Smart fields endpoints (keep before /:eventId to avoid conflict)
router.post("/rsvp-responses", saveRsvpResponses);

// Get single event by ID
router.get("/:eventId", getEventById);

// Batch operations
router.post("/:eventId/call-batch", triggerBatchCall);
router.post("/:eventId/retry-batch", retryBatchCall);
router.post("/:eventId/sync-batch-status", syncBatchStatuses);
router.get("/:eventId/batch-status", getBatchStatus);

// RSVP data
router.get("/:eventId/rsvps", getRSVPDataByEvent);
router.get("/:eventId/rsvp-data", getEventRSVPData);

// Participants
router.get("/:event_id/participants", getEventParticipants);

// Transcript + Audio — per participant
router.get(
  "/:eventId/participants/:participantId/transcript",
  getParticipantTranscript,
);
router.get("/:eventId/participants/:participantId/audio", getParticipantAudio);

// Event details (Protected)
router.get("/:eventId/details", authenticateUser, getEventDetails);

// Conversation tracking
router.get(
  "/:eventId/conversation-status",
  authenticateUser,
  getConversationStatus,
);

// Dashboard data
router.get("/:eventId/dashboard", getDashboardData);

// Smart fields
router.get("/:eventId/smart-fields", getEventSmartFields);
router.get("/:eventId/smart-rsvp-data", getSmartRsvpData);

// DELETE event
router.delete("/:eventId", deleteEvent);

export default router;
