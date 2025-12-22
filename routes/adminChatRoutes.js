import express from "express";
import { sendAdminMessage, resumeAIChat } from "../controllers/adminChatController.js";
import { extractKindeUser } from "../middleware/extractKindeUser.js";
import { authenticateUser } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post(
  "/chat/send",
  extractKindeUser,
  authenticateUser,
  sendAdminMessage
);

router.post(
  "/chat/resume-ai",
  extractKindeUser,
  authenticateUser,
  resumeAIChat
);

export default router;
