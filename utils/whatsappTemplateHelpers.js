import { supabase } from "../config/supabase.js";

export function renderTemplateBody(template, finalComponents) {
  const bodyComp = template.components?.find((c) => c.type === "BODY");
  if (!bodyComp?.text) return "";

  let text = bodyComp.text;

  const params =
    finalComponents?.find((c) => c.type === "body")?.parameters || [];

  params.forEach((p, idx) => {
    text = text.replace(`{{${idx + 1}}}`, p.text || "");
  });

  return text;
}

export async function getOrCreateChat({ phone_number, event_id, person_name }) {
  const { data: existing } = await supabase
    .from("chats")
    .select("*")
    .eq("phone_number", phone_number)
    .eq("event_id", event_id)
    .single();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from("chats")
    .insert({
      phone_number,
      event_id,
      person_name: person_name || phone_number,
      created_at: new Date(),
    })
    .select()
    .single();

  if (error) throw error;
  return created;
}

export function extractTemplateButtons(template) {
  const buttonsComp = template.components?.find((c) => c.type === "BUTTONS");

  if (!buttonsComp || !Array.isArray(buttonsComp.buttons)) {
    return null;
  }

  return buttonsComp.buttons
    .map((btn) => {
      if (btn.type === "QUICK_REPLY") {
        return {
          type: "QUICK_REPLY",
          text: btn.text,
        };
      }

      if (btn.type === "URL") {
        return {
          type: "URL",
          text: btn.text,
          url: btn.url,
        };
      }

      if (btn.type === "PHONE_NUMBER") {
        return {
          type: "PHONE_NUMBER",
          text: btn.text,
          phone_number: btn.phone_number,
        };
      }

      return null;
    })
    .filter(Boolean);
}
