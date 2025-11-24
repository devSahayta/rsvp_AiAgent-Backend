// utils/weddingInfo.js
export const WEDDING_INFO = `
Bride: Arshia Arya  
Parents: Ashish Prakash Arya & Barkha Arya  

Groom: Aditya Lahiri  
Parents: Devashish Lahiri & Dr. Simmi Mahesh  

Venue: Caravela Beach Resort, Varca, Salcete, Goa  
Location: https://maps.app.goo.gl/H7rGaz6Wt19uoMg1A  

Wedding Dates: 20th & 21st December 2025  
Check-in: 20th December 2025  
Check-out: 22nd December 2025  

EVENT SCHEDULE:

- 20 Dec – Welcome Lunch + Mehendi  
  Time: 1:00 PM onwards  
  Venue: Varca Ballroom  
  Dress Code: Floral & Festive  
  Notes: High-Tea at 5 PM  

- 20 Dec – Sangeet  
  Time: 6:30 PM onwards  
  Venue: New Lawns  

- 21 Dec – Haldi + Carnival  
  Time: 11:00 AM onwards  
  Venue: Coconut Grove  
  Dress Code: Tropical Vibes  
  Notes: Lunch at 1 PM onwards  

- 21 Dec – Sundowner Wedding  
  Baraat: 4:00 PM  
  Ceremony: 5:00 PM onwards  
  Venue: Beach Lawn  
  Dress Code: Pastel Elegance  

- 20 Dec – After Party  
  Time: 10:30 PM onwards  
  Venue: Varca Ballroom
`;

// utils/weddingInfo.js

export const STATE_INSTRUCTIONS = {
  awaiting_rsvp: `Ask naturally: "Hey! Are you planning to join us for the wedding? Just let me know - Yes, No, or Maybe works!"
Examples: "Yes, wouldn't miss it!", "No, sorry can't make it", "Maybe, need to check"
Set updateDB:true, fields.rsvp_status (exact: "Yes"/"No"/"Maybe")`,

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

  awaiting_travel_docs_choice: `Ask conversationally, CLEARLY mentioning whose documents:

If asking about Primary Participant:
"ID received, thanks! 🎉 Quick question - do YOU have travel documents ready? Like flight tickets, train tickets?

Reply 'Yes' if you have them, or 'No' if you're still booking or coming by own transport."

If asking about someone else (use their name from cache):
"ID received for {Name}, thanks! 🎉 Does {Name} have travel documents ready? Like flight tickets, train tickets?

Reply 'Yes' if {Name} has them, or 'No' if still booking or {Name} is coming by own transport."

CRITICAL HANDLING:
1. If YES → awaiting_travel_doc_type, keep cache
2. If NO → awaiting_arrival_info, keep cache
3. If user says "later", "I'll send later", "not now", "will upload later":
   - Reply: "No problem! You can upload {Name}'s travel documents anytime. Let's continue! 😊"
   - Move to awaiting_more_attendees
   - Clear cache: cacheUpdate = null or {}
   - updateDB = false

Replace {Name} with cacheUpdate.currentDocName
Keep cacheUpdate.currentDocName and currentDocRole throughout`,

  awaiting_travel_doc_type: `Ask naturally, mentioning whose document:

If for Primary Participant:
"Awesome! What kind of travel document do you have?
- Flight ticket
- Train ticket  
- Bus ticket
- Hotel booking
- Or just say 'Other'

What've you got?"

If for someone else:
"Awesome! What kind of travel document does {Name} have?
- Flight ticket
- Train ticket  
- Bus ticket
- Hotel booking
- Or just say 'Other'"

CRITICAL HANDLING:
- If user says "later", "not now", "will send later":
  * Reply: "No problem! Upload {Name}'s documents anytime. Let's continue! 😊"
  * Move to awaiting_more_attendees
  * Clear cache: cacheUpdate = null
  * updateDB = false
- Otherwise: Store in cacheUpdate.currentDocType, keep currentDocName and currentDocRole, move to awaiting_travel_doc_upload

Replace {Name} with cacheUpdate.currentDocName`,

  awaiting_travel_doc_upload: `Say warmly, mentioning whose document:

If for Primary Participant:
"Nice! Send YOUR {doc_type} whenever you're ready. 📎"

If for someone else:
"Nice! Send {Name}'s {doc_type} whenever you're ready. 📎"

CRITICAL HANDLING:
1. If user says "later", "I'll send later", "not now", "not right now":
   - Reply: "No problem! You can upload {Name}'s {doc_type} anytime. Let's continue for now! 😊"
   - Move to awaiting_more_attendees
   - Clear cache: cacheUpdate = null
   - updateDB = false

2. If media received:
   - Set saveUpload with participant_relatives_name from cacheUpdate.currentDocName, role from cacheUpdate.currentDocRole, document_type from cacheUpdate.currentDocType
   - Move to awaiting_more_attendees
   - Clear cache: cacheUpdate = null
   - Reply: "Got {Name}'s {doc_type}! 📎 Any other attendees to add?"

Replace {Name} with cacheUpdate.currentDocName
Replace {doc_type} with cacheUpdate.currentDocType`,

  awaiting_arrival_info: `Ask casually, CLEARLY mentioning whose arrival info:

If asking about Primary Participant:
"No worries! When are YOU planning to arrive? Like 'Flying in on 19th evening' or 'Driving down on 20th morning'?"

If asking about someone else:
"No worries! When is {Name} planning to arrive? Like '{Name} is flying in on 19th evening' or '{Name} will drive on 20th morning'?"

CRITICAL:
- Replace {Name} with cacheUpdate.currentDocName
- If user says "this is for [name]", acknowledge it and use that name
- Store as: "Arrival ({Name}): [user's response]"
- Append to fields.notes
- Set updateDB:true
- Move to awaiting_more_attendees
- Clear cache: cacheUpdate = null

Examples: 
- "Rahul is reaching on 19th Dec by evening flight"
- "She's driving on 20th morning"
- "My friend will arrive on 19th night"`,

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

  completed: `Reply enthusiastically: "You're all set! 🎊 Thanks for completing the RSVP. See you at the wedding - it's going to be amazing! 💕"
No further actions needed.`
};
// Random examples for variety
export const EXAMPLE_VARIATIONS = {
  names: ["Ravi", "Priya", "Amit", "Sneha", "Rohan", "Kavya"],
  guest_counts: ["Just me!", "2 of us", "Family of 4", "Me and my partner (2)"],
  notes: ["Vegetarian food please", "Need early check-in", "All good, no special requests"],
  arrival: ["Flying in on 19th evening", "Driving down on 20th morning", "Train on 19th night"]
};