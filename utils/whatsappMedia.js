import axios from "axios";
import fs from "fs";
import path from "path";

export async function downloadMediaFromWhatsApp(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;

  // Step 1: Get media URL
  const urlResp = await axios.get(
    `https://graph.facebook.com/v17.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const downloadUrl = urlResp.data.url;

  // Step 2: Download file
  const result = await axios.get(downloadUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${token}` },
  });

  const folder = "./tempUploads";
  if (!fs.existsSync(folder)) fs.mkdirSync(folder);

  const filePath = path.join(folder, `${mediaId}.jpg`);
  fs.writeFileSync(filePath, result.data);

  return filePath; // local path for Vision OCR
}
