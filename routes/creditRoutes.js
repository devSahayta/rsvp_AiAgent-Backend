import express from "express";
import { 
  reduceCreditsAfterCall, 
  reduceCreditsForBatch,
  reduceCreditsUsingElevenLabsAPI  // ✅ NEW
} from "../controllers/creditController.js";

const router = express.Router();

router.post("/reduce", reduceCreditsAfterCall);
router.post("/reduce-batch", reduceCreditsForBatch);
router.post("/reduce-batch-elevenlabs", reduceCreditsUsingElevenLabsAPI); // ✅ NEW

export default router;