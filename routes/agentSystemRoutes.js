import express from "express";
import {
  getAgentTemplates,
  getAgentTemplate,
  createAgent,
  getUserAgents,
  getAgentDetails,
  deleteAgentComplete,
} from "../controllers/agentSystemController.js";

const router = express.Router();
// Template routes
router.get("/templates", getAgentTemplates);
router.get("/templates/:template_id", getAgentTemplate);

//CRUD routes for user agents
router.post("/create", createAgent);
router.get("/user/:user_id", getUserAgents);
router.get("/:agent_id", getAgentDetails);
router.delete("/:agent_id", deleteAgentComplete);



export default router;