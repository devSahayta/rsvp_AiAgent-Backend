import express from "express";
import { submitUpload, getUploadsByParticipant, updateUpload } from "../controllers/uploadController.js";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

// Upload endpoint (already exists)
router.post("/", upload.any(), submitUpload);

// ✅ New route to fetch all uploads for a participant
router.get("/:participant_id", getUploadsByParticipant);

router.put("/:uploadId", upload.single("file"), updateUpload);

export default router;
