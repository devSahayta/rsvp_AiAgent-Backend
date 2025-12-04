// routes/chatRoutes.js
import express from "express";
import * as chatCtrl from "../controllers/chatController.js";
import { authenticateUser } from "../middleware/authMiddleware.js"; // optional

const router = express.Router();

/**
 * GET /api/events/:eventId/chats
 * Query: ?limit=50&offset=0
 */
router.get("/events/:eventId/chats", async (req, res) => {
  try {
    const { eventId } = req.params;
    const limit = parseInt(req.query.limit || "100", 10);
    const offset = parseInt(req.query.offset || "0", 10);

    const chats = await chatCtrl.getChatsForEvent({ event_id: eventId, limit, offset });
    return res.json({ ok: true, chats });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
});

/**
 * GET /api/chats/:chatId/messages
 * Query: ?limit=50&before=<ISO timestamp>
 */
router.get("/chats/:chatId/messages", async (req, res) => {
  try {
    const { chatId } = req.params;
    const limit = parseInt(req.query.limit || "50", 10);
    const before = req.query.before || null;

    const messages = await chatCtrl.getMessagesForChat({ chat_id: chatId, limit, before });
    return res.json({ ok: true, messages });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
});

/**
 * POST /api/chats/:chatId/messages
 * Body: { sender_type, message, message_type, media_path }
 * Allows admin/dashboard to post messages (also persists and updates chat preview)
 */
router.post("/chats/:chatId/messages", async (req, res) => {
  try {
    const { chatId } = req.params;
    const { sender_type = "admin", message = "", message_type = "text", media_path = "null" } = req.body;

    const row = await chatCtrl.saveMessage({
      chat_id: chatId,
      sender_type,
      message,
      message_type,
      media_path
    });

    return res.json({ ok: true, message: row });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
});

export default router;
