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

// export async function getOrCreateChat({ phone_number, group_id, person_name }) {
//   const { data: existing } = await supabase
//     .from("chats")
//     .select("*")
//     .eq("phone_number", phone_number)
//     .eq("group_id", group_id)
//     .single();

//   if (existing) return existing;

//   const { data: created, error } = await supabase
//     .from("chats")
//     .insert({
//       phone_number,
//       group_id,
//       person_name: person_name || phone_number,
//       created_at: new Date(),
//     })
//     .select()
//     .single();

//   if (error) throw error;
//   return created;
// }

// export async function getPersonNameByPhone({ phone_number, user_id }) {
//   // Clean phone number for matching (remove spaces, dashes, etc.)
//   const cleanPhone = phone_number.replace(/[\s\-\(\)]/g, "");

//   console.log({ phone_number, cleanPhone });

//   const { data, error } = await supabase
//     .from("group_contacts")
//     .select("full_name")
//     .eq("phone_number", cleanPhone)
//     .eq("user_id", user_id)
//     .limit(1)
//     .maybeSingle();

//   if (error) {
//     console.error("Error fetching person name:", error);
//     return null;
//   }

//   return data?.full_name || null;
// }

export async function getPersonNameByPhone({ phone_number, user_id }) {
  if (!phone_number || !user_id) return null;

  // 1️⃣ Normalize incoming number
  const digitsOnly = phone_number.replace(/\D/g, "");

  // Use last 10 digits (safe for Indian numbers)
  const last10 = digitsOnly.slice(-10);

  // console.log({
  //   original: phone_number,
  //   digitsOnly,
  //   last10,
  // });

  // 2️⃣ Find first matching contact
  const { data, error } = await supabase
    .from("group_contacts")
    .select("full_name")
    .eq("user_id", user_id)
    .ilike("phone_number", `%${last10}`)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Error fetching person name:", error);
    return null;
  }

  return data?.full_name?.trim() || null;
}

export async function getOrCreateChat({ phone_number, user_id }) {
  // --------------------------------------------
  // 1. Try to find existing chat
  // --------------------------------------------
  const { data: existing, error: findError } = await supabase
    .from("chats")
    .select("*")
    .eq("phone_number", phone_number)
    .eq("user_id", user_id)
    .maybeSingle();

  if (findError) throw findError;

  // --------------------------------------------
  // 2. If exists → UPDATE and return
  // --------------------------------------------
  if (existing) {
    let updates = {
      updated_at: new Date(),
    };

    // If person_name missing, try to enrich it
    if (!existing.person_name) {
      const person_name = await getPersonNameByPhone({
        phone_number,
        user_id,
      });

      if (person_name) {
        updates.person_name = person_name;
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from("chats")
      .update(updates)
      .eq("chat_id", existing.chat_id)
      .select()
      .single();

    if (updateError) throw updateError;

    return updated;
  }

  // --------------------------------------------
  // 3. Not exists → CREATE new chat
  // --------------------------------------------
  const person_name = await getPersonNameByPhone({
    phone_number,
    user_id,
  });

  const { data: created, error: createError } = await supabase
    .from("chats")
    .insert({
      phone_number,
      user_id,
      person_name: person_name || phone_number,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .select()
    .single();

  if (createError) throw createError;

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
