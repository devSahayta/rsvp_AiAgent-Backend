import { supabase } from "../config/supabase.js";

export const createWAccount = async (req, res) => {
  try {
    const {
      user_id,
      app_id,
      waba_id,
      phone_number_id,
      business_phone_number,
      system_user_access_token,
    } = req.body;

    const { data, error } = await supabase
      .from("whatsapp_accounts")
      .insert([
        {
          user_id,
          app_id,
          waba_id,
          phone_number_id,
          business_phone_number,
          system_user_access_token,
        },
      ])
      .select();

    if (error) {
      console.error("Supabase Error:", error);
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.status(200).json({
      success: true,
      message: "WhatsApp account saved successfully!",
      data,
    });
  } catch (err) {
    console.error("Server Error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error occurred",
    });
  }
};
