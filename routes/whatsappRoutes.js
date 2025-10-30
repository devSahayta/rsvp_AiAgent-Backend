import express from "express";
import { verifyWebhook, handleIncomingMessage,sendBatchInitialMessage} from "../controllers/whatsappController.js";

const router = express.Router();

router.get("/whatsapp/webhook", verifyWebhook);
router.post("/whatsapp/webhook", handleIncomingMessage);
router.post("/whatsapp/send-batch", sendBatchInitialMessage);

export default router;
