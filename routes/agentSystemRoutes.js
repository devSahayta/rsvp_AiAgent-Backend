//routes/agentSystemRoutes.js
import express from "express";
import {
  getAgentTemplates,
  getAgentTemplate,
  createAgent,
  getUserAgents,
  getAgentDetails,
  deleteAgentComplete,
} from "../controllers/agentSystemController.js";
import {
  getTestSession,
  getUserTestSessions,
  syncVoiceTestStatus,
  testChatAgent,
  testVoiceAgent,
} from "../controllers/agentTestController.js";

const router = express.Router();
// Template routes
router.get("/templates", getAgentTemplates);
router.get("/templates/:template_id", getAgentTemplate);

// For Testing Agents
router.post("/:agent_id/test-voice", testVoiceAgent);
router.post("/:agent_id/test-chat", testChatAgent);

router.get("/test-sessions", getUserTestSessions);
router.get("/test-sessions/:session_id", getTestSession);
router.post("/test-sessions/:batch_id/sync", syncVoiceTestStatus);

// CRUD routes
router.post("/create", createAgent);
router.get("/user/:user_id", getUserAgents);

// ALWAYS KEEP THIS LAST
router.get("/:agent_id", getAgentDetails);
router.delete("/:agent_id", deleteAgentComplete);

export default router;
