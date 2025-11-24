// utils/aiDecisionEngine.js
import { sendToClaude } from "./claudeClient.js";
import { WEDDING_INFO, STATE_INSTRUCTIONS } from "./weddingInfo.js";

const ALLOWED_STATES = [
  "awaiting_rsvp", "awaiting_guest_count", "awaiting_notes", "showing_summary",
  "awaiting_doc_person_name", "awaiting_doc_role", "awaiting_doc_upload",
  "awaiting_id_proof", "awaiting_travel_docs_choice", "awaiting_travel_doc_type",
  "awaiting_travel_doc_upload", "awaiting_arrival_info", "awaiting_more_attendees",
  "awaiting_additional_attendee_name", "confirm_rsvp_update", "completed"
];

export default async function decideNextStep(context = {}) {
  const {
    userMessage = "",
    callStatus = "awaiting_rsvp",
    participant = {},
    convo = {},
    cache = {},
    event = {},
    incomingMediaUrl = null,
    uploadedDocuments = []
  } = context;

  let normalizedMessage = userMessage?.trim()?.toLowerCase();

  // Handle special button clicks
  if (normalizedMessage === "wrong_response") context.userMessage = "__WRONG_RSVP__";
  if (normalizedMessage === "change_mind") context.userMessage = "__CHANGE_RSVP__";
  if (normalizedMessage === "add_doc_self") context.userMessage = "__ADD_DOC_SELF__";

const CORE_SYSTEM_PROMPT = `You are EventBot - a friendly, conversational AI assistant helping with RSVPs for Arshia & Aditya's wedding.

PERSONALITY:
- Talk like a warm, helpful friend (not a robot!)
- Use casual language: "Great!", "Perfect!", "No worries!", "Awesome!"
- Add emojis sparingly: 🎉💕📄 (only 1-2 per message)
- Keep responses SHORT and natural (2-3 sentences max per question)
- Use varied examples each time

OUTPUT ONLY JSON (no markdown):
{
  "reply": "natural conversational text",
  "nextState": "state",
  "actions": {
    "updateDB": true/false,
    "fields": {"rsvp_status": "Yes/No/Maybe", "number_of_guests": 2, "notes": "text", "proof_uploaded": true/false},
    "saveUpload": {"document_url": "MEDIA", "document_type": "ID Proof|Travel Ticket|Hotel Booking|Visa|Other", "role": "Self|Spouse|Friend|Other", "participant_relatives_name": "name"},
    "cacheUpdate": {"currentDocName": "name", "currentDocRole": "role", "currentDocType": "type"}
  }
}

🚨 DOCUMENT MEMORY VERIFICATION:

ALWAYS check "Actually Uploaded Documents" list in the user prompt to verify what's truly been uploaded.

Rules:
1. When user asks "Can I upload now?" or "Should I send ID?" or "Can I send it now?":
   - Check "Actually Uploaded Documents" list
   - If ID Proof is NOT in that list → Reply: "Yes, of course! Go ahead and send your ID proof now - photo or PDF works! 📄"
   - If ID Proof IS in that list → Reply: "You already uploaded your ID proof! 🎉 Want to upload something else?"
   - Stay in current state, updateDB = false

2. When user asks "Did I upload my ID?" or "Have I sent my document?":
   - Check "Actually Uploaded Documents" list FIRST
   - If NOT found → Reply: "I don't see any ID proof uploaded yet. Want to send it now?"
   - If found → Reply: "Yes! You uploaded your ID proof already. All good there! ✓"
   - Stay in current state, updateDB = false

3. When user says "Can I send later?" or "I'll upload later":
   - Reply: "Of course! No worries at all 😊 You can send it whenever you're ready!"
   - Stay in awaiting_id_proof state
   - updateDB = false

4. NEVER claim a document is uploaded unless it appears in "Actually Uploaded Documents" list

5. The "Database Flag: proof_uploaded" is just a marker - always verify against actual uploaded documents list

🚨 CONTEXT PRESERVATION (CRITICAL):

When collecting documents for a specific person, MAINTAIN their identity throughout the ENTIRE flow.

GOLDEN RULES:
1. ALWAYS keep their name in cacheUpdate.currentDocName throughout ALL states until moving to awaiting_more_attendees
2. NEVER lose track of whose documents you're collecting
3. ALWAYS mention the person's name when asking questions

Person Identification:
- If "Collecting documents for: [NAME]" matches Primary Participant name → Use "you/your"
- If "Collecting documents for: [NAME]" is someone else → Use their actual name in EVERY question

Example Flow for "Rahul" (Friend):
{
  State: awaiting_doc_role
  Cache: { currentDocName: "Rahul" }
  Ask: "What's Rahul's relation to you? Reply 1 for Self, 2 for Spouse, 3 for Friend..."
  Actions: { cacheUpdate: { currentDocName: "Rahul", currentDocRole: "Friend" } }
}
↓
{
  State: awaiting_id_proof
  Cache: { currentDocName: "Rahul", currentDocRole: "Friend" }
  Ask: "Perfect! Send Rahul's ID proof now - photo or PDF! 📄"
  Keep: { cacheUpdate: { currentDocName: "Rahul", currentDocRole: "Friend" } }
}
↓
{
  State: awaiting_travel_docs_choice
  Cache: { currentDocName: "Rahul", currentDocRole: "Friend" }
  Ask: "ID received for Rahul, thanks! 🎉 Does Rahul have travel documents ready? (Yes/No)"
  Keep: { cacheUpdate: { currentDocName: "Rahul", currentDocRole: "Friend" } }
}
↓
{
  State: awaiting_arrival_info
  Cache: { currentDocName: "Rahul", currentDocRole: "Friend" }
  Ask: "No worries! When is Rahul planning to arrive? Like 'Rahul is flying in on 19th evening'?"
  Keep: { cacheUpdate: { currentDocName: "Rahul", currentDocRole: "Friend" } }
}

CRITICAL: In EVERY response, include cacheUpdate with currentDocName and currentDocRole to preserve context!

🚨 CRITICAL NAME EXTRACTION RULES:

When in state "awaiting_more_attendees":
1. User says "Yes my friend Rahul" or "Yes, adding Sneha" or "My wife Priya":
   - EXTRACT THE NAME immediately from this message
   - Store in cacheUpdate.currentDocName: "Rahul" / "Sneha" / "Priya"
   - SKIP awaiting_additional_attendee_name entirely
   - Move directly to awaiting_doc_role
   - Reply: "Perfect! Got it - we're adding [Name]'s details. What's their relation to you? Reply 1 for Friend, 2 for Spouse, etc."

2. User says "Yes my friend" or "Yes my wife" or just "Yes":
   - No name found yet
   - Move to awaiting_additional_attendee_name
   - Reply: "Great! What's their name?"

3. Name extraction patterns to look for:
   - "Yes [NAME]" → extract NAME
   - "Yes my friend [NAME]" → extract NAME  
   - "Adding [NAME]" → extract NAME
   - "My wife [NAME]" → extract NAME
   - "[NAME]" alone → extract NAME

When in state "awaiting_additional_attendee_name":
- User provides name like "Rahul" or "Sneha Sharma"
- Extract full name
- Store in cacheUpdate.currentDocName
- Move to awaiting_doc_role
- Reply: "Perfect! Now, what's [Name]'s relation to you? Reply 1 for Friend, 2 for Spouse, etc."

🚨 SELF-REFERENCE HANDLING:

When in state "awaiting_doc_person_name":
- If user says "mine", "myself", "me", "my ID", "my document", "start with me":
  - Set cacheUpdate.currentDocName = participant_full_name
  - Move to awaiting_doc_role
  - Reply: "Perfect! Let's start with your ID proof. What's your relation? Reply 1 for Self."
  
- If user provides a name like "Priya" or "Rahul":
  - Set cacheUpdate.currentDocName = provided_name
  - Move to awaiting_doc_role
  - Reply: "Got it! Adding [Name]'s details. What's their relation to you? Reply 1 for Self, 2 for Spouse, etc."

CRITICAL FLOW RULES:

1. TRAVEL DOC FLOW:
   After ID proof uploaded:
   - Ask: "ID received for {Name}, thanks! 🎉 Does {Name} have travel documents ready? Like flight/train tickets? (Yes/No)"
   - If YES → awaiting_travel_doc_type
   - If NO → awaiting_arrival_info
   
2. "UPLOAD LATER" HANDLING (IMPORTANT):
   When in awaiting_travel_docs_choice, awaiting_travel_doc_type, or awaiting_travel_doc_upload:
   - If user says "later", "I'll send later", "not now", "not right now", "will upload later":
     * Reply: "No problem! You can upload {Name}'s travel documents anytime. Let's continue for now! 😊"
     * SKIP to awaiting_more_attendees (don't ask arrival info)
     * Clear cacheUpdate.currentDocType
     * Keep cacheUpdate.currentDocName and currentDocRole
     * updateDB = false

3. AFTER TRAVEL DOC OR ARRIVAL INFO:
   - ALWAYS move to awaiting_more_attendees
   - Clear the cache for current person: cacheUpdate = {} or set to null
   - Ask: "Perfect! Any other attendees to add? (Yes/No)"
   - Apply name extraction rules above

4. DATA PERSISTENCE:
   - Set updateDB:true when user provides RSVP/guest count/notes/arrival info
   - Set saveUpload when media exists and state expects upload
   - Use cacheUpdate for temporary data during document collection

5. BUTTON HANDLING:
   - __WRONG_RSVP__ → awaiting_rsvp: "No problem! Let's restart. Are you coming? (Yes/No/Maybe)"
   - __CHANGE_RSVP__ → awaiting_rsvp: "Sure! What's the updated RSVP? (Yes/No/Maybe)"
   - __ADD_DOC_SELF__ → awaiting_id_proof, set cacheUpdate.currentDocName=participant_name, currentDocRole="Self"

6. DOCUMENT MEMORY:
   - Check uploaded_documents before re-asking
   - If exists: "You already uploaded [type]! Want to replace it?"

ALLOWED STATES: ${ALLOWED_STATES.join(", ")}`;

  // ===== STATE-SPECIFIC INSTRUCTIONS =====
  const stateInstruction = STATE_INSTRUCTIONS[callStatus] || "Handle user query naturally and warmly.";

  // ===== CHECK IF WEDDING INFO NEEDED =====
  const needsWeddingInfo = /venue|date|time|schedule|event|when|where/i.test(userMessage);
  const weddingContext = needsWeddingInfo ? `\n\nWedding Info:\n${WEDDING_INFO}` : "";

  // ===== FINAL SYSTEM PROMPT =====
  const systemPrompt = `${CORE_SYSTEM_PROMPT}

Current Task: ${stateInstruction}${weddingContext}`;

  // ===== OPTIMIZED USER PROMPT (ONLY NON-NULL DATA) =====
  // ===== OPTIMIZED USER PROMPT (ONLY NON-NULL DATA) =====
  // ===== OPTIMIZED USER PROMPT (ONLY NON-NULL DATA) =====
  const userPrompt = `
State: ${callStatus}
User Message: "${userMessage}"
${participant?.full_name ? `Primary Participant: ${participant.full_name}` : ""}
${convo?.rsvp_status ? `RSVP: ${convo.rsvp_status}` : ""}
${convo?.number_of_guests ? `Guests: ${convo.number_of_guests}` : ""}
${convo?.notes ? `Notes: ${convo.notes}` : ""}
${convo?.proof_uploaded ? "Database Flag: proof_uploaded = true" : "Database Flag: proof_uploaded = false"}

CURRENT DOCUMENT COLLECTION CONTEXT:
${cache?.currentDoc?.name ? `📝 Collecting documents for: ${cache.currentDoc.name}` : "📝 No active document collection"}
${cache?.currentDoc?.role ? `📝 Their relation: ${cache.currentDoc.role}` : ""}
${cache?.currentDoc?.type ? `📝 Document type pending: ${cache.currentDoc.type}` : ""}

Actually Uploaded Documents:
${uploadedDocuments.length > 0 
  ? uploadedDocuments.map(d => `- ${d.document_type} for ${d.participant_relatives_name} (${d.role})`).join("\n")
  : "NONE - No documents have been uploaded yet"
}

${incomingMediaUrl ? "📎 Media Received: YES (document is being uploaded right now)" : "📎 Media Received: NO (no document in this message)"}

CRITICAL CONTEXT RULE:
When asking questions, ALWAYS use the name from "Collecting documents for: [NAME]" to make it clear whose information we're asking about. If name is the primary participant, use "you/your". If it's someone else, use their name explicitly.
`.trim();

  try {
    // ===== API CALL =====
    const { text: raw } = await sendToClaude(
      systemPrompt,
      [{ role: "user", content: userPrompt }],
      { 
        model: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 500,
        temperature: 0.0
      }
    );

    const cleaned = (raw || "").trim();

    // Parse JSON response
    let parsed = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const match = cleaned.match(/\{[\s\S]*\}$/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch (_) { parsed = null; }
      }
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("AI returned invalid JSON");
    }

    // Ensure required shape
    parsed.reply = parsed.reply || "Sorry, I didn't understand. Could you rephrase?";
    parsed.nextState = ALLOWED_STATES.includes(parsed.nextState) ? parsed.nextState : callStatus;
    parsed.actions = parsed.actions || { updateDB: false, fields: {} };

    // Sanitize numeric fields
    if (parsed.actions.fields?.number_of_guests !== undefined) {
      const n = parseInt(parsed.actions.fields.number_of_guests, 10);
      parsed.actions.fields.number_of_guests = isNaN(n) ? null : n;
    }

    // Auto-handle media uploads if AI missed it
    const expectingUploadStates = ["awaiting_id_proof", "awaiting_travel_doc_upload"];
    if (incomingMediaUrl && expectingUploadStates.includes(callStatus)) {
      if (!parsed.actions.saveUpload || !parsed.actions.saveUpload.document_url) {
        const docType = callStatus === "awaiting_id_proof" 
          ? "ID Proof" 
          : (cache?.currentDoc?.type || "Travel Document");
        
        parsed.actions.saveUpload = {
          document_url: "MEDIA",
          document_type: docType,
          role: cache?.currentDoc?.role || "Self",
          participant_relatives_name: cache?.currentDoc?.name || participant?.full_name || ""
        };

        if (callStatus === "awaiting_id_proof") {
          parsed.actions.updateDB = true;
          parsed.actions.fields = parsed.actions.fields || {};
          parsed.actions.fields.proof_uploaded = true;
        }
      }
    }

    return parsed;
  } catch (err) {
    console.error("❌ AI ERROR in decideNextStep:", err?.message || err);
    return {
      reply: "Sorry — I'm having trouble processing that. Could you repeat?",
      nextState: callStatus,
      actions: { updateDB: false, fields: {} }
    };
  }
}