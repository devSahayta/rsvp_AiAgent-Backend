import express from "express";
import { verifyWebhook, handleIncomingMessage,sendBatchInitialMessage} from "../controllers/whatsappController.js";
import {authenticateUser}from"../middleware/authMiddleware.js"

const router = express.Router();

router.get("/whatsapp/webhook", verifyWebhook);
router.post("/whatsapp/webhook", handleIncomingMessage);
router.post("/whatsapp/send-batch", authenticateUser,sendBatchInitialMessage);

export default router;
