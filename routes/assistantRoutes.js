// routes/assistantRoutes.js
// Mount in app.js:
//   import assistantRoutes from "./routes/assistantRoutes.js";
//   app.use("/api/assistant", assistantRoutes);

import express from "express";
import { authenticateUser } from "../middleware/authMiddleware.js";
import { handleAssistantChat } from "../controllers/assistantController.js";

const router = express.Router();

// All routes use the same Kinde auth middleware as the rest of Sutrak
router.use(authenticateUser);

/**
 * POST /api/assistant/chat
 *
 * Body:
 *   {
 *     message: string,              // user's message
 *     conversationHistory: array    // previous turns (send [] for first message)
 *   }
 *
 * Response:
 *   {
 *     reply: string,                // assistant's reply
 *     updatedHistory: array         // send this back next turn
 *   }
 *
 * Note: userId comes from req.user.user_id (set by authenticateUser middleware)
 * No need to pass userId in the body — it's read from the Kinde JWT.
 */
router.post("/chat", handleAssistantChat);

export default router;
