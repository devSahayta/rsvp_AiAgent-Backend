// services/waAccountService.js
import { supabase } from "../config/supabase.js";

export async function getWhatsappAccount(user_id) {
  if (!user_id) throw new Error("user_id is required");

  const { data: account, error } = await supabase
    .from("whatsapp_accounts")
    .select("*")
    .eq("user_id", user_id)
    .single();

  if (error || !account) {
    throw new Error("WhatsApp account not found for this client");
  }

  // Validate required fields
  if (!account.system_user_access_token) {
    throw new Error("Missing system_user_access_token in WhatsApp account");
  }

  if (!account.waba_id) {
    throw new Error("Missing waba_id in WhatsApp account");
  }

  if (!account.phone_number_id) {
    throw new Error("Missing phone_number_id in WhatsApp account");
  }

  if (!account.app_id) {
    throw new Error("Missing app_id in WhatsApp account");
  }

  return account;
}
