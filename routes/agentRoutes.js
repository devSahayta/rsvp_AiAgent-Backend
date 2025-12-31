import express from "express";
import {
  getAgentConfig,
  duplicateAgentForEvent,
  updateAgentKnowledgeBase,
  deleteAgentById,
} from "../controllers/agentController.js";

const router = express.Router();

router.get("/:agentId", getAgentConfig);
router.post("/duplicate", duplicateAgentForEvent);
router.patch("/:agentId/knowledge-base", updateAgentKnowledgeBase);
router.delete("/:agentId", deleteAgentById);

export default router;
