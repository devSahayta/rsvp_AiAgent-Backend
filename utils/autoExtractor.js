// utils/autoExtractor.js - UPDATED WITH PDF SUPPORT
import { extractTextFromDocument, extractTravelInfo } from "../utils/travelDocExtractor.js";
import { extractTextFromPDFUrl } from "../utils/pdfExtractor.js";

/**
 * Detect if URL is a PDF based on extension or content-type
 * @param {string} url 
 * @returns {boolean}
 */
function isPdfUrl(url) {
  return url.toLowerCase().includes('.pdf') || 
         url.toLowerCase().includes('application/pdf');
}

/**
 * Main function: Extract structured travel data from image OR PDF
 * @param {Object} params
 * @param {string} params.documentUrl - Public URL (image or PDF)
 * @returns {Promise<{success: boolean, extractedData?: object, rawText?: string, error?: string}>}
 */
export async function autoExtractFromImage({ documentUrl }) {
  try {
    console.log("📄 Auto extraction: Starting...");

    let rawText = '';

    // 🔥 Step 1: Extract raw text (PDF or Image)
    if (isPdfUrl(documentUrl)) {
      console.log("📄 Detected PDF document");
      const pdfResult = await extractTextFromPDFUrl(documentUrl);
      
      if (!pdfResult.success) {
        return {
          success: false,
          error: `PDF extraction failed: ${pdfResult.error}`
        };
      }
      
      rawText = pdfResult.text;
      console.log(`✅ PDF extracted: ${rawText.length} characters`);
    } else {
      console.log("🖼️ Detected image document");
      rawText = await extractTextFromDocument(documentUrl);
      console.log(`✅ Image extracted: ${rawText.length} characters`);
    }

    if (!rawText || rawText.trim().length === 0) {
      return {
        success: false,
        error: "No text found in document"
      };
    }

    // Normalize text for pattern matching
    const text = rawText.toUpperCase();

    // -------------------------------
    // Step 2 — Auto-detect transport type
    // -------------------------------
    let transportType = "Flight Ticket";

    const isFlight =
      /FLIGHT|BOARDING|GATE|AIRLINES|TERMINAL|PNR|AIR INDIA|INDIGO|EMIRATES|6E|AI|EK|QR|UK/.test(text);

    const isTrain =
      /TRAIN|IRCTC|COACH|BERTH|RAILWAY|TRAIN NO|TRAIN NUMBER|\b\d{5}\b/.test(text);

    const isBus =
      /BUS|BOARDING POINT|DROPPING POINT|SEAT NO|PLATFORM/.test(text);

    if (isTrain) transportType = "Train Ticket";
    else if (isBus) transportType = "Bus Ticket";
    else if (isFlight) transportType = "Flight Ticket";

    console.log("🚆 Auto-detected transport type:", transportType);

    // -------------------------------
    // Step 3 — Auto-detect direction
    // -------------------------------
    let direction = "Departure";

    const arrivalMatch =
      /ARRIVAL|ARRIVE|ETA|ARRIVING/.test(text);

    const departureMatch =
      /DEPART|DEPARTURE|BOARDING|ETD|GATE/.test(text);

    if (arrivalMatch && !departureMatch) direction = "Arrival";
    if (departureMatch && !arrivalMatch) direction = "Departure";

    console.log("➡️ Auto-detected direction:", direction);

    // -------------------------------
    // Step 4 — Run full extraction with detected params
    // -------------------------------
    const result = await extractTravelInfo(
      documentUrl,
      transportType,
      direction
    );

    return result;

  } catch (error) {
    console.error("❌ Auto extraction error:", error);
    return {
      success: false,
      error: error.message
    };
  }
}