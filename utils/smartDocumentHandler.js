// utils/smartDocumentHandler.js
//
// Handles `document` and `travel_ticket` smart field types for the
// WhatsApp smart-fields engine (agentChatEngine.js).
//
//  - `document` fields just store the upload — no extraction. Same as
//    classic's `id_proof` handling.
//  - `travel_ticket` fields run a 2-step arrival → return sub-sequence,
//    same as classic's `awaiting_travel_doc_upload` state — modeled as
//    ONE smart field entry, direction tracked via session.field_state
//    rather than two separately-configured fields.
//
// Reuses the EXACT SAME storage functions your classic flow uses
// (imported from documentStorage.js — no duplicated logic, no schema
// drift) and the EXACT SAME extraction pipeline (autoExtractFromImage).

import { autoExtractFromImage } from "./autoExtractor.js";
import { saveUploadRow, saveTravelItinerary } from "./documentStorage.js";

// NEW — lets a guest text their way out of a document/travel_ticket field
// instead of getting stuck forever if they genuinely don't have the file
// (e.g. one-way travelers with no return ticket). Matched only inside the
// document/travel_ticket branch, so it can't misfire on normal answers
// elsewhere in the conversation.
const SKIP_PATTERNS =
  /\b(skip|no return|not having|don'?t have|dont have|do not have|does ?n'?t have|none|no ticket|n\/a|not applicable|one way|oneway|only.*arrival)\b/i;

function isSkipIntent(userMessage) {
  if (!userMessage) return false;
  const trimmed = userMessage.trim();
  if (/^(no|nope|nah)$/i.test(trimmed)) return true;
  return SKIP_PATTERNS.test(trimmed);
}

/**
 * Handle one turn on a document/travel_ticket field.
 *
 * @returns {{
 *   reply: string,
 *   collected: boolean,   // true = field is fully done, safe to advance
 *   value: any,           // value to store in collected_answers if collected
 *   advance: boolean,
 *   newFieldState: object // what to persist to session.field_state
 * }}
 */
export async function handleDocumentField({
  field, // current smart field row
  mediaUrl, // fetchable URL used for OCR extraction (Samvaadik's raw URL or a signed WA URL) — NOT necessarily a path in our own bucket
  storagePath, // NEW — bucket-relative path inside `participant-docs`, produced by re-uploading the media there. This is what gets stored as uploads.document_url, matching classic's behavior exactly, so the existing Document Viewer / signed-url endpoint works unchanged.
  userMessage, // raw text the guest sent, used for skip detection
  fieldState, // session.field_state — {} or { travel_direction: 'arrival' }
  participantId,
  eventId,
  guestName,
}) {
  const isTravel = field.field_type === "travel_ticket";

  // ── Guest sent text instead of the requested file ─────────────────────────
  if (!mediaUrl) {
    if (isTravel) {
      const direction = fieldState?.travel_direction || "arrival";

      // NEW — skip escape hatch
      if (isSkipIntent(userMessage)) {
        if (direction === "return") {
          // Has arrival, no return — field is done, move on.
          return {
            reply: `No problem, ${guestName} — got your Arrival ticket, skipping the Return ticket. ✅`,
            collected: true,
            value: "arrival_only",
            advance: true,
            newFieldState: {},
          };
        }
        // direction === "arrival" — no tickets at all, skip the whole field.
        return {
          reply: `No problem, ${guestName} — skipping travel ticket collection. ✅`,
          collected: true,
          value: "skipped",
          advance: true,
          newFieldState: {},
        };
      }

      const label = direction === "arrival" ? "Arrival" : "Return";
      return {
        reply: `Please send your ${label} ticket as an image or PDF, or reply "skip" if you don't have one 📤`,
        collected: false,
        value: null,
        advance: false,
        newFieldState: { travel_direction: direction },
      };
    }

    // NEW — skip escape hatch for generic document fields too
    if (isSkipIntent(userMessage)) {
      return {
        reply: `No problem, ${guestName} — skipping that. ✅`,
        collected: true,
        value: "skipped",
        advance: true,
        newFieldState: {},
      };
    }

    return {
      reply: `Please upload the document (${field.field_label}) as an image or PDF, or reply "skip" if you don't have it 📤`,
      collected: false,
      value: null,
      advance: false,
      newFieldState: {},
    };
  }

  // ── Generic document field — store only, no extraction ────────────────────
  if (!isTravel) {
    const uploadResult = await saveUploadRow({
      participant_id: participantId,
      participant_relatives_name: guestName,
      document_url: storagePath || mediaUrl, // prefer our own bucket path; fall back to raw URL only if re-upload failed
      document_type: field.field_label || "Document",
      role: "Self",
    });
    return {
      reply: `Got it, ${guestName}! ✅ ${field.field_label} received.`,
      collected: true,
      value: uploadResult?.[0]?.upload_id || mediaUrl,
      advance: true,
      newFieldState: {},
    };
  }

  // ── Travel ticket — arrival → return sub-sequence ──────────────────────────
  const direction = fieldState?.travel_direction || "arrival";
  const docLabel = direction === "arrival" ? "Arrival Ticket" : "Return Ticket";

  const uploadResult = await saveUploadRow({
    participant_id: participantId,
    participant_relatives_name: guestName,
    document_url: storagePath || mediaUrl, // prefer our own bucket path; fall back to raw URL only if re-upload failed
    document_type: docLabel,
    role: "Self",
  });

  const extraction = await autoExtractFromImage({ documentUrl: mediaUrl });
  if (extraction.success && uploadResult?.[0]?.upload_id) {
    await saveTravelItinerary({
      participant_id: participantId,
      upload_id: uploadResult[0].upload_id,
      event_id: eventId,
      extractedData: extraction.extractedData,
      direction,
      document_type: docLabel,
      participant_relatives_name: guestName,
    });
  } else if (!extraction.success) {
    console.warn(
      `[smartDocumentHandler] Extraction failed for ${docLabel}:`,
      extraction.error,
    );
    // Upload is still recorded even if OCR fails — never block the guest.
  }

  if (direction === "arrival") {
    return {
      reply: `Arrival ticket received! ✅ Now please send your Return ticket, or reply "skip" if you don't have one 📤`,
      collected: false, // not done yet — still waiting on the return leg
      value: null,
      advance: false,
      newFieldState: { travel_direction: "return" },
    };
  }

  // direction === "return" — both legs done, field complete
  return {
    reply: `Return ticket received! ✅ Got both your travel tickets, ${guestName}.`,
    collected: true,
    value: "both_uploaded",
    advance: true,
    newFieldState: {},
  };
}
