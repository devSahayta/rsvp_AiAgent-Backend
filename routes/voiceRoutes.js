// routes/voiceRoutes.js

import express from "express";

import { getIndianVoices } from "../controllers/voiceController.js";

const router = express.Router();

router.get("/", getIndianVoices);

export default router;
