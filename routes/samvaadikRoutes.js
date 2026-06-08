// routes/samvaadikRoutes.js
// Mount in app.js: app.use("/api/samvaadik", samvaadikRoutes)

import express from "express";
import { authenticateUser } from "../middleware/authMiddleware.js";
import {
  connectSamvaadik,
  getSamvaadikStatus,
  verifySamvaadikConnection,
  disconnectSamvaadik,
  getSamvaadikTemplates,
  getSamvaadikTemplateInfo,
  proxyTemplateMedia,
  getSamvaadikTemplateMedia,
  getSamvaadikTemplate,
} from "../controllers/samvaadikConnectionController.js";

const router = express.Router();

router.get("/media-proxy", proxyTemplateMedia);

// All routes require Kinde auth
router.use(authenticateUser);

// POST   /api/samvaadik/connect      → validate key + set webhook + save
router.post("/connect", connectSamvaadik);

// GET    /api/samvaadik/status       → check connection status
router.get("/status", getSamvaadikStatus);

// POST   /api/samvaadik/verify       → re-verify key + retry webhook if failed
router.post("/verify", verifySamvaadikConnection);

// DELETE /api/samvaadik/disconnect   → remove connection
router.delete("/disconnect", disconnectSamvaadik);

router.get("/templates/:wt_id/media", getSamvaadikTemplateMedia); // ← first

router.get("/templates/:wt_id", getSamvaadikTemplateInfo);

// GET    /api/samvaadik/templates    → fetch approved templates from Samvaadik
router.get("/templates", getSamvaadikTemplates);

export default router;
