import express from "express";
import { downloadMediaFromWhatsApp } from "../utils/whatsappMedia.js";
import { autoExtractFromImage } from "../utils/autoExtractor.js";

const router = express.Router();

router.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!entry) return res.sendStatus(200);

    // If user uploads an image
    if (entry.type === "image") {
      console.log("📥 Image received from WhatsApp");

      const mediaId = entry.image.id;

      // Step 1: Download image
      const fileUrl = await downloadMediaFromWhatsApp(mediaId);

      // Step 2: Auto extract
      const extractResult = await autoExtractFromImage({
        documentUrl: fileUrl,
        documentType: entry.caption || "Unknown Document",
      });

      // Step 3: Reply to user
      await sendWhatsAppMessage(entry.from, formatExtractResult(extractResult));
    }

    res.sendStatus(200);

  } catch (e) {
    console.error("Webhook error:", e);
    res.sendStatus(500);
  }
});

export default router;
