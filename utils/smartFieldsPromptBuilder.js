// utils/smartFieldsPromptBuilder.js
import { supabase } from "../config/supabase.js";

async function getKbContent(knowledgeBaseId) {
  if (!knowledgeBaseId) return "";
  const { data: entries } = await supabase
    .from("knowledge_entries")
    .select("question, answer")
    .eq("knowledge_base_id", knowledgeBaseId)
    .limit(20);
  if (!entries?.length) return "";
  return entries.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join("\n\n");
}

export const buildSystemPrompt = async ({
  eventName,
  guestName,
  currentField,
  knowledgeBaseId,
  collectedAnswers = {},
  totalFields,
  currentIndex,
  allFields = [],
}) => {
  const kbContent = await getKbContent(knowledgeBaseId);

  const fieldTypeInstructions = {
    yes_no: `Accept casual Yes/No — 'yeah', 'yep', 'nope', 'sure', 'nah'. Always map to exactly 'yes' or 'no'.`,
    number: `Extract just the number. "only me" = 1, "me and my wife" = 2, "just myself" = 1, "2 guests" = 2.`,
    text: `Accept any free text.`,
    choice: `Valid options: ${currentField.options?.join(", ") || "listed options"}. Accept close matches.`,
  };

  const typeInstruction =
    fieldTypeInstructions[currentField.field_type] ||
    "Accept any reasonable answer.";
  const isLast = currentIndex === totalFields - 1;
  const collected = Object.entries(collectedAnswers);

  // Show all field keys so Claude knows exactly what it's allowed to ask
  const fieldList = allFields
    .map(
      (f, i) =>
        `  ${i + 1}. ${f.field_key} (${f.field_type}): "${f.ai_question}"`,
    )
    .join("\n");

  return `You are collecting RSVP information from ${guestName} for the event "${eventName}" over WhatsApp.
You work for the event organiser. Be warm, casual, and natural — like a helpful person, not a robot.

━━━ YOUR ONLY JOB ━━━
Collect the answer for field: "${currentField.field_key}"
Question: "${currentField.ai_question}"
Type: ${currentField.field_type}
${currentField.options?.length ? `Options: ${currentField.options.join(", ")}` : ""}
Rule: ${typeInstruction}

━━━ STRICT RULES ━━━
1. ONLY ask questions from this approved list — do NOT invent any other questions:
${fieldList}

2. You are currently on question ${currentIndex + 1} of ${totalFields}. 
   Do NOT ask any question other than "${currentField.ai_question}".
   Do NOT ask for email, phone, name, address, or ANYTHING not in the list above.

3. When you have the answer, add this signal on its own line at the VERY END of your reply:
   FIELD_COLLECTED:{"field_key":"${currentField.field_key}","value":"EXTRACTED_VALUE"}
   The guest must NEVER see this line — it must be the absolute last thing in your message.

4. If answer is unclear, ask again naturally. Never emit FIELD_COLLECTED if unsure.

5. Keep replies SHORT — 1-2 sentences. This is WhatsApp.

6. React naturally to what they say. Vary your style. Don't say "Thanks for letting me know!" every time.

7. ${isLast ? "This is the LAST question. After collecting the answer, wrap up warmly and let them know RSVP is complete." : `After getting this answer, move on to the next question smoothly.`}

━━━ ALREADY COLLECTED ━━━
${collected.length === 0 ? "Nothing yet." : collected.map(([k, v]) => `${k}: ${v}`).join("\n")}

${kbContent ? `━━━ EVENT INFO (only use to answer guest questions) ━━━\n${kbContent}` : ""}`.trim();
};
