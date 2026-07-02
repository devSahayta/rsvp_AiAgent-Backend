// routes/eventRoutes.js — Final version with assistant routes correctly ordered

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
  upsertFollowupRule,
  getFollowupRule,
  getFollowupStatusForEvent,
  syncFollowupStatus,
} from "../controllers/eventFollowupController.js";

import {
  getParticipantTranscript,
  getParticipantAudio,
} from "../controllers/transcriptController.js";

import {
  assistantCreateEvent,
  assistantUploadCsv,
} from "../controllers/assistantEventController.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT: Static string routes MUST come before /:eventId param routes
// otherwise Express matches "assistant-create" as an eventId param.
// ─────────────────────────────────────────────────────────────────────────────

// ── Assistant routes ──────────────────────────────────────────────────────────
// Internal server-to-server call — no authenticateUser (user_id in body)
router.post("/assistant-create", assistantCreateEvent);

// ── Smart fields (static path — before /:eventId) ────────────────────────────
router.post("/rsvp-responses", saveRsvpResponses);

// ── Standard event CRUD ───────────────────────────────────────────────────────
router.post("/", upload.single("dataset"), createEventWithCsv);
router.get("/", getEventsByUser);

// ── Param routes (:eventId) ───────────────────────────────────────────────────
router.get("/:eventId", getEventById);

// CSV upload from assistant frontend (frontend sends JWT → authenticateUser works)
router.post(
  "/:eventId/upload-csv",
  authenticateUser,
  upload.single("dataset"),
  assistantUploadCsv,
);

// Batch
router.post("/:eventId/call-batch", triggerBatchCall);
router.post("/:eventId/retry-batch", retryBatchCall);
router.post("/:eventId/sync-batch-status", syncBatchStatuses);
router.get("/:eventId/batch-status", getBatchStatus);

// RSVP
router.get("/:eventId/rsvps", getRSVPDataByEvent);
router.get("/:eventId/rsvp-data", getEventRSVPData);

// Participants
router.get("/:event_id/participants", getEventParticipants);

// Transcript + Audio
router.get(
  "/:eventId/participants/:participantId/transcript",
  getParticipantTranscript,
);
router.get("/:eventId/participants/:participantId/audio", getParticipantAudio);

// Details / conversation
router.get("/:eventId/details", authenticateUser, getEventDetails);
router.get(
  "/:eventId/conversation-status",
  authenticateUser,
  getConversationStatus,
);

// Dashboard
router.get("/:eventId/dashboard", getDashboardData);

// Smart fields
router.get("/:eventId/smart-fields", getEventSmartFields);
router.get("/:eventId/smart-rsvp-data", getSmartRsvpData);

// Follow-up rule
router.post("/:eventId/followup-rule", upsertFollowupRule);
router.get("/:eventId/followup-rule", getFollowupRule);
router.get("/:eventId/followup-status", getFollowupStatusForEvent);
router.post("/:eventId/followup-status/sync", syncFollowupStatus);

// Delete
router.delete("/:eventId", deleteEvent);

export default router;
