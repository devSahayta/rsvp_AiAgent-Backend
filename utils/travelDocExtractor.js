// utils/travelDocExtractor.js

import dotenv from "dotenv";
dotenvConfig(); 

import vision from "@google-cloud/vision";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { config as dotenvConfig } from "dotenv";
dotenvConfig(); 

import { extractTextFromPDFUrl } from "./pdfExtractor.js";


// 📌 Robust Google Service Account Loading
let visionClient;

try {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT environment variable is not set");
  }

  // Parse the JSON
  let googleCreds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  
  // 🔐 CRITICAL: Fix private key newlines
  if (googleCreds.private_key) {
    // Replace escaped newlines with actual newlines
    googleCreds.private_key = googleCreds.private_key.replace(/\\n/g, '\n');
  }
  
  // Validate required fields
  const requiredFields = ['type', 'project_id', 'private_key', 'client_email'];
  const missingFields = requiredFields.filter(field => !googleCreds[field]);
  
  if (missingFields.length > 0) {
    throw new Error(`Missing required fields in GOOGLE_SERVICE_ACCOUNT: ${missingFields.join(', ')}`);
  }

  // Initialize Vision Client
  visionClient = new vision.ImageAnnotatorClient({
    credentials: googleCreds
  });
  
  console.log("✅ Google Vision API initialized successfully");
  console.log(`📧 Using service account: ${googleCreds.client_email}`);
  
} catch (error) {
  console.error("❌ Failed to initialize Google Vision API:", error.message);
  console.error("💡 Make sure GOOGLE_SERVICE_ACCOUNT is set correctly in .env");
  throw error;
}


// Initialize Claude client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});


/**
 * Extract text from travel document using Google Cloud Vision API
 * @param {string} fileUrl - URL or path to the document
 * @returns {Promise<string>} - Extracted raw text
 */
export async function extractTextFromDocument(fileUrl) {
  try {
    console.log("📄 Extracting text from document:", fileUrl);

    // Determine if fileUrl is a URL or local path
    let isUrl = false;
    try {
      new URL(fileUrl);
      isUrl = true;
    } catch {}

    // Get file extension safely
    const ext = isUrl
      ? path.extname(new URL(fileUrl).pathname).toLowerCase()
      : path.extname(fileUrl).toLowerCase();

    // ======================================================
    // 📘 FIXED: PDF uses your custom PDF → IMAGE → OCR flow
    // ======================================================
    if (ext === ".pdf") {
      console.log("📘 PDF detected — using PDF → Image → OCR pipeline");

      const pdfResult = await extractTextFromPDFUrl(fileUrl);

      if (!pdfResult.success || !pdfResult.text.trim()) {
        throw new Error(pdfResult.error || "No text extracted from PDF");
      }

      console.log("✅ PDF text extraction completed");
      return pdfResult.text.trim();
    }

    // ================
    // 🖼 IMAGE HANDLING
    // ================
    console.log("🖼 Image detected — using textDetection()");

    const [result] = await visionClient.textDetection(fileUrl);

    const textAnnotation =
      result.fullTextAnnotation?.text ||
      result.textAnnotations?.[0]?.description ||
      "";

    if (!textAnnotation || textAnnotation.trim().length === 0) {
      throw new Error("No text found in the document");
    }

    console.log("✅ Text extraction successful. Length:", textAnnotation.length);
    console.log("📝 Raw text preview:", textAnnotation.substring(0, 200));

    return textAnnotation.trim();

  } catch (error) {
    console.error("❌ Cloud Vision API error:", error);
    throw new Error(`Text extraction failed: ${error.message}`);
  }
}



/**
 * Parse extracted text using Claude to structure travel information
 * @param {string} rawText - Raw text from Cloud Vision
 * @param {string} transportType - "Flight Ticket" | "Train Ticket" | "Bus Ticket"
 * @param {string} direction - "Arrival" | "Departure"
 * @returns {Promise<Object>} - Structured travel data
 */
export async function parseTextWithClaude(rawText, transportType, direction) {
  try {
    console.log('🤖 Parsing text with Claude...');
    console.log('📋 Transport Type:', transportType);
    console.log('📋 Direction:', direction);

    const isArrival = direction.toLowerCase().includes('arrival');
    const isFlight = transportType.toLowerCase().includes('flight');
    const isTrain = transportType.toLowerCase().includes('train');
    const isBus = transportType.toLowerCase().includes('bus');

    const systemPrompt = `You are a travel document parser. Extract structured information from ${transportType} text.

CRITICAL RULES:
1. Extract ONLY information that is CLEARLY present in the text
2. Use null for any field you cannot find
3. Return ONLY valid JSON, no markdown
4. Date format: YYYY-MM-DD (convert any format to this)
5. Time format: HH:MM in 24-hour format (convert AM/PM to 24-hour)
6. Extract the ${isArrival ? 'ARRIVAL' : 'DEPARTURE'} information

OUTPUT FORMAT:
{
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM or null",
  "location": "Airport/Station name or null",
  "transport_number": "Flight/Train/Bus number or null",
  "from_location": "Departure city/airport or null",
  "to_location": "Arrival city/airport or null",
  "passenger_name": "Name if found or null",
  "pnr": "PNR/Booking reference or null"
}

EXAMPLES OF WHAT TO EXTRACT:

For FLIGHTS:
- Date: Look for "Date of Journey", "Departure Date", "Travel Date"
- Time: Look for "Departure Time", "Arrival Time", "ETD", "ETA"
- Location: Airport codes (DEL, BOM, GOI) or airport names
- Transport number: Flight number like "6E-123", "AI-456", "UK 789"
- From/To: Route like "DEL → GOI" or "Delhi to Goa"

For TRAINS:
- Date: "Date of Journey", "Travel Date"
- Time: Departure/Arrival time
- Location: Station names or codes
- Transport number: Train number like "12345", "Rajdhani Express"
- From/To: Station names

For BUS:
- Date: Travel date
- Time: Departure/Arrival time
- Location: Bus stop/station
- Transport number: Bus number or service
- From/To: Cities/locations`;

    const userPrompt = `Extract ${isArrival ? 'ARRIVAL' : 'DEPARTURE'} information from this ${transportType}:

RAW TEXT:
${rawText}

Remember:
- This is a ${isArrival ? 'ARRIVAL' : 'DEPARTURE'} ticket
- Extract the ${isArrival ? 'arrival' : 'departure'} time and location
- Convert all dates to YYYY-MM-DD format
- Convert all times to HH:MM 24-hour format
- Use null for missing fields

Return ONLY the JSON object, nothing else.`;

    const message = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  temperature: 0,
  system: systemPrompt,
  messages: [
    { role: "user", content: userPrompt }
  ]
});


    // Extract JSON from response
    let responseText = message.content[0].text.trim();
    
    // Remove markdown code blocks if present
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    
    const parsedData = JSON.parse(responseText);
    
    console.log('✅ Claude parsing successful:', parsedData);
    
    return parsedData;
  } catch (error) {
    console.error('❌ Claude parsing error:', error);
    throw new Error(`Text parsing failed: ${error.message}`);
  }
}

/**
 * Main function to extract and parse travel document
 * @param {string} documentUrl - URL/path to the document
 * @param {string} transportType - "Flight Ticket" | "Train Ticket" | "Bus Ticket"
 * @param {string} direction - "Arrival" | "Departure"
 * @returns {Promise<Object>} - Complete extraction result
 */
export async function extractTravelInfo(documentUrl, transportType, direction) {
  try {
    console.log('\n🚀 Starting travel document extraction...');
    console.log('📄 Document:', documentUrl);
    console.log('🚗 Type:', transportType);
    console.log('➡️ Direction:', direction);

    // Step 1: Extract raw text using Cloud Vision
    const rawText = await extractTextFromDocument(documentUrl);

    // Step 2: Parse text using Claude
    const structuredData = await parseTextWithClaude(rawText, transportType, direction);

    // Step 3: Combine results
    const result = {
      success: true,
      rawText: rawText,
      extractedData: structuredData,
      metadata: {
        transportType: transportType,
        direction: direction,
        extractedAt: new Date().toISOString()
      }
    };

    console.log('✅ Extraction complete!');
    return result;

  } catch (error) {
    console.error('❌ Extraction failed:', error);
    return {
      success: false,
      error: error.message,
      rawText: null,
      extractedData: null,
      metadata: {
        transportType: transportType,
        direction: direction,
        extractedAt: new Date().toISOString()
      }
    };
  }
}

/**
 * Helper function to validate extracted data
 * @param {Object} extractedData - Data from parseTextWithClaude
 * @returns {Object} - Validation result
 */
export function validateExtractedData(extractedData) {
  const errors = [];
  const warnings = [];

  // Check required fields based on document type
  if (!extractedData.date) {
    errors.push('Date not found');
  }

  if (!extractedData.time) {
    warnings.push('Time not found');
  }

  if (!extractedData.location) {
    warnings.push('Location not found');
  }

  if (!extractedData.transport_number) {
    warnings.push('Transport number not found');
  }

  return {
    isValid: errors.length === 0,
    errors: errors,
    warnings: warnings,
    completeness: calculateCompleteness(extractedData)
  };
}

/**
 * Calculate data completeness percentage
 * @param {Object} data - Extracted data
 * @returns {number} - Percentage (0-100)
 */
function calculateCompleteness(data) {
  const fields = [
    'date', 'time', 'location', 'transport_number',
    'from_location', 'to_location', 'passenger_name', 'pnr'
  ];
  
  const filledFields = fields.filter(field => data[field] !== null && data[field] !== '').length;
  
  return Math.round((filledFields / fields.length) * 100);
}

// Export all functions
export default {
  extractTravelInfo,
  extractTextFromDocument,
  parseTextWithClaude,
  validateExtractedData,
  calculateCompleteness
};