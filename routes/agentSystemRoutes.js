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

//CRUD routes for user agents
router.post("/create", createAgent);
router.get("/user/:user_id", getUserAgents);
router.get("/:agent_id", getAgentDetails);
router.delete("/:agent_id", deleteAgentComplete);

//For Testing Agents

// For Voice Agent
router.post("/:agent_id/test-voice", testVoiceAgent);

//test route for chatbot
router.post("/:agent_id/test-chat", testChatAgent);

router.get("/test-sessions/:session_id", getTestSession);
router.get("/test-sessions", getUserTestSessions);

//sync voice test status
router.post("/test-sessions/sync/:conversation_id", syncVoiceTestStatus);

export default router;
