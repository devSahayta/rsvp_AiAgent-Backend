import express from "express";
import {
  reduceCreditsAfterCall,
  reduceCreditsForBatch,
  reduceCreditsUsingElevenLabsAPI, // ✅ NEW
} from "../controllers/creditController.js";

import { getCreditLogs } from "../controllers/creditController.js";

import { getCreditPackages } from "../controllers/creditController.js";

import {
  initiatePurchaseHandler,
  verifyPurchaseHandler,
  razorpayWebhookHandler,
  getPurchaseHistoryHandler,
} from "../controllers/creditPurchaseController.js";
import { authenticateUser } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/reduce", reduceCreditsAfterCall);
router.post("/reduce-batch", reduceCreditsForBatch);
router.post("/reduce-batch-elevenlabs", reduceCreditsUsingElevenLabsAPI); // ✅ NEW

router.post("/purchase/initiate", authenticateUser, initiatePurchaseHandler);
router.post("/purchase/verify", authenticateUser, verifyPurchaseHandler);
router.get("/purchase/history", authenticateUser, getPurchaseHistoryHandler);
router.get("/packages", authenticateUser, getCreditPackages);
router.get("/logs", authenticateUser, getCreditLogs);

export default router;
