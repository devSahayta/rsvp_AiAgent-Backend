// routes/uploadRoutes.js
import express from "express";
import multer from "multer";
import {
  submitUpload,
  getUploadsByParticipant,
  updateUpload,
  getConversationByParticipant,
  updateConversation,
  getSignedDocumentUrl,
} from "../controllers/uploadController.js";

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

// Upload file(s) (protected by authenticateUser from app.js)
router.post("/", upload.any(), submitUpload);

// Fetch uploads for participant (protected)
router.get("/:participant_id", getUploadsByParticipant);

// Update upload (protected)
router.put("/:uploadId", upload.single("file"), updateUpload);

// Conversation routes
router.get("/conversation/:participantId", getConversationByParticipant);
router.put("/conversation/:participantId", updateConversation);

// Signed URL (protected) - ensure extractKindeUser + authenticateUser are applied in app.js
router.post("/signed-url", getSignedDocumentUrl);

export default router;
