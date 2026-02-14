// controllers/whatsappTemplateController.js
import { v4 as uuidv4 } from "uuid";
import { supabase } from "../config/supabase.js";
import * as wsService from "../services/whatsappTemplateService.js";
import { getWhatsappAccount } from "../services/waAccountService.js";
import {
  renderTemplateBody,
  getOrCreateChat,
  extractTemplateButtons,
} from "../utils/whatsappTemplateHelpers.js";
import fetch from "node-fetch";
const { FormData, Blob } = global;

// top of controller file
const bulkProgress = new Map();
// key: user_id + templateId

// create template (store in DB and optionally submit to Meta)
export async function createTemplate(req, res) {
  try {
    const payload = req.body;
    const wt_id = uuidv4();

    // Extract BODY example variables safely
    let bodyVariables = [];
    const bodyComponent = payload.components?.find((c) => c.type === "BODY");

    if (bodyComponent?.example?.body_text?.[0]) {
      bodyVariables = bodyComponent.example.body_text[0];
    }

    // Extract buttons safely
    let buttonList = [];
    const buttonComponent = payload.components?.find(
      (c) => c.type === "BUTTONS",
    );

    if (buttonComponent?.buttons) {
      buttonList = buttonComponent.buttons;
    }

    const insert = {
      wt_id,
      account_id: null,
      template_id: null,
      name: payload.name,
      language: payload.language || "en_US",
      category: payload.category || "MARKETING",
      parameter_format: payload.parameter_format || "positional",
      components: payload.components || [],
      header_format: payload.header_format || null,
      header_handle: payload.header_handle || null,
      variables: payload.variables || bodyVariables,
      buttons: payload.buttons || buttonList,
      preview: payload.preview || {},
      status: "PENDING",
    };

    const { error: insertErr } = await supabase
      .from("whatsapp_templates")
      .insert(insert);
    if (insertErr) throw insertErr;

    // fetch account row (reads system_user_access_token, waba_id, phone_number_id)
    const { data: account, error: acctErr } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("user_id", payload.user_id)
      .limit(1)
      .single();

    if (acctErr || !account) {
      return res.status(201).json({
        template: insert,
        note: "Saved locally. whatsapp_accounts row not found or missing tokens.",
      });
    }

    if (account.system_user_access_token && account.waba_id) {
      try {
        const metaResp = await wsService.createTemplateOnMeta(
          account.waba_id,
          account.system_user_access_token,
          {
            name: payload.name,
            language: payload.language,
            category: payload.category,
            parameter_format: payload.parameter_format || "positional",
            components: payload.components,
          },
        );

        let preview = null;
        const templateId = metaResp?.id;
        const templateName = payload.name;

        try {
          // Fetch all templates from Meta
          const data = await wsService.listTemplatesFromMeta(
            account.waba_id,
            account.system_user_access_token,
          );

          const templates = data.data || data || [];

          // Find template by id or name
          if (templateId) {
            preview = templates.find((tpl) => tpl.id === templateId);
          }

          if (!preview && templateName) {
            preview = templates.find((tpl) => tpl.name === templateName);
          }
        } catch (e) {
          console.warn("Template created but preview fetch failed:", e.message);
        }

        // console.log({ preview, previewComponent: preview.components });

        // update row with template_id and status
        await supabase
          .from("whatsapp_templates")
          .update({
            account_id: account.wa_id,
            template_id: metaResp.id || null,
            status: metaResp.status || "PENDING",
            preview, // 👈 stored as jsonb
          })
          .eq("wt_id", wt_id);
        return res.status(201).json({ template: insert, meta: metaResp });
      } catch (metaErr) {
        return res
          .status(201)
          .json({ template: insert, meta_error: metaErr.message });
      }
    }

    return res.status(201).json({
      template: insert,
      note: "Saved locally. No system_user_access_token or waba_id present.",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || err });
  }
}

export async function createUploadSession(req, res) {
  try {
    const { user_id, file_name, file_type } = req.body;

    const account = await getWhatsappAccount(user_id);

    const sessionData = await wsService.createUploadSession(
      account.app_id,
      account.system_user_access_token,
      { file_name, file_type },
    );

    return res.json(sessionData);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

// upload binary: accepts multipart (multer) file forwarded as raw binary to Meta session
export async function uploadBinaryToSession(req, res) {
  try {
    const user_id = req.body.user_id || req.query.user_id;

    if (!user_id) {
      return res.status(400).json({ error: "user_id required" });
    }

    const account = await getWhatsappAccount(user_id);

    const sessionId = req.body.session_id || req.query.session_id;
    if (!sessionId || !req.file || !req.file.buffer)
      return res.status(400).json({ error: "session_id and file required" });
    const buffer = req.file.buffer;
    // use optional access token passed in body to authorize; otherwise rely on env (service)
    const resp = await wsService.uploadBinaryToSession(
      sessionId,
      buffer,
      req.file.mimetype || "application/octet-stream",
      account.system_user_access_token,
    );
    return res.json(resp);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || err });
  }
}

export async function checkTemplateStatus(req, res) {
  try {
    const wt_id = req.params.wt_id;
    const { data: tpl, error: tplErr } = await supabase
      .from("whatsapp_templates")
      .select("*")
      .eq("wt_id", wt_id)
      .limit(1)
      .single();
    if (tplErr) return res.status(404).json({ error: "Template not found" });
    if (!tpl.template_id)
      return res
        .status(400)
        .json({ error: "Template has not been submitted to Meta" });

    const { data: account, error: acctErr } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("wa_id", tpl.account_id)
      .limit(1)
      .single();
    if (acctErr)
      return res.status(400).json({ error: "Account not found for template" });
    if (!account.system_user_access_token)
      return res
        .status(400)
        .json({ error: "Account has no system_user_access_token" });

    console.log("No error till here");

    console.log({
      whatsappId: account.waba_id,
      templateName: tpl.name,
      token: account.system_user_access_token,
    });

    const status = await wsService.checkTemplateStatusOnMeta(
      account.waba_id,
      tpl.name,
      account.system_user_access_token,
    );

    console.log({ status });

    if (status && status.status)
      await supabase
        .from("whatsapp_templates")
        .update({ status: status.status })
        .eq("wt_id", wt_id);
    return res.json(status);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || err });
  }
}

export async function listTemplates(req, res) {
  try {
    const user_id = req.query.user_id;

    if (!user_id) {
      return res.status(400).json({ error: "user_id required" });
    }

    const account = await getWhatsappAccount(user_id);

    const account_id = account.wa_id;
    let q = supabase.from("whatsapp_templates").select("*");
    if (account_id) q = q.eq("account_id", account_id);
    const { data, error } = await q.order("created_at", { ascending: false });
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || err });
  }
}

// export async function sendTemplate(req, res) {
//   try {
//     const wt_id = req.params.wt_id;
//     const body = req.body;

//     // 1. Load template row
//     const { data: tpl, error: tplErr } = await supabase
//       .from("whatsapp_templates")
//       .select("*")
//       .eq("wt_id", wt_id)
//       .single();

//     if (tplErr || !tpl) {
//       return res.status(404).json({ error: "Template not found" });
//     }

//     // 2. Load WhatsApp account
//     const user_id = body.user_id || tpl.user_id;
//     const account = await getWhatsappAccount(user_id);
//     if (!account)
//       return res.status(400).json({ error: "WhatsApp account not found" });

//     if (!account.system_user_access_token)
//       return res
//         .status(400)
//         .json({ error: "Missing system_user_access_token" });

//     if (!account.phone_number_id)
//       return res.status(400).json({ error: "Missing phone_number_id" });

//     // -------------------------------------------------------------
//     // 3. Build components EXACTLY as Meta expects
//     // -------------------------------------------------------------

//     let finalComponents = [];

//     // Case A: frontend provides exact components → use them
//     if (body.components && Array.isArray(body.components)) {
//       finalComponents = body.components;
//     }

//     // Case B: variables provided (for normal templates)
//     else if (body.variables && Array.isArray(body.variables)) {
//       finalComponents = [
//         {
//           type: "body",
//           parameters: body.variables.map((v) => ({
//             type: "text",
//             text: v,
//           })),
//         },
//       ];
//     }

//     // Case C: template is stored as media template (if nothing provided)
//     else if (tpl.components && tpl.components.length > 0) {
//       finalComponents = tpl.components;
//     }

//     // -------------------------------------------------------------
//     // 4. Final message payload
//     // -------------------------------------------------------------
//     const messagePayload = {
//       messaging_product: "whatsapp",
//       to: body.to,
//       type: "template",
//       template: {
//         name: tpl.name,
//         language: { code: tpl.language || "en_US" },
//         components: finalComponents,
//       },
//     };

//     // -------------------------------------------------------------
//     // 5. Send to Meta
//     // -------------------------------------------------------------
//     const sendResp = await wsService.sendTemplateMessage(
//       account.phone_number_id,
//       account.system_user_access_token,
//       messagePayload
//     );

//     // -------------------------------------------------------------
//     // 6. Log message
//     // -------------------------------------------------------------
//     const log = {
//       wm_id: uuidv4(),
//       account_id: account.wa_id,
//       to_number: body.to,
//       template_name: tpl.name,
//       message_body: messagePayload,
//       wa_message_id: sendResp?.messages?.[0]?.id || null,
//       status: sendResp.error ? "FAILED" : "SENT",
//     };

//     await supabase.from("whatsapp_messages").insert(log);

//     return res.json({ sendResp, log });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: err.response?.data || err.message });
//   }
// }

export async function sendTemplate(req, res) {
  try {
    const templateId = req.params.templateId;
    const { user_id, to, components, variables } = req.body;

    if (!templateId) {
      return res.status(400).json({ error: "templateId is required" });
    }

    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    if (!to) {
      return res
        .status(400)
        .json({ error: "Receiver number 'to' is required" });
    }

    // -------------------------------------------------------------
    // 1. Load WhatsApp Account
    // -------------------------------------------------------------
    const account = await getWhatsappAccount(user_id);
    if (!account)
      return res.status(400).json({ error: "WhatsApp account not found" });

    if (!account.system_user_access_token)
      return res
        .status(400)
        .json({ error: "Missing system_user_access_token" });

    if (!account.phone_number_id)
      return res.status(400).json({ error: "Missing phone_number_id" });

    // -------------------------------------------------------------
    // 2. Get Template Data from Meta
    // -------------------------------------------------------------
    // const metaTemplates = await wsService.listTemplatesFromMeta(
    //   account.waba_id,
    //   account.system_user_access_token
    // );

    const metaTemplates = await wsService.listTemplatesFromDb(
      account.wa_id,
      account.waba_id,
      account.system_user_access_token,
    );

    const allTemplates = metaTemplates.data || metaTemplates || [];

    const template = allTemplates.find((t) => t.id === templateId);

    if (!template) {
      return res.status(404).json({ error: "Template not found on Meta" });
    }

    // -------------------------------------------------------------
    // 3. Build correct Component Payload
    // -------------------------------------------------------------
    let finalComponents = [];

    // CASE A → Frontend sends FULL components (best)
    if (components && Array.isArray(components)) {
      finalComponents = components;
    }
    // CASE B → frontend sends only variables (normal)
    else if (variables && Array.isArray(variables)) {
      finalComponents = [
        {
          type: "body",
          parameters: variables.map((v) => ({
            type: "text",
            text: v,
          })),
        },
      ];
    }
    // CASE C → Template has NO variables (simple, static template)
    else {
      finalComponents = []; // No components needed
    }

    // -------------------------------------------------------------
    // 4. Prepare Final Meta Payload
    // -------------------------------------------------------------
    const messagePayload = {
      messaging_product: "whatsapp",
      to: to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language || "en_US" },
        components: finalComponents,
      },
    };

    // console.log("FINAL PAYLOAD:", JSON.stringify(messagePayload, null, 2));

    // -------------------------------------------------------------
    // 5. Send to Meta
    // -------------------------------------------------------------
    const sendResp = await wsService.sendTemplateMessage(
      account.phone_number_id,
      account.system_user_access_token,
      messagePayload,
    );

    // -------------------------------------------------------------
    // 6. Log message (Supabase)
    // -------------------------------------------------------------
    const log = {
      wm_id: uuidv4(),
      account_id: account.wa_id,
      to_number: to,
      template_name: template.name,
      message_body: messagePayload,
      wa_message_id: sendResp?.messages?.[0]?.id || null,
      status: sendResp.error ? "FAILED" : "SENT",
    };

    await supabase.from("whatsapp_messages").insert(log);

    // -------------------------------------------------------------
    // 7. Return Response
    // -------------------------------------------------------------
    return res.json({ success: true, sendResp, log });
  } catch (err) {
    console.error("SEND TEMPLATE ERROR:", err);
    res.status(500).json({
      error: err.response?.data || err.message,
    });
  }
}

//in bulk sending template

export async function sendTemplateBulk(req, res) {
  try {
    const templateId = req.params.templateId;
    const { user_id, recipients, components, variables } = req.body;

    if (!templateId)
      return res.status(400).json({ error: "templateId is required" });
    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    if (!Array.isArray(recipients) || recipients.length === 0)
      return res.status(400).json({ error: "recipients[] required" });

    // --------------------------------------------
    // Load WhatsApp account
    // --------------------------------------------
    const account = await getWhatsappAccount(user_id);
    if (!account)
      return res.status(400).json({ error: "WhatsApp account not found" });

    const token = account.system_user_access_token;
    const phoneNumberId = account.phone_number_id;

    if (!token || !phoneNumberId)
      return res.status(400).json({ error: "Missing WhatsApp configuration" });

    // --------------------------------------------
    // Fetch template from Meta
    // --------------------------------------------
    // const metaTemplates = await wsService.listTemplatesFromMeta(
    //   account.waba_id,
    //   token
    // );

    const metaTemplates = await wsService.listTemplatesFromDb(
      account.wa_id,
      account.waba_id,
      account.system_user_access_token,
    );

    const allTemplates = metaTemplates.data || metaTemplates || [];

    const template = allTemplates.find((t) => t.id === templateId);
    if (!template)
      return res.status(404).json({ error: "Template not found on Meta" });

    // --------------------------------------------
    // Prepare component payload once
    // --------------------------------------------
    let finalComponents = [];

    if (components && Array.isArray(components)) {
      finalComponents = components;
    } else if (variables && Array.isArray(variables)) {
      finalComponents = [
        {
          type: "body",
          parameters: variables.map((v) => ({ type: "text", text: v })),
        },
      ];
    }

    // --------------------------------------------
    // Prepare result container
    // --------------------------------------------
    const results = {
      success: [],
      failed: [],
    };

    // Simple wait function for throttling
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const progressKey = `${user_id}_${templateId}`;

    bulkProgress.set(progressKey, {
      total: recipients.length,
      completed: 0,
    });

    // --------------------------------------------
    // Loop each recipient with throttling
    // --------------------------------------------
    for (const to of recipients) {
      const payload = {
        messaging_product: "whatsapp",
        to: to,
        type: "template",
        template: {
          name: template.name,
          language: { code: template.language || "en_US" },
          components: finalComponents,
        },
      };

      try {
        const sendResp = await wsService.sendTemplateMessage(
          phoneNumberId,
          token,
          payload,
        );

        // Log success
        const log = {
          wm_id: uuidv4(),
          account_id: account.wa_id,
          to_number: to,
          template_name: template.name,
          message_body: payload,
          wa_message_id: sendResp?.messages?.[0]?.id || null,
          status: sendResp.error ? "FAILED" : "SENT",
        };

        if (!sendResp.error) {
          await supabase.from("whatsapp_messages").insert(log);

          results.success.push({ to, id: log.wm_id });
          // --------------------------------------------
          // Render message text for DB
          // --------------------------------------------
          const renderedText = renderTemplateBody(template, finalComponents);

          // --------------------------------------------
          // Detect media (optional)
          // --------------------------------------------
          const headerComp = finalComponents.find((c) => c.type === "header");

          const mediaPath =
            headerComp?.parameters?.[0]?.image?.id ||
            headerComp?.parameters?.[0]?.video?.id ||
            headerComp?.parameters?.[0]?.document?.id ||
            null;

          // --------------------------------------------
          // Create / Update Chat
          // --------------------------------------------
          const chat = await getOrCreateChat({
            phone_number: to,
            user_id: user_id,
          });

          // --------------------------------------------
          // Insert message
          // --------------------------------------------

          //checking if any button available in template
          const buttons = extractTemplateButtons(template);

          //write message
          await supabase.from("messages").insert({
            chat_id: chat.chat_id,
            sender_type: "admin",
            message: renderedText,
            message_type: "template",
            media_path: mediaPath,
            buttons,
            created_at: new Date(),
          });

          // --------------------------------------------
          // Update chat last message
          // --------------------------------------------
          await supabase
            .from("chats")
            .update({
              last_message: renderedText,
              last_message_at: new Date(),
            })
            .eq("chat_id", chat.chat_id);
        }
      } catch (err) {
        console.error("Send failed for:", to, err.message);

        results.failed.push({
          to,
          error: err.response?.data || err.message,
        });
      } finally {
        const prog = bulkProgress.get(progressKey);
        if (prog) {
          prog.completed += 1;
          bulkProgress.set(progressKey, prog);
        }
      }

      // Throttle to stay safe from Meta
      await wait(350); // 300–400ms is ideal
    }

    bulkProgress.delete(progressKey);

    return res.json({
      success: true,
      total: recipients.length,
      summary: {
        success: results.success.length,
        failed: results.failed.length,
      },
      results,
    });
  } catch (err) {
    console.error("BULK SEND ERROR:", err);
    res.status(500).json({ error: err.response?.data || err.message });
  }
}

// For getting bulk-progress of template sending
export function getBulkProgress(req, res) {
  const { user_id, templateId } = req.query;
  const key = `${user_id}_${templateId}`;

  const progress = bulkProgress.get(key);

  if (!progress) {
    return res.json({ completed: 0, total: 0 });
  }

  // console.log({ progress });

  res.json(progress);
}

export async function uploadMedia(req, res) {
  try {
    const { user_id, type } = req.body;

    if (!user_id) return res.status(400).json({ error: "user_id required" });
    if (!req.file) return res.status(400).json({ error: "file required" });

    const account = await getWhatsappAccount(user_id);
    if (!account)
      return res.status(404).json({ error: "WhatsApp account not found" });

    // Convert buffer → Blob
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype });

    // Native Node FormData (no NPM package needed)
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", type || req.file.mimetype);
    form.set("file", blob, req.file.originalname);

    // Upload to Meta
    const metaResp = await wsService.uploadMediaForMessage(
      account.phone_number_id,
      account.system_user_access_token,
      form,
    );

    // Save in database
    const insertRow = {
      account_id: account.wa_id,
      media_id: metaResp.id,
      file_name: req.file.originalname,
      type: type || req.file.mimetype,
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
    };

    await supabase.from("whatsapp_media_uploads").insert(insertRow);

    return res.json({
      success: true,
      media: metaResp,
      saved: insertRow,
    });
  } catch (err) {
    console.error("UPLOAD MEDIA ERROR:", err);
    return res.status(500).json({
      error: err.response?.data || err.message,
      debug: err,
    });
  }
}

export async function listMedia(req, res) {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: "user_id required" });

    // get whatsapp account
    const account = await getWhatsappAccount(user_id);

    const { data, error } = await supabase
      .from("whatsapp_media_uploads")
      .select("*")
      .eq("account_id", account.wa_id)
      .order("uploaded_at", { ascending: false });

    if (error) throw error;

    return res.json({ media: data });
  } catch (err) {
    console.error("LIST MEDIA ERROR:", err);
    return res.status(500).json({ error: err.message || err });
  }
}

export async function deleteMedia(req, res) {
  try {
    const { wmu_id } = req.params;
    if (!wmu_id) return res.status(400).json({ error: "wmu_id required" });

    // Get media row
    const { data: media, error: mediaErr } = await supabase
      .from("whatsapp_media_uploads")
      .select("*")
      .eq("wmu_id", wmu_id)
      .single();

    if (mediaErr || !media)
      return res.status(404).json({ error: "Media record not found" });

    // Get WhatsApp account
    const { data: account } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("wa_id", media.account_id)
      .single();

    if (!account || !account.system_user_access_token)
      return res.status(400).json({ error: "Account missing token" });

    // ---- DELETE FROM META ----
    const metaResult = await wsService.deleteMediaFromMeta(
      media.media_id,
      account.system_user_access_token,
    );

    if (!metaResult.success) {
      console.warn("META DELETE FAILED → continuing:", metaResult.error);
    }

    // ---- DELETE FROM DATABASE ----
    await supabase.from("whatsapp_media_uploads").delete().eq("wmu_id", wmu_id);

    return res.json({
      success: true,
      deleted: wmu_id,
      meta: metaResult,
    });
  } catch (err) {
    console.error("DELETE MEDIA ERROR:", err);
    return res.status(500).json({ error: err.message || err });
  }
}

//List meta template
export async function listMetaTemplates(req, res) {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    const account = await getWhatsappAccount(user_id);

    //fetch from meta
    // const data = await wsService.listTemplatesFromMeta(
    //   account.waba_id,
    //   account.system_user_access_token,
    // );

    //fetch from database
    const data = await wsService.listTemplatesFromDb(
      account.wa_id,
      account.waba_id,
      account.system_user_access_token,
    );

    res.json({ templates: data.data || data || [] });
  } catch (err) {
    console.error("LIST META TEMPLATES ERROR:", err);
    res.status(500).json({ error: err.message || err });
  }
}

// Get a single meta template by templateId
export async function getSingleMetaTemplate(req, res) {
  try {
    const user_id = req.query.user_id;
    const templateId = req.query?.templateId;
    const templateName = req.query?.templateName;

    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    if (!templateId && !templateName)
      return res
        .status(400)
        .json({ error: "templateId or templateName is required" });

    // Fetch WhatsApp account details
    const account = await getWhatsappAccount(user_id);

    // Fetch all templates from Meta
    // const data = await wsService.listTemplatesFromMeta(
    //   account.waba_id,
    //   account.system_user_access_token
    // );

    const data = await wsService.listTemplatesFromDb(
      account.wa_id,
      account.waba_id,
      account.system_user_access_token,
    );

    const templates = data.data || data || [];

    // Find template by id

    let template;

    if (templateId) {
      template = templates.find((tpl) => tpl.id === templateId);
    } else if (templateName) {
      template = templates.find((tpl) => tpl.name === templateName);
    }
    // const template = templates.find((tpl) => tpl.id === templateId);

    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }

    res.json({ template });
  } catch (err) {
    console.error("GET META TEMPLATE ERROR:", err);
    res.status(500).json({ error: err.message || err });
  }
}

//get media proxy url for uploaded media files
export async function mediaProxy(req, res) {
  try {
    const mediaId = req.params.mediaId;
    const user_id = req.query.user_id;

    if (!mediaId) return res.status(400).json({ error: "mediaId required" });

    if (!user_id) return res.status(400).json({ error: "user_id required" });

    const account = await getWhatsappAccount(user_id);

    // 1) Get temp URL from Meta
    const meta = await wsService.getMediaMeta(
      mediaId,
      account.system_user_access_token,
    );

    if (!meta.url)
      return res.status(400).json({ error: "Meta returned no url", meta });

    // 2) Fetch actual file stream
    const fileRes = await wsService.fetchMediaFile(
      meta.url,
      account.system_user_access_token,
    );

    // 3) Return file stream to client
    res.setHeader("Content-Type", meta.mime_type || "application/octet-stream");
    fileRes.data.pipe(res);
  } catch (err) {
    console.error("MEDIA PROXY ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: err.message || "Media proxy failed" });
  }
}

export async function mediaProxyUrl(req, res) {
  try {
    const fileUrl = req.query.url;
    const user_id = req.query.user_id;

    if (!fileUrl) {
      return res.status(400).json({ error: "Missing url parameter" });
    }

    if (!user_id) {
      return res.status(400).json({ error: "Missing user_id parameter" });
    }

    // 🔥 Load WhatsApp Account from DB
    const account = await getWhatsappAccount(user_id);

    const accessToken = account.system_user_access_token;

    // Fetch the actual file from Meta CDN
    const fileRes = await fetch(fileUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!fileRes.ok) {
      const errText = await fileRes.text();
      return res.status(500).json({
        error: "Error fetching media",
        debug: errText,
      });
    }

    // Detect content type (image/png, video/mp4, etc.)
    const contentType = fileRes.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);

    // Stream file to frontend
    fileRes.body.pipe(res);
  } catch (err) {
    console.error("Media Proxy URL Error:", err);
    res.status(500).json({ error: err.message });
  }
}

export async function deleteMetaTemplate(req, res) {
  try {
    const { templateId } = req.params;
    const { user_id, template_name } = req.query;

    if (!user_id) return res.status(400).json({ error: "user_id is required" });
    if (!templateId)
      return res.status(400).json({ error: "templateId is required" });

    // Load WhatsApp Account
    const account = await getWhatsappAccount(user_id);
    if (!account)
      return res.status(400).json({ error: "WhatsApp account not found" });

    if (!account.system_user_access_token)
      return res
        .status(400)
        .json({ error: "Missing system_user_access_token" });

    // Fetch Template list from Meta
    // const metaTemplates = await wsService.listTemplatesFromMeta(
    //   account.waba_id,
    //   account.system_user_access_token
    // );

    // const allTemplates = metaTemplates.data || [];

    // // Find template by ID
    // const tpl = allTemplates.find((t) => t.id === templateId);

    // if (!tpl) {
    //   return res.status(404).json({
    //     error: "Template not found on Meta",
    //   });
    // }

    // Perform delete API call
    const deleteResp = await wsService.deleteMetaTemplate(
      account.waba_id,
      account.system_user_access_token,
      templateId,
      template_name,
    );

    // Optionally delete it from your supabase DB also (if stored)
    try {
      await supabase
        .from("whatsapp_templates")
        .delete()
        .eq("template_id", templateId); // adjust column name if different
    } catch (dbErr) {
      console.warn("Could not delete from local DB:", dbErr.message);
    }

    // return res.json({
    //   success: true,
    //   message: "Template deleted successfully",
    //   deleteResp,
    // });

    return res.json({
      success: true,
      message: "Template deleted successfully",
      meta: deleteResp.data || { success: true },
    });
  } catch (err) {
    console.error("DELETE META TEMPLATE ERROR:", err);
    res.status(500).json({
      error: err.response?.data || err.message,
    });
  }
}
