// routes/whatsappRoutes.js
import express from "express";
import {
  verifyWebhook,
  handleIncomingMessage,
  startInitialMessage,
  sendBatchInitialMessage,
  handleSamvaadikWebhook,
} from "../controllers/whatsappController.js";
import { authenticateUser } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/whatsapp/webhook", verifyWebhook);
router.post("/whatsapp/webhook", handleIncomingMessage);
router.post("/whatsapp/send-batch", sendBatchInitialMessage);
router.post("/whatsapp/start-initial-message", startInitialMessage);

// Samvaadik forwarded webhooks
router.post("/whatsapp/samvaadik-webhook", handleSamvaadikWebhook);

export default router;
