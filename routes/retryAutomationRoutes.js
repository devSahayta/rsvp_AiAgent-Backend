// routes/retryAutomationRoutes.js
import express from "express";
import {
  getAutomationEligibility,
  listAutomations,
  listAutomationRuns,
  createAutomation,
  updateAutomationStatus,
  deleteAutomation,
} from "../controllers/retryAutomationController.js";

const router = express.Router({ mergeParams: true });

// Mount in app.js as:
//   app.use("/api/events/:eventId/retry-automations", authenticateUser, retryAutomationRoutes);

router.get("/eligibility", getAutomationEligibility);
router.get("/", listAutomations);
router.post("/", createAutomation);
router.get("/:id/runs", listAutomationRuns);
router.patch("/:id", updateAutomationStatus);
router.delete("/:id", deleteAutomation);

export default router;
