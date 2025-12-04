// utils/pdfExtractor.js - PDF → Image → Text (Clean Approach)
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from 'canvas';
import vision from '@google-cloud/vision';

const visionClient = new vision.ImageAnnotatorClient({
  keyFilename: process.env.GOOGLE_CLOUD_VISION_KEY_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
});

/**
 * Convert PDF first page to PNG image buffer
 * @param {Buffer} pdfBuffer - PDF file as buffer
 * @returns {Promise<Buffer>} - PNG image buffer
 */
async function convertPdfToImage(pdfBuffer) {
  try {
    console.log("🔄 Converting PDF to image...");
    
    // Check page count with pdf-lib
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pageCount = pdfDoc.getPageCount();
    console.log(`📄 PDF has ${pageCount} page(s)`);

    if (pageCount === 0) {
      throw new Error("PDF has no pages");
    }

    // Render with pdfjs-dist
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer)
    });
    
    const pdfDocument = await loadingTask.promise;
    const page = await pdfDocument.getPage(1); // First page only
    
    // High quality rendering
    const viewport = page.getViewport({ scale: 2.0 });
    
    // Create canvas
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    
    // Render PDF page to canvas
    await page.render({
      canvasContext: context,
      viewport: viewport
    }).promise;
    
    // Convert to PNG buffer
    const imageBuffer = canvas.toBuffer('image/png');
    console.log(`✅ PDF converted to PNG (${imageBuffer.length} bytes)`);
    
    return imageBuffer;
    
  } catch (error) {
    console.error("❌ PDF to image conversion error:", error);
    throw error;
  }
}

/**
 * Extract text from PDF by converting to image first
 * Then use Vision API (same as image extraction)
 * @param {Buffer} pdfBuffer - PDF file as buffer
 * @returns {Promise<{success: boolean, text: string, error?: string}>}
 */
export async function extractTextFromPDF(pdfBuffer) {
  try {
    console.log("📄 Starting PDF extraction (PDF → Image → Text)...");

    // Step 1: Convert PDF to image
    const imageBuffer = await convertPdfToImage(pdfBuffer);
    
    // Step 2: Extract text using Vision API (same as image flow)
    console.log("🔍 Running Vision API on rendered image...");
    
    const [result] = await visionClient.textDetection({
      image: { content: imageBuffer }
    });

    const detections = result.textAnnotations;
    
    if (detections && detections.length > 0) {
      const extractedText = detections[0].description.trim();
      console.log(`✅ Text extracted from PDF: ${extractedText.length} characters`);
      return {
        success: true,
        text: extractedText
      };
    }

    console.warn("⚠️ No text found in converted PDF image");
    return {
      success: false,
      text: '',
      error: "No text detected in PDF"
    };

  } catch (error) {
    console.error("❌ PDF extraction failed:", error);
    return {
      success: false,
      text: '',
      error: error.message
    };
  }
}

/**
 * Extract text from PDF URL (download first, then extract)
 * @param {string} pdfUrl - Public URL to PDF
 * @returns {Promise<{success: boolean, text: string, error?: string}>}
 */
export async function extractTextFromPDFUrl(pdfUrl) {
  try {
    console.log("🌐 Downloading PDF from URL...");
    
    const response = await fetch(pdfUrl);
    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const pdfBuffer = Buffer.from(arrayBuffer);
    
    console.log(`✅ PDF downloaded (${pdfBuffer.length} bytes)`);
    
    return await extractTextFromPDF(pdfBuffer);
  } catch (error) {
    console.error("❌ PDF URL extraction error:", error);
    return {
      success: false,
      text: '',
      error: error.message
    };
  }
}