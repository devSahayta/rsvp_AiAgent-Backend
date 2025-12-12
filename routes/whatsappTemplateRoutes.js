// routes/whatsappTemplateRoutes.js
import express from "express";
import multer from "multer";
import {
  createTemplate,
  createUploadSession,
  uploadBinaryToSession,
  checkTemplateStatus,
  listTemplates,
  sendTemplate,
  sendTemplateBulk,
  uploadMedia,
  listMedia,
  deleteMedia,
  listMetaTemplates,
  mediaProxy,
  mediaProxyUrl,
  getSingleMetaTemplate,
  deleteMetaTemplate,
} from "../controllers/whatsappTemplateController.js";
// import fetch from "node-fetch";

const upload = multer(); // in-memory buffer

const router = express.Router();

// CLEAN ENDPOINTS — easy to use
router.post("/create", createTemplate);
router.post("/create-upload-session", createUploadSession);
router.post("/upload-binary", upload.single("file"), uploadBinaryToSession);
router.post("/upload-media", upload.single("file"), uploadMedia);
router.get("/:wt_id/status", checkTemplateStatus);
router.get("/", listTemplates);
// sending template;
router.post("/send/:templateId", sendTemplate);

//sending bulk template (more than one)
router.post("/send-bulk/:templateId", sendTemplateBulk);

router.get("/media/list", listMedia);
router.delete("/media/:wmu_id", deleteMedia);

//list all template from meta
router.get("/meta/list", listMetaTemplates);

//get single template details
router.get("/meta/template", getSingleMetaTemplate);
// router.get("/meta/template-name/:templateName", getMetaTemplateByName);

//get proxy url for uploaded media file
router.get("/media-proxy/:mediaId", mediaProxy);

//get url for the template placeholder image
router.get("/media-proxy-url", mediaProxyUrl);

// DELETE template from Meta
router.delete("/meta/:templateId", deleteMetaTemplate);

export default router;
