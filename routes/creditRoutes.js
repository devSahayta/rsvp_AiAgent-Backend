import express from "express";
import {
  reduceCreditsAfterCall,
  reduceCreditsForBatch,
  reduceCreditsUsingElevenLabsAPI, // ✅ NEW
} from "../controllers/creditController.js";

import { getCreditLogs } from "../controllers/creditController.js";
import { authenticateUser } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/reduce", reduceCreditsAfterCall);
router.post("/reduce-batch", reduceCreditsForBatch);
router.post("/reduce-batch-elevenlabs", reduceCreditsUsingElevenLabsAPI); // ✅ NEW

router.get("/logs", authenticateUser, getCreditLogs);

export default router;
