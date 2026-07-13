// routes/internalRoutes.js
import express from "express";
import { internalAuth } from "../middleware/internalAuth.js";
import { runAutomationById } from "../controllers/internalAutomationController.js";

const router = express.Router();
router.use(internalAuth);

// POST /internal/automations/:id/run
router.post("/automations/:id/run", runAutomationById);

export default router;
