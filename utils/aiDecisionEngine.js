// utils/aiDecisionEngine.js
import { sendToClaude } from "./claudeClient.js";
import { getWeddingInfo, STATE_INSTRUCTIONS } from "./weddingInfo.js";

// ========================================
// UPDATED ALLOWED STATES - ADDED NEW TRAVEL STATES
// ========================================
const ALLOWED_STATES = [
  "awaiting_rsvp",
  "awaiting_guest_count",
  "awaiting_notes",
  "showing_summary",
  "awaiting_doc_person_name",
  "awaiting_doc_role",
  "awaiting_doc_upload",
  "awaiting_id_proof",

  // NEW TRAVEL DOCUMENT STATES
  "awaiting_travel_docs_choice", // Ask if they have travel docs
  "awaiting_travel_doc_type", // Ask what type (Flight/Train/Bus)
  "awaiting_travel_doc_direction", // Ask arrival/return/both
  "awaiting_travel_doc_upload", // Upload the document
  "awaiting_arrival_manual_date", // Manual arrival date input
  "awaiting_arrival_manual_time", // Manual arrival time input
  "awaiting_return_choice", // Ask if they have return info
  "awaiting_return_manual_date", // Manual return date input
  "awaiting_return_manual_time", // Manual return time input

  "awaiting_more_attendees",
  "awaiting_additional_attendee_name",
  "confirm_rsvp_update",
  "completed",
];

export default async function decideNextStep(context = {}, options = {}) {
  // ✅ Extract mode flag (defaults to "production")
  const { mode = "production" } = options;

  // Log mode for debugging
  if (mode === "test") {
    console.log("🧪 TEST MODE - Running in test mode");
  }
  const {
    userMessage = "",
    callStatus = "awaiting_rsvp",
    participant = {},
    convo = {},
    cache = {},
    event = {},
    incomingMediaUrl = null,
    uploadedDocuments = [],
  } = context;

  let normalizedMessage = userMessage?.trim()?.toLowerCase();

  // ✅ Accumulates every sendToClaude call made during this invocation —
  // this function can call Claude up to 3 times (dress-code path, general
  // wedding-info path, main flow), same as assistantController.js's
  // tool-use loop needed summing across multiple rounds.
  const claudeUsage = [];

  // ===== WEDDING INFO OVERRIDE (ABSOLUTE PRIORITY) =====
  const needsWeddingInfo =
    /venue|location|place|address|where|map|direction/.test(
      normalizedMessage,
    ) ||
    /date|when|time|timing|schedule|event|program|itinerary/.test(
      normalizedMessage,
    ) ||
    /detail|info|information|send.*detail|share.*detail/.test(
      normalizedMessage,
    ) ||
    /dress.*code|what.*wear|outfit/.test(normalizedMessage) ||
    /mehendi|sangeet|haldi|wedding|ceremony|party/.test(normalizedMessage);

  // 🔍 DEBUG LOGGING
  if (needsWeddingInfo) {
    console.log("🔍 KB FETCH TRIGGERED");
    console.log("📋 Event object:", JSON.stringify(event, null, 2));
    console.log("🔑 KB ID from event:", event?.knowledge_base_id);
  }

  // Fetch KB info if needed (with fallback for testing)
  const kbId =
    event?.knowledge_base_id || "69fd2a69-a8c1-4cfc-9dec-ffa1ecbd59c1"; // ⚠️ Temporary fallback for testing

  if (needsWeddingInfo && kbId) {
    console.log("🚀 Fetching KB with ID:", kbId);
    const weddingInfo = await getWeddingInfo(kbId);

    console.log(
      "✅ KB Data received:",
      weddingInfo ? `${weddingInfo.substring(0, 100)}...` : "NULL",
    );

    if (weddingInfo) {
      // Check if user ONLY asked about dress code
      const isDressCodeOnly =
        /dress.*code|what.*wear|outfit/i.test(normalizedMessage) &&
        !/venue|location|date|when|time|schedule/i.test(normalizedMessage);

      if (isDressCodeOnly) {
        console.log("🎨 Dress code query detected - formatting response");

        // Try to extract dress codes with event context using AI
        try {
          console.log(
            "🤖 Using AI to extract and format dress codes with event names",
          );

          const aiPrompt = `Extract ONLY the dress codes from this wedding info and format them nicely with the event names.

    Wedding Info:
    ${weddingInfo}

    Format like this:
    - [Event Name]: [Dress Code] [emoji]

    Example:
    - Welcome Lunch + Mehendi: Floral & Festive 🌸
    - Haldi + Carnival: Tropical Vibes 🌴
    - Sundowner Wedding: Pastel Elegance ✨

    Return ONLY valid JSON (no markdown, no code blocks):
    {"reply": "Here are the dress codes! 👗✨\\n\\n- Event: Dress Code\\n- Event: Dress Code", "nextState": "${callStatus}", "actions": {"updateDB": false, "fields": {}}}`;

          const {
            text: raw,
            usage,
            model,
          } = await sendToClaude(
            "Dress Code Assistant",
            [{ role: "user", content: aiPrompt }],
            {
              model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
              // temperature: 0,
            },
          );
          claudeUsage.push({
            model,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
          });

          console.log("🤖 AI raw response:", raw?.substring(0, 200));

          // Clean up the response
          let cleanedRaw = raw.trim();
          cleanedRaw = cleanedRaw
            .replace(/```json\s*/g, "")
            .replace(/```\s*/g, "");

          let parsed = {};
          try {
            parsed = JSON.parse(cleanedRaw);
          } catch (e) {
            console.warn("⚠️  First parse failed, trying regex extraction");
            const match = cleanedRaw.match(/\{[\s\S]*\}/);
            if (match) {
              parsed = JSON.parse(match[0]);
            } else {
              throw new Error("Could not extract JSON from AI response");
            }
          }

          console.log("✅ Dress code AI response parsed successfully");
          return { ...parsed, usage: claudeUsage };
        } catch (err) {
          console.error("❌ Dress code AI error:", err.message);
          console.log("⚠️  Falling back to simple dress code extraction");

          // Fallback: Simple extraction without event names
          const dressCodeLines = weddingInfo
            .split("\n")
            .filter((line) => /dress.*code/i.test(line))
            .map((line) => line.trim())
            .filter(Boolean);

          if (dressCodeLines.length > 0) {
            const dressCodeResponse = `Here are the dress codes for the wedding! 👗✨\n\n${dressCodeLines.join("\n")}`;
            return {
              reply: dressCodeResponse,
              nextState: callStatus,
              actions: { updateDB: false, fields: {} },
              usage: claudeUsage,
            };
          }

          // Last resort: return full KB
          console.log("⚠️  No dress codes found, returning full KB");
        }
      }

      // For all other queries, use AI to answer intelligently based on the specific question
      console.log("🤖 Using AI to answer specific question from KB");
      try {
        const aiPrompt = `You are EventBot, a helpful wedding assistant. Answer the user's SPECIFIC question using the wedding information provided.

    User asked: "${userMessage}"

    Wedding Information:
    ${weddingInfo}

    CRITICAL INSTRUCTIONS:
    1. Answer ONLY what they asked - don't dump all information
    2. If they ask "location" or "venue" → Give ONLY venue name and Google Maps link
    3. If they ask "dress code" → Already handled separately
    4. If they ask "when/date/time" → Give ONLY relevant dates/times
    5. If they ask "schedule" → Give ONLY the event schedule
    6. Be conversational and friendly
    7. Use emojis sparingly (1-2 max)
    8. Keep response SHORT and focused

    Examples:
    - User: "location ??" → Reply: "📍 Caravela Beach Resort, Varca, Salcete, Goa\n\nHere's the location: https://maps.app.goo.gl/H7rGaz6Wt19uoMg1A"
    - User: "when is the wedding?" → Reply: "The wedding is on 20th & 21st December 2025! 🎉\n\nCheck-in: Dec 20\nCheck-out: Dec 22"
    - User: "share the location alone" → Reply: "Sure! 📍\n\nVenue: Caravela Beach Resort, Varca, Salcete, Goa\nLocation: https://maps.app.goo.gl/H7rGaz6Wt19uoMg1A"

    Return ONLY valid JSON (no markdown, no code blocks):
    {"reply": "your focused answer here", "nextState": "${callStatus}", "actions": {"updateDB": false, "fields": {}}}`;

        const {
          text: raw,
          usage,
          model,
        } = await sendToClaude(
          "Wedding Info Assistant",
          [{ role: "user", content: aiPrompt }],
          {
            model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
            // temperature: 0.3,
            max_tokens: 300, // Keep responses concise
          },
        );
        claudeUsage.push({
          model,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
        });

        console.log(
          "🤖 AI raw response (first 200 chars):",
          raw?.substring(0, 200),
        );

        // Clean up response - remove markdown code blocks
        let cleanedRaw = raw.trim();
        cleanedRaw = cleanedRaw
          .replace(/```json\s*/g, "")
          .replace(/```\s*/g, "");

        let parsed = {};
        try {
          parsed = JSON.parse(cleanedRaw);
          console.log("✅ AI response parsed successfully");
        } catch (e) {
          console.warn("⚠️  First JSON parse failed, trying regex extraction");
          const match = cleanedRaw.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              parsed = JSON.parse(match[0]);
              console.log("✅ JSON extracted via regex");
            } catch (e2) {
              throw new Error("Could not parse AI response as JSON");
            }
          } else {
            throw new Error("No JSON found in AI response");
          }
        }

        // Validate the response has required fields
        if (!parsed.reply || !parsed.nextState) {
          console.warn("⚠️  Invalid AI response structure, using fallback");
          throw new Error("AI response missing required fields");
        }

        return { ...parsed, usage: claudeUsage };
      } catch (err) {
        console.error("❌ AI ERROR in decideNextStep:", err?.message || err);
        return {
          reply:
            "Sorry — I'm having trouble processing that. Could you repeat?",
          nextState: callStatus,
          actions: { updateDB: false, fields: {} },
          usage: claudeUsage, // whatever succeeded before the failure, if anything
        };
      }
    } else {
      console.warn("⚠️  KB data was NULL - continuing with normal flow");
    }
  } else if (needsWeddingInfo) {
    console.warn("⚠️  KB ID not available - cannot fetch wedding info");
  }

  // Handle special button clicks
  if (normalizedMessage === "wrong_response")
    context.userMessage = "__WRONG_RSVP__";
  if (normalizedMessage === "change_mind")
    context.userMessage = "__CHANGE_RSVP__";
  if (normalizedMessage === "add_doc_self")
    context.userMessage = "__ADD_DOC_SELF__";

  const CORE_SYSTEM_PROMPT = `You are EventBot - a friendly, conversational AI assistant helping with RSVPs for a wedding event.

    PERSONALITY:
    - Talk like a warm, helpful friend (not a robot!)
    - Use casual language: "Great!", "Perfect!", "No worries!", "Awesome!"
    - Add emojis sparingly: 🎉💕📄✈️🚂 (only 1-2 per message)
    - Keep responses SHORT and natural (2-3 sentences max per question)
    - Use varied examples each time

    OUTPUT ONLY JSON (no markdown):
    {
      "reply": "natural conversational text",
      "nextState": "state",
      "actions": {
        "updateDB": true/false,
        "fields": {"rsvp_status": "Yes/No/Maybe", "number_of_guests": 2, "notes": "text", "proof_uploaded": true/false},
        "saveUpload": {"document_url": "MEDIA", "document_type": "ID Proof|Arrival Ticket|return Ticket|Other", "role": "Self|Spouse|Friend|Other", "participant_relatives_name": "name"},
        "cacheUpdate": {
          "currentDocName": "name", 
          "currentDocRole": "role", 
          "currentDocType": "type",
          "transportType": "Flight Ticket|Train Ticket|Bus Ticket|Other",
          "travelDirection": "both|arrival_only|return_only",
          "arrivalDate": "YYYY-MM-DD",
          "arrivalTime": "HH:MM or description",
          "returnDate": "YYYY-MM-DD",
          "returnTime": "HH:MM or description"
        }
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
      - Stay in current state (awaiting_id_proof or awaiting_travel_doc_upload)
      - updateDB = false

    4. NEVER claim a document is uploaded unless it appears in "Actually Uploaded Documents" list

    5. The "Database Flag: proof_uploaded" is just a marker - always verify against actual uploaded documents list

    🚨 CONTEXT PRESERVATION (CRITICAL):

    When collecting documents for a specific person, MAINTAIN their identity throughout the ENTIRE flow.

    GOLDEN RULES:
    1. ALWAYS keep their name in cacheUpdate.currentDocName throughout ALL states until moving to awaiting_more_attendees
    2. NEVER lose track of whose documents you're collecting
    3. ALWAYS mention the person's name when asking questions
    4. Keep cacheUpdate.currentDocRole throughout the flow
    5. For travel documents, also maintain cacheUpdate.travelDirection

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
      Ask: "ID received for Rahul! 🎉 Does Rahul have travel documents ready? (Yes/No)"
      Keep: { cacheUpdate: { currentDocName: "Rahul", currentDocRole: "Friend" } }
    }
    ↓
    {
      State: awaiting_travel_doc_direction
      Cache: { currentDocName: "Rahul", currentDocRole: "Friend" }
      Ask: "Great! Which document(s) for Rahul? Arrival, return, or Both?"
      Actions: { cacheUpdate: { currentDocName: "Rahul", currentDocRole: "Friend", travelDirection: "both" } }
    }
    ↓
    {
      State: awaiting_travel_doc_upload
      Cache: { currentDocName: "Rahul", currentDocRole: "Friend", travelDirection: "both", currentDocType: "Arrival Ticket" }
      Ask: "Perfect! Upload Rahul's ARRIVAL ticket first 📤"
      Keep: { cacheUpdate: { currentDocName: "Rahul", currentDocRole: "Friend", travelDirection: "both", currentDocType: "Arrival Ticket" } }
    }
    ↓ [After uploading arrival ticket]
    {
      State: awaiting_travel_doc_upload
      Cache: { currentDocName: "Rahul", currentDocRole: "Friend", travelDirection: "both", currentDocType: "return Ticket" }
      Ask: "✅ Arrival ticket received! Now send Rahul's return ticket 📤"
      Keep: { cacheUpdate: { currentDocName: "Rahul", currentDocRole: "Friend", travelDirection: "both", currentDocType: "return Ticket" } }
    }
    ↓ [After uploading return ticket]
    {
      State: awaiting_more_attendees
      Cache: {} // Clear cache now
      Ask: "✅ All travel docs for Rahul collected! Any other attendees?"
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

    🚨 RESPECT "I DON'T HAVE IT" / DECLINES:
If a user indicates — in ANY phrasing, not just exact keywords — that they don't have something, can't provide something, or have already said so more than once, STOP asking for that specific thing. Mark it as skipped/optional and move the conversation forward. Never make a user repeat a decline more than once. When in doubt, prioritize moving the conversation forward over collecting every possible field.


    🚨 TRAVEL DOCUMENT FLOW - CRITICAL RULES:

    1. AFTER ID PROOF UPLOADED:
      - ALWAYS move to awaiting_travel_docs_choice
      - Ask: "ID received for {Name}! 🎉 Does {Name} have travel documents ready? (Yes/No)"
      - Keep cacheUpdate.currentDocName and currentDocRole

    2. TRAVEL DOCS CHOICE HANDLING:
      - If YES → move to awaiting_travel_doc_type (ask Flight/Train/Bus)
      - If NO → move to awaiting_arrival_manual_date (to collect manual arrival info)
      - If "later"/"not now" → move to awaiting_more_attendees, clear cache

    3. TRAVEL TYPE HANDLING (awaiting_travel_doc_type):
      - Extract transport type: "flight"→"Flight Ticket", "train"→"Train Ticket", "bus"→"Bus Ticket"
      - Store in cacheUpdate.transportType
      - Move to awaiting_travel_doc_direction
      - Keep currentDocName and currentDocRole

    4. TRAVEL DIRECTION HANDLING (awaiting_travel_doc_direction):
      - If "Both" → set travelDirection="both", currentDocType="{transportType} - Arrival", move to awaiting_travel_doc_upload
      - If "Arrival" → set travelDirection="arrival_only", currentDocType="{transportType} - Arrival", move to awaiting_travel_doc_upload
      - If "return" → set travelDirection="return_only", currentDocType="{transportType} - return", move to awaiting_travel_doc_upload
      - Example: If user selected "Flight", currentDocType becomes "Flight Ticket - Arrival" or "Flight Ticket - return"

    5. UPLOAD HANDLING (awaiting_travel_doc_upload):
      When media received:
      
      A. If currentDocType contains "Arrival":
          - Save upload with document_type="{transportType} - Arrival" (e.g., "Flight Ticket - Arrival")
          - Check travelDirection:
            * If "both" → Update currentDocType="{transportType} - return", stay in awaiting_travel_doc_upload
            * If "arrival_only" → Move to awaiting_return_choice (ask if they have return info)
            * If "return_only" → Should not happen
      
      B. If currentDocType contains "return":
          - Save upload with document_type="{transportType} - return" (e.g., "Flight Ticket - return")
          - Move to awaiting_more_attendees
          - Clear cache

    5. MANUAL INPUT FLOW (when user says NO to having travel docs):
      - awaiting_arrival_manual_date → collect date → awaiting_arrival_manual_time
      - awaiting_arrival_manual_time → collect time → save to notes → awaiting_return_choice
      - awaiting_return_choice → if YES → awaiting_return_manual_date → awaiting_return_manual_time
      - If NO at return_choice → move to awaiting_more_attendees

    6. "UPLOAD LATER" HANDLING:
      In any travel state (choice, direction, upload):
      - Reply: "No problem! You can upload {Name}'s travel documents anytime. Let's continue! 😊"
      - Move to awaiting_more_attendees
      - Clear cache: cacheUpdate = null

    7. DATE/TIME STORAGE:
      - Store manual arrival: "Arrival ({Name}): {date} at {time}" → append to fields.notes
      - Store manual return: "return ({Name}): {date} at {time}" → append to fields.notes
      - Set updateDB = true when storing

    CRITICAL FLOW RULES:

    1. DATA PERSISTENCE:
      - Set updateDB:true when user provides RSVP/guest count/notes/arrival info/return info
      - Set saveUpload when media exists and state expects upload
      - Use cacheUpdate for temporary data during document collection

    2. BUTTON HANDLING:
      - __WRONG_RSVP__ → awaiting_rsvp: "No problem! Let's restart. Are you coming? (Yes/No/Maybe)"
      - __CHANGE_RSVP__ → awaiting_rsvp: "Sure! What's the updated RSVP? (Yes/No/Maybe)"
      - __ADD_DOC_SELF__ → awaiting_id_proof, set cacheUpdate.currentDocName=participant_name, currentDocRole="Self"

    3. DOCUMENT MEMORY:
      - Check uploaded_documents before re-asking
      - If exists: "You already uploaded [type]! Want to replace it?"

    ALLOWED STATES: ${ALLOWED_STATES.join(", ")}`;

  // ===== STATE-SPECIFIC INSTRUCTIONS =====
  const stateInstruction =
    STATE_INSTRUCTIONS[callStatus] || "Handle user query naturally and warmly.";

  // ===== FINAL SYSTEM PROMPT =====
  const systemPrompt = `${CORE_SYSTEM_PROMPT}

    Current Task: ${stateInstruction}`;

  // ===== OPTIMIZED USER PROMPT =====
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
    ${cache?.currentDoc?.travelDirection ? `📝 Travel direction: ${cache.currentDoc.travelDirection}` : ""}
    ${cache?.currentDoc?.arrivalDate ? `📝 Arrival date collected: ${cache.currentDoc.arrivalDate}` : ""}
    ${cache?.currentDoc?.returnDate ? `📝 return date collected: ${cache.currentDoc.returnDate}` : ""}

    Actually Uploaded Documents:
    ${
      uploadedDocuments.length > 0
        ? uploadedDocuments
            .map(
              (d) =>
                `- ${d.document_type} for ${d.participant_relatives_name} (${d.role})`,
            )
            .join("\n")
        : "NONE - No documents have been uploaded yet"
    }

    ${incomingMediaUrl ? "📎 Media Received: YES (document is being uploaded right now)" : "📎 Media Received: NO (no document in this message)"}

    CRITICAL CONTEXT RULE:
    When asking questions, ALWAYS use the name from "Collecting documents for: [NAME]" to make it clear whose information we're asking about. If name is the primary participant, use "you/your". If it's someone else, use their name explicitly.
    `.trim();

  try {
    // ===== API CALL =====
    const {
      text: raw,
      usage,
      model,
    } = await sendToClaude(
      systemPrompt,
      [{ role: "user", content: userPrompt }],
      {
        model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
        max_tokens: 2048,
      },
    );
    claudeUsage.push({
      model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
    });

    const cleaned = (raw || "").trim();
    console.log("🔎 RAW CLAUDE RESPONSE:", cleaned);

    // Strip markdown code fences (```json ... ``` or ``` ... ```) before parsing
    const cleanedNoFences = cleaned
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/, "")
      .replace(/```\s*$/, "")
      .trim();

    // Parse JSON response
    let parsed = null;
    try {
      parsed = JSON.parse(cleanedNoFences);
    } catch (e) {
      console.warn("⚠️ First parse failed:", e.message);
      const match = cleanedNoFences.match(/\{[\s\S]*\}$/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch (_) {
          parsed = null;
        }
      }
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("AI returned invalid JSON");
    }

    // Ensure required shape
    parsed.reply =
      parsed.reply || "Sorry, I didn't understand. Could you rephrase?";
    parsed.nextState = ALLOWED_STATES.includes(parsed.nextState)
      ? parsed.nextState
      : callStatus;
    parsed.actions = parsed.actions || { updateDB: false, fields: {} };

    // Sanitize numeric fields
    if (parsed.actions.fields?.number_of_guests !== undefined) {
      const n = parseInt(parsed.actions.fields.number_of_guests, 10);
      parsed.actions.fields.number_of_guests = isNaN(n) ? null : n;
    }

    // Auto-handle media uploads if AI missed it
    const expectingUploadStates = [
      "awaiting_id_proof",
      "awaiting_travel_doc_upload",
    ];
    if (incomingMediaUrl && expectingUploadStates.includes(callStatus)) {
      if (
        !parsed.actions.saveUpload ||
        !parsed.actions.saveUpload.document_url
      ) {
        const docType =
          callStatus === "awaiting_id_proof"
            ? "ID Proof"
            : cache?.currentDoc?.type || "Travel Document";

        parsed.actions.saveUpload = {
          document_url: "MEDIA",
          document_type: docType,
          role: cache?.currentDoc?.role || "Self",
          participant_relatives_name:
            cache?.currentDoc?.name || participant?.full_name || "",
        };

        if (callStatus === "awaiting_id_proof") {
          parsed.actions.updateDB = true;
          parsed.actions.fields = parsed.actions.fields || {};
          parsed.actions.fields.proof_uploaded = true;
        }
      }
    }

    // ✅ MODE FLAG HANDLING - THIS IS THE ONLY NEW CODE!
    if (mode === "test") {
      console.log("🧪 TEST MODE - Disabling production side effects");

      // Disable all production DB writes and side effects
      parsed.actions.updateDB = false;
      parsed.actions.saveUpload = null;

      console.log("✅ TEST MODE - Response ready (no DB writes)");
    }

    return { ...parsed, usage: claudeUsage };
  } catch (err) {
    console.error("❌ AI answer generation error:", err.message);
    console.log("⚠️  Falling back to full KB content");

    // Fallback to full KB content — claudeUsage may still hold a cost
    // if sendToClaude succeeded but something after it (e.g. JSON
    // parsing) failed; keep it so that cost isn't silently dropped.
    return {
      reply: weddingInfo,
      nextState: callStatus,
      actions: { updateDB: false, fields: {} },
      usage: claudeUsage,
    };
  }
}
