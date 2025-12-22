import { supabase } from "../config/supabase.js";
import { sendWhatsAppTextMessage } from "../utils/whatsappClient.js";


/**
 * POST /admin/chat/send
 * Body: { chat_id, message, admin_id }
 */
export const sendAdminMessage = async (req, res) => {
  try {
    const { chat_id, message } = req.body;
const admin_id = req.user.user_id;

if (!chat_id || !message) {
  return res.status(400).json({ error: "Missing required fields" });
}


    /* 1️⃣ Fetch chat */
    const { data: chat, error: chatError } = await supabase
      .from("chats")
      .select("*")
      .eq("chat_id", chat_id)
      .single();

    if (chatError || !chat) {
      return res.status(404).json({ error: "Chat not found" });
    }

    /* 2️⃣ Save admin message */
    const { error: messageError } = await supabase
      .from("messages")
      .insert({
        chat_id,
        sender_type: "admin",
        message,
        message_type: "text",
          media_path: null, 
        created_at: new Date()
      });

    if (messageError) {
      throw messageError;
    }

    /* 3️⃣ Switch AI → MANUAL if needed */
    let shouldNotifyUser = false;

    if (chat.mode === "AI") {
      const { error: updateError } = await supabase
        .from("chats")
        .update({
          mode: "MANUAL",
          last_admin_message_at: new Date(),
          manual_activated_by: admin_id,
          user_notified: false
        })
        .eq("chat_id", chat_id);

      if (updateError) throw updateError;

      shouldNotifyUser = true;
    } else {
      // Already manual → just update timestamp
      await supabase
        .from("chats")
        .update({
          last_admin_message_at: new Date()
        })
        .eq("chat_id", chat_id);
    }

    /* 4️⃣ Send admin message to WhatsApp */
await sendWhatsAppTextMessage(chat.phone_number, message);


  /* 5️⃣ One-time system notification */
if (shouldNotifyUser) {
  const systemMessage =
    "You are now chatting with a team member. Automated replies are temporarily paused.";

  // 1️⃣ Save in DB
  const { data: systemMsgData, error: systemMsgError } = await supabase
    .from("messages")
    .insert({
      chat_id,
      sender_type: "system",
      message: systemMessage,
      message_type: "text",
      created_at: new Date()
    })
    .select()
    .single();

  if (systemMsgError) throw systemMsgError;

  // 2️⃣ Send via WhatsApp
  await sendWhatsAppTextMessage(chat.phone_number, systemMsgData.message);

  // 3️⃣ Update chat flag
  await supabase
    .from("chats")
    .update({ user_notified: true })
    .eq("chat_id", chat_id);
}


    return res.json({ success: true });
  } catch (err) {
    console.error("Admin send message error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const resumeAIChat = async (req, res) => {
  try {
    const { chat_id } = req.body;
const admin_id = req.user.user_id;



    if (!chat_id || !admin_id) {
      return res.status(400).json({
        error: "chat_id and admin_id are required"
      });
    }

    // 1️⃣ Check chat exists
    const { data: chat, error: chatError } = await supabase
      .from("chats")
      .select("*")
      .eq("chat_id", chat_id)
      .maybeSingle();

    if (chatError || !chat) {
      return res.status(404).json({
        error: "Chat not found"
      });
    }

    // 2️⃣ If already AI, no need to resume
    if (chat.mode === "AI") {
      return res.status(200).json({
        message: "AI is already active for this chat"
      });
    }

    // 3️⃣ Update chat → Resume AI
    const { error: updateError } = await supabase
      .from("chats")
      .update({
        mode: "AI",
        manual_activated_by: null,
        user_notified: false,
        last_message_at: new Date().toISOString()
      })
      .eq("chat_id", chat_id);

    if (updateError) {
      console.error("❌ Failed to resume AI:", updateError);
      return res.status(500).json({
        error: "Failed to resume AI"
      });
    }

    // 4️⃣ Insert system message (for chat history)
    await supabase.from("messages").insert({
      chat_id,
      sender_type: "system",
      message_type: "text",
      message: "Automated replies have been resumed."
    });

    console.log(`✅ AI resumed for chat ${chat_id} by ${admin_id}`);

    return res.json({
      success: true,
      message: "AI resumed successfully"
    });

  } catch (err) {
    console.error("❌ resumeAIChat error:", err);
    return res.status(500).json({
      error: "Internal server error"
    });
  }
};