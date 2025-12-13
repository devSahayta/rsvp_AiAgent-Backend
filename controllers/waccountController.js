// import { supabase } from "../config/supabase.js";

// export const createWAccount = async (req, res) => {
//   try {
//     const {
//       user_id,
//       app_id,
//       waba_id,
//       phone_number_id,
//       business_phone_number,
//       system_user_access_token,
//     } = req.body;

//     const { data, error } = await supabase
//       .from("whatsapp_accounts")
//       .insert([
//         {
//           user_id,
//           app_id,
//           waba_id,
//           phone_number_id,
//           business_phone_number,
//           system_user_access_token,
//         },
//       ])
//       .select();

//     if (error) {
//       console.error("Supabase Error:", error);
//       return res.status(400).json({ success: false, message: error.message });
//     }

//     return res.status(200).json({
//       success: true,
//       message: "WhatsApp account saved successfully!",
//       data,
//     });
//   } catch (err) {
//     console.error("Server Error:", err);
//     return res.status(500).json({
//       success: false,
//       message: "Server error occurred",
//     });
//   }
// };

// ---------------------------updated Code-------------------

import { supabase } from "../config/supabase.js";

// ------------------------------------------------------
// 1️⃣ CREATE OR INSERT WHATSAPP ACCOUNT
// ------------------------------------------------------
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

    const { data: existing } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("user_id", user_id)
      .single();

    // If account already exists → return message
    if (existing) {
      return res.status(200).json({
        success: false,
        message: "WhatsApp account already exists for this user",
        data: existing,
      });
    }

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

// ------------------------------------------------------
// 2️⃣ GET / FETCH WHATSAPP ACCOUNT BY USER ID
// ------------------------------------------------------
export const getWAccount = async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res
        .status(400)
        .json({ success: false, message: "user_id required" });
    }

    const { data, error } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("Supabase Error:", error);
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.status(200).json({
      success: true,
      data: data || null, // If no data, return null
    });
  } catch (err) {
    console.error("Server Error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error occurred",
    });
  }
};

// ------------------------------------------------------
// 3️⃣ UPDATE WHATSAPP ACCOUNT
// ------------------------------------------------------
export const updateWAccount = async (req, res) => {
  try {
    const {
      user_id,
      app_id,
      waba_id,
      phone_number_id,
      business_phone_number,
      system_user_access_token,
    } = req.body;

    const { data: existing } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "No WhatsApp account found to update",
      });
    }

    const { data, error } = await supabase
      .from("whatsapp_accounts")
      .update({
        app_id,
        waba_id,
        phone_number_id,
        business_phone_number,
        system_user_access_token,
      })
      .eq("user_id", user_id)
      .select();

    if (error) {
      console.error("Supabase Update Error:", error);
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.status(200).json({
      success: true,
      message: "WhatsApp account updated successfully!",
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
