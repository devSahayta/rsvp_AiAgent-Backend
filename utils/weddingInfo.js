// utils/weddingInfo.js
import { supabase } from "../config/supabase.js";

/**
 * Fetch wedding info dynamically from Knowledge Base
 * @param {string} kbId - The knowledge_base_id from the events table
 * @returns {Promise<string|null>} Combined KB content or null if not found
 */
export async function getWeddingInfo(kbId) {
  console.log("🔍 getWeddingInfo called with kbId:", kbId);
  
  if (!kbId) {
    console.warn("⚠️  No knowledge_base_id provided to getWeddingInfo");
    return null;
  }

  try {
    console.log("📡 Querying Supabase for KB entries...");
    
    // Fetch all KB entries for this knowledge base
    const { data: entries, error: kbError } = await supabase
      .from("knowledge_entries")
      .select("content")
      .eq("knowledge_base_id", kbId)
      .order("created_at", { ascending: true });

    console.log("📥 Supabase response:", { 
      hasData: !!entries, 
      entryCount: entries?.length || 0,
      hasError: !!kbError 
    });

    if (kbError) {
      console.error("❌ Supabase error fetching KB entries:", kbError);
      console.error("❌ Error details:", JSON.stringify(kbError, null, 2));
      return null;
    }

    if (!entries || entries.length === 0) {
      console.warn(`⚠️  No KB entries found for knowledge_base_id: ${kbId}`);
      console.warn("⚠️  Check if knowledge_entries table has data for this KB ID");
      return null;
    }

    // Combine all entries into one string
    const combinedContent = entries.map(e => e.content).join("\n\n");
    
    console.log(`✅ Successfully loaded ${entries.length} KB entries`);
    console.log(`✅ Total content length: ${combinedContent.length} characters`);
    console.log(`✅ First 200 chars: ${combinedContent.substring(0, 200)}...`);
    
    return combinedContent;
  } catch (err) {
    console.error("❌ Exception in getWeddingInfo:", err);
    console.error("❌ Stack trace:", err.stack);
    return null;
  }
}

// ========================================
// STATE INSTRUCTIONS - UPDATED WITH TRAVEL FLOW
// ========================================

export const STATE_INSTRUCTIONS = {
  awaiting_rsvp: `Ask naturally: "Hey! Are you planning to join us for the wedding? Just let me know - Yes, No, or Maybe works!"
Examples: "Yes, wouldn't miss it!", "No, sorry can't make it", "Maybe, need to check"

CRITICAL CONDITIONAL LOGIC:
1. If user says YES / "I'm coming" / "Count me in":
   - Set updateDB:true, fields.rsvp_status = "Yes"
   - Move to awaiting_guest_count
   - Reply: "Awesome! 🎉 How many people will be coming in total, including yourself?"

2. If user says NO / "I'm not coming" / "Can't make it":
   - Set updateDB:true, fields.rsvp_status = "No"
   - Move to completed
   - Reply: "No problem! I've recorded your RSVP as 'No'. 😔 If you change your mind later, just reach out and I can update it anytime!"

3. If user says MAYBE / "Not sure" / "I'll let you know":
   - Set updateDB:true, fields.rsvp_status = "Maybe"
   - Move to completed  
   - Reply: "Got it! I've recorded your status as 'Maybe'. 😊 Whenever you decide, just message me and I'll update your RSVP - no problem at all!"

NEVER ask for guest count unless RSVP status is "Yes"!`,

  awaiting_guest_count: `Ask warmly: "Great! How many people will be coming in total, including yourself?"
Examples: "Just me (1)", "2 of us", "My family of 4"
Extract number, set fields.number_of_guests, updateDB:true`,

  awaiting_notes: `Ask casually: "Perfect! Any special requests or dietary preferences we should know about? Or just say 'Nope, all good!' if nothing specific."
Examples: "Vegetarian meals please", "Need wheelchair access", "All good!"
Set fields.notes, updateDB:true`,

  awaiting_doc_person_name: `Ask in a super clear way that guides the user:

"Perfect! Let's get the ID proof sorted. Want to start with YOUR document first, or someone else's?

Just reply:
- 'Mine' or 'Start with me' (for your own ID)
- Or share their name like 'Priya' or 'Rahul'

What would you prefer?"

HANDLING:
- If user says "mine", "myself", "me", "my ID", "start with me", "my document" → Set cacheUpdate.currentDocName = participant_full_name, move to awaiting_doc_role
- Otherwise extract the name they provide → Set cacheUpdate.currentDocName = extracted_name, move to awaiting_doc_role`,

  awaiting_doc_role: `Ask simply, using the person's name from cache:

"Got it! What's {Name}'s relation to you?

1 - Myself
2 - Spouse
3 - Friend  
4 - Other

Just reply with the number!"

CRITICAL ROLE MAPPING:
- User says "1" or "myself" or "self" → Role = "Self"
- User says "2" or "spouse" or "wife" or "husband" → Role = "Spouse"
- User says "3" or "friend" → Role = "Friend"
- User says "4" or "other" or "family" or "relative" → Role = "Other"

IMPORTANT: 
- Replace {Name} with cacheUpdate.currentDocName
- Store BOTH in cache: cacheUpdate.currentDocRole = mapped role, keep cacheUpdate.currentDocName
- Move to awaiting_id_proof
- Reply: "Perfect! Now let's get {Name}'s ID proof. Send a photo or PDF! 📄"`,

  awaiting_id_proof: `Say, using person's name from cache:

If collecting for Primary Participant (currentDocName == Primary Participant name):
"Perfect! Go ahead and send YOUR ID proof document now - a photo or PDF works great! 📄"

If collecting for someone else:
"Perfect! Go ahead and send {Name}'s ID proof document now - a photo or PDF works great! 📄"

IMPORTANT HANDLING:
1. If user says "Can I send later?" or "I'll upload later" or "Not now":
   - Reply: "Of course! No worries at all 😊 You can send {Name}'s ID proof whenever you're ready!"
   - Stay in awaiting_id_proof state
   - Keep cacheUpdate.currentDocName and currentDocRole
   - updateDB = false

2. If user asks "Can I upload now?":
   - Check "Actually Uploaded Documents"
   - If not found → Reply: "Yes, go ahead! Send {Name}'s ID proof now! 📄"
   - Stay in awaiting_id_proof

3. If media received:
   - Set saveUpload with document_type='ID Proof', participant_relatives_name from cacheUpdate.currentDocName, role from cacheUpdate.currentDocRole
   - Set updateDB:true, fields.proof_uploaded=true
   - Keep cacheUpdate.currentDocName and currentDocRole
   - Move to awaiting_travel_docs_choice
   - Reply: "ID received for {Name}, thanks! 🎉"`,

  // ========================================
  // NEW TRAVEL DOCUMENT STATES
  // ========================================

  awaiting_travel_docs_choice: `Ask conversationally about travel documents - this is a NEW step after ID proof:

If asking about Primary Participant:
"ID received, thanks! 🎉 

Quick question - do YOU have your **travel documents** ready? Like flight/train tickets?

Reply:
- **Yes** - if you have them ready to upload
- **No** - if you're still booking or don't have them yet"

If asking about someone else (use their name from cache):
"ID received for {Name}, thanks! 🎉

Does {Name} have their **travel documents** ready? Like flight/train tickets?

Reply:
- **Yes** - if {Name} has them ready
- **No** - if still booking or not available yet"

CRITICAL HANDLING:
1. If user says YES or "I have them" or "ready":
   - Move to awaiting_travel_doc_type
   - Keep cacheUpdate.currentDocName and currentDocRole
   - Reply continues below

2. If user says NO or "don't have" or "not ready" or "still booking":
   - Move to awaiting_arrival_manual_date
   - Keep cacheUpdate.currentDocName and currentDocRole
   - Reply: "No worries! Let me just note down when {Name} is planning to arrive. What's the arrival date? Like 'Dec 19' or '19-12-2024'"

3. If user says "later", "I'll send later", "not now", "will upload later":
   - Reply: "No problem! You can upload {Name}'s travel documents anytime. Let's continue! 😊"
   - Move to awaiting_more_attendees
   - Clear cache: cacheUpdate = null or {}

Replace {Name} with cacheUpdate.currentDocName throughout`,

  awaiting_travel_doc_type: `Ask what TYPE of travel document they have - NEW state to identify the transport type:

If for Primary Participant:
"Perfect! What kind of travel are you using?

Reply:
- **Flight** ✈️
- **Train** 🚂
- **Bus** 🚌
- **Other**"

If for someone else:
"Perfect! What kind of travel is {Name} using?

Reply:
- **Flight** ✈️
- **Train** 🚂
- **Bus** 🚌
- **Other**"

CRITICAL HANDLING:
1. Extract the transport type from user's message:
   - "flight" / "airplane" / "plane" → Store "Flight Ticket"
   - "train" / "railway" → Store "Train Ticket"
   - "bus" → Store "Bus Ticket"
   - "other" / anything else → Store "Other Travel Document"

2. Store in cacheUpdate.transportType (e.g., "Flight Ticket", "Train Ticket")
3. Keep cacheUpdate.currentDocName and currentDocRole
4. Move to awaiting_travel_doc_direction
5. Reply: "Got it! {transport_emoji} Now, which ticket(s) do you want to upload?"

Replace {Name} with cacheUpdate.currentDocName
Use appropriate emoji based on transport type`,

  awaiting_travel_doc_direction: `Ask which travel document they want to upload:

If for Primary Participant:
"Great! Which document(s) do you want to upload?

Reply:
- **Arrival** - only arrival ticket (coming to wedding)
- **Return** - only Return ticket (leaving after wedding)
- **Both** - both arrival and Return tickets"

If for someone else:
"Great! Which document(s) do you want to upload for {Name}?

Reply:
- **Arrival** - only {Name}'s arrival ticket
- **Return** - only {Name}'s Return ticket
- **Both** - both arrival and Return tickets"

CRITICAL HANDLING:
1. If "Both":
   - Store in cacheUpdate.travelDirection = "both"
   - Store in cacheUpdate.currentDocType = "Arrival Ticket"
   - Keep currentDocName and currentDocRole
   - Move to awaiting_travel_doc_upload
   - Reply: "Perfect! Please upload the **ARRIVAL ticket** first 📤"

2. If "Arrival":
   - Store in cacheUpdate.travelDirection = "arrival_only"
   - Store in cacheUpdate.currentDocType = "Arrival Ticket"
   - Keep currentDocName and currentDocRole
   - Move to awaiting_travel_doc_upload
   - Reply: "Got it! Send {Name}'s arrival ticket now 📤"

3. If "Return":
   - Store in cacheUpdate.travelDirection = "return_only"
   - Store in cacheUpdate.currentDocType = "Return Ticket"
   - Keep currentDocName and currentDocRole
   - Move to awaiting_travel_doc_upload
   - Reply: "Got it! Send {Name}'s return ticket now 📤"

Replace {Name} with cacheUpdate.currentDocName`,

  awaiting_travel_doc_upload: `Handle the travel document upload:

If for Primary Participant:
"Go ahead and send YOUR {doc_type} now - photo or PDF works! 📎"

If for someone else:
"Go ahead and send {Name}'s {doc_type} now - photo or PDF works! 📎"

CRITICAL HANDLING:

1. If user says "later", "I'll send later", "not now":
   - Reply: "No problem! Upload {Name}'s travel documents anytime. Let's continue! 😊"
   - Move to awaiting_more_attendees
   - Clear cache: cacheUpdate = null

2. If media received AND currentDocType is "Arrival Ticket":
   - Save the upload with document_type = "Arrival Ticket"
   - Check cacheUpdate.travelDirection:
     
     A. If travelDirection == "both":
        - Update cacheUpdate.currentDocType = "Return Ticket"
        - Stay in awaiting_travel_doc_upload
        - Reply: "✅ Arrival ticket received! Now send the **RETURN ticket** 📤"
     
     B. If travelDirection == "arrival_only":
        - Move to awaiting_return_manual_date
        - Keep currentDocName and currentDocRole
        - Clear currentDocType
        - Reply: "✅ Arrival ticket received! When is {Name} planning to depart? Share the date like 'Dec 22' or '22-12-2024'"
     
     C. If travelDirection == "return_only":
        - This shouldn't happen (return was uploaded first)
        - Move to awaiting_more_attendees
        - Clear cache

3. If media received AND currentDocType is "Return Ticket":
   - Save the upload with document_type = "Return Ticket"
   - Move to awaiting_more_attendees
   - Clear cache: cacheUpdate = null
   - Reply: "✅ Return ticket received! All travel docs collected for {Name}! 🎉 Any other attendees?"

Replace {Name} with cacheUpdate.currentDocName
Replace {doc_type} with cacheUpdate.currentDocType`,

  awaiting_arrival_manual_date: `Ask for manual arrival date when they don't have the document:

If for Primary Participant:
"No worries! When are YOU planning to arrive?

Share the date like:
- Dec 19, 2024
- 19-12-2024
- 19/12/2024"

If for someone else:
"No worries! When is {Name} planning to arrive?

Share the date like:
- Dec 19, 2024
- 19-12-2024
- 19/12/2024"

HANDLING:
- Parse the date from user input (flexible formats)
- Store in cacheUpdate.arrivalDate
- Move to awaiting_arrival_manual_time
- Reply: "Got it! Arrival date: {parsed_date} 📅 What time? Like '10:30 AM' or '14:30' or 'morning flight'"

Replace {Name} with cacheUpdate.currentDocName`,

  awaiting_arrival_manual_time: `Ask for arrival time:

If for Primary Participant:
"And what time will YOU be arriving? 

Examples:
- 10:30 AM
- 2:30 PM  
- Evening flight
- Morning train"

If for someone else:
"What time will {Name} be arriving?

Examples:
- 10:30 AM
- 2:30 PM
- Evening flight"

HANDLING:
- Store the time/description as provided
- Combine with arrivalDate and store in fields.notes as: "Arrival ({Name}): {date} at {time}"
- Set updateDB: true
- Move to awaiting_return_choice
- Keep currentDocName and currentDocRole

Replace {Name} with cacheUpdate.currentDocName`,

  awaiting_return_choice: `Ask if they have return info:

If for Primary Participant:
"✅ Got YOUR arrival info!

Do you have your **return details** too?

Reply:
- **Yes** - I'll share the date and time
- **No** - Skip for now"

If for someone else:
"✅ Got {Name}'s arrival info!

Do you have {Name}'s **return details**?

Reply:
- **Yes** - I'll share the date and time
- **No** - Skip for now"

HANDLING:
1. If YES:
   - Move to awaiting_return_manual_date
   - Keep cache
2. If NO:
   - Move to awaiting_more_attendees
   - Clear cache: cacheUpdate = null
   - Reply: "No problem! You can add {Name}'s return details later. Any other attendees?"

Replace {Name} with cacheUpdate.currentDocName`,

  awaiting_return_manual_date: `Ask for return date:

If for Primary Participant:
"When are YOU departing?

Share the date like:
- Dec 22, 2024
- 22-12-2024"

If for someone else:
"When is {Name} departing?

Share the date like:
- Dec 22, 2024
- 22-12-2024"

HANDLING:
- Parse date
- Store in cacheUpdate.returnDate
- Move to awaiting_return_manual_time
- Reply: "Got it! Return: {parsed_date} 📅 What time?"

Replace {Name} with cacheUpdate.currentDocName`,

  awaiting_return_manual_time: `Ask for return time:

If for Primary Participant:
"What time is YOUR return?

Examples:
- 6:00 PM
- Evening flight
- Afternoon train"

If for someone else:
"What time is {Name}'s return?

Examples:
- 6:00 PM
- Evening flight"

HANDLING:
- Store the time/description
- Combine with returnDate and APPEND to fields.notes: "Return ({Name}): {date} at {time}"
- Set updateDB: true
- Move to awaiting_more_attendees
- Clear cache: cacheUpdate = null
- Reply: "✅ All travel info saved for {Name}! Any other attendees to add?"

Replace {Name} with cacheUpdate.currentDocName`,

  // ========================================
  // EXISTING STATES (UNCHANGED)
  // ========================================

  awaiting_more_attendees: `Ask friendly: "Perfect! Any other attendees you need to add documents for? Like family members, friends, plus-ones?

Reply 'Yes' if there's someone else, or 'No' if that's everyone!"

Examples: "Yes, my wife too", "Yes, adding my friend Rahul", "No, that's all"

CRITICAL NAME EXTRACTION:
- Check if user ALREADY mentioned a name in this message
- Patterns: "Yes [name]", "Yes my friend [name]", "Adding [name]", "My wife [name]"
- If name found → Extract it, store in cacheUpdate.currentDocName, move to awaiting_doc_role (SKIP awaiting_additional_attendee_name!)
- If only relationship ("my friend", "my wife") or just "Yes" → Move to awaiting_additional_attendee_name
- If No → completed (reply: "You're all set! 🎊 See you at the wedding! 💕")`,

  awaiting_additional_attendee_name: `Ask warmly: "Great! What's their name?"
Examples: "Sneha Sharma", "Rahul", "Priya"
Extract name, store in cacheUpdate.currentDocName, move to awaiting_doc_role`,

  completed: `Reply based on their RSVP status:

If RSVP = "Yes":
"You're all set! 🎊 Thanks for completing the RSVP. See you at the wedding - it's going to be amazing! 💕"

If RSVP = "No":  
"Thanks for letting me know! 😔 If anything changes, feel free to reach out anytime."

If RSVP = "Maybe":
"No problem! You're all set for now. 😊 Just message me whenever you decide!"

IMPORTANT:
- If user asks about wedding details, venue, dates, schedule, dress code, or timings:
  → The system will fetch wedding info dynamically from the Knowledge Base
  → This is handled automatically in decideNextStep() before reaching this state

If user wants to update RSVP, move to confirm_rsvp_update state.`,

  confirm_rsvp_update: `User wants to change their RSVP. Ask warmly:

"Sure! What's your updated RSVP status?

Reply:
- **Yes** - I'm coming!
- **No** - Can't make it
- **Maybe** - Still deciding"

HANDLING:
1. If YES:
   - Update fields.rsvp_status = "Yes"
   - Check if number_of_guests exists
   - If no guest count yet → Move to awaiting_guest_count, ask: "Awesome! Updated to 'Yes'! 🎉 How many people total?"
   - If guest count exists → Move to completed, reply: "Updated to 'Yes'! See you there! 🎉"

2. If NO:
   - Update fields.rsvp_status = "No"  
   - Move to completed
   - Reply: "Updated to 'No'. Thanks for letting me know! If you change your mind, reach out anytime."

3. If MAYBE:
   - Update fields.rsvp_status = "Maybe"
   - Move to completed
   - Reply: "Updated to 'Maybe'. No rush - decide whenever you're ready! 😊"`
};

// Random examples for variety
export const EXAMPLE_VARIATIONS = {
  names: ["Ravi", "Priya", "Amit", "Sneha", "Rohan", "Kavya"],
  guest_counts: ["Just me!", "2 of us", "Family of 4", "Me and my partner (2)"],
  notes: ["Vegetarian food please", "Need early check-in", "All good, no special requests"],
  arrival: ["Flying in on 19th evening", "Driving down on 20th morning", "Train on 19th night"]
};