// services/whatsappTemplateService.js
import axios from "axios";
import { supabase } from "../config/supabase.js";

const GRAPH = `https://graph.facebook.com/${
  process.env.GRAPH_API_VERSION || "v24.0"
}`;

export async function createTemplateOnMeta(wabaId, systemToken, payload) {
  const url = `${GRAPH}/${wabaId}/message_templates`;
  const resp = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${systemToken}`,
      "Content-Type": "application/json",
    },
  });
  return resp.data;
}

// export async function checkTemplateStatusOnMeta(templateId, systemToken) {
//   const url = `${GRAPH}/${templateId}?fields=status,name`;
//   const resp = await axios.get(url, {
//     headers: {
//       Authorization: `Bearer ${systemToken}`,
//       "Content-Type": "application/json",
//     },
//   });
//   return resp.data;
// }

export async function checkTemplateStatusOnMeta(
  wabaId,
  templateName,
  systemToken,
) {
  const url = `${GRAPH}/${wabaId}/message_templates`;

  // console.log({ wabaId, templateName, systemToken });

  const resp = await axios.get(url, {
    params: { name: templateName },
    headers: {
      Authorization: `Bearer ${systemToken}`,
    },
  });

  // console.log({ temData: resp.data });

  if (!resp.data?.data?.length) {
    return {
      exists: false,
      status: "NOT_FOUND",
    };
  }

  const template = resp.data.data[0];

  return {
    exists: true,
    id: template.id,
    name: template.name,
    status: template.status,
    language: template.language,
    category: template.category,
    template: template,
  };
}

export async function createUploadSession(
  appId,
  userToken,
  { file_name, file_type },
) {
  const url = `${GRAPH}/${appId}/uploads`;
  const params = { file_name, file_type, access_token: userToken };
  const resp = await axios.post(url, null, { params });
  return resp.data;
}

export async function uploadBinaryToSession(
  sessionId,
  buffer,
  contentType = "application/octet-stream",
  accessToken,
) {
  const url = `${GRAPH}/${sessionId}`;
  const headers = {
    "Content-Type": "application/octet-stream",
    "File-Offset": "0",
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const resp = await axios.post(url, buffer, { headers });
  return resp.data;
}

export async function uploadMediaForMessage(
  phoneNumberId,
  userToken,
  formData,
) {
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/media`;

  const resp = await axios.post(url, formData, {
    headers: {
      Authorization: `Bearer ${userToken}`,
    },
  });

  return resp.data;
}

export function buildTemplateMessagePayload({
  templateName,
  languageCode = "en_US",
  variables = [],
  media = null,
}) {
  const components = [];
  if (media) {
    const mediaType = media.type === "video" ? "video" : "image";
    const headerParam = [];
    if (media.id)
      headerParam.push({ type: mediaType, [mediaType]: { id: media.id } });
    else if (media.link)
      headerParam.push({ type: mediaType, [mediaType]: { link: media.link } });
    if (headerParam.length)
      components.push({ type: "header", parameters: headerParam });
  }
  components.push({
    type: "body",
    parameters: (variables || []).map((v) => ({ type: "text", text: v })),
  });

  return {
    messaging_product: "whatsapp",
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components,
    },
  };
}

export async function sendTemplateMessage(phoneNumberId, userToken, payload) {
  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;
  const resp = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${userToken}`,
      "Content-Type": "application/json",
    },
  });
  return resp.data;
}

export async function deleteMediaFromMeta(mediaId, userToken) {
  try {
    const url = `https://graph.facebook.com/v20.0/${mediaId}`;

    const resp = await axios.delete(url, {
      headers: {
        Authorization: `Bearer ${userToken}`,
      },
    });

    return { success: true, resp: resp.data };
  } catch (err) {
    console.error("META DELETE ERROR:", err.response?.data || err.message);
    return { success: false, error: err.response?.data || err.message };
  }
}

// List message templates from Meta
// export async function listTemplatesFromMeta(wabaId, userToken) {
//   // const url = `https://graph.facebook.com/v20.0/${wabaId}/message_templates`;

//   const url = `https://graph.facebook.com/v23.0/${wabaId}/message_templates`;

//   const resp = await axios.get(url, {
//     headers: {
//       Authorization: `Bearer ${userToken}`,
//     },
//   });

//   console.log({ template: resp.data });

//   return resp.data;
// }

export async function listTemplatesFromMeta(wabaId, userToken) {
  let allTemplates = [];
  let nextUrl = `https://graph.facebook.com/v23.0/${wabaId}/message_templates?limit=100`;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  while (nextUrl) {
    try {
      const resp = await axios.get(nextUrl, {
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      allTemplates.push(...(resp.data?.data || []));
      nextUrl = resp.data?.paging?.next || null;

      await sleep(200); // 👈 VERY IMPORTANT
    } catch (err) {
      console.error(
        "Meta template fetch failed:",
        err.response?.data || err.message,
      );
      throw err;
    }
  }
  // console.log({ allTemplates });
  return allTemplates;
}

// export async function listTemplatesFromDb(accountId) {
//   const { data, error } = await supabase
//     .from("whatsapp_templates")
//     .select("preview")
//     .eq("account_id", accountId)
//     .not("preview", "is", null);

//   if (error) {
//     console.error("DB template fetch failed:", error);
//     throw error;
//   }

//   // Extract preview objects (same structure as Meta)
//   const templates = data.map((row) => row.preview).filter(Boolean);

//   return {
//     data: templates, // 👈 matches Meta response shape
//   };
// }

export async function listTemplatesFromDb(accountId, wabaId, systemToken) {
  // 1. Fetch templates from DB
  const { data, error } = await supabase
    .from("whatsapp_templates")
    .select("wt_id, status, preview")
    .eq("account_id", accountId)
    .not("preview", "is", null);

  if (error) {
    console.error("DB template fetch failed:", error);
    throw error;
  }

  const templates = [];

  // 2. Loop through templates
  for (const row of data) {
    let preview = row.preview;
    let status = row.status;

    // 3. Sync only if status is PENDING
    if (preview?.status === "PENDING") {
      try {
        const metaStatus = await checkTemplateStatusOnMeta(
          wabaId,
          preview.name,
          systemToken,
        );

        if (metaStatus.exists) {
          preview = metaStatus.template;
          status = metaStatus.status;

          // 4. Update DB (status + preview)
          await supabase
            .from("whatsapp_templates")
            .update({
              status,
              preview,
            })
            .eq("wt_id", row.wt_id);
        }
      } catch (e) {
        console.warn(
          `Template status check failed for ${preview?.name}:`,
          e.message,
        );
      }
    }

    templates.push(preview);
  }

  // 5. Return Meta-like response
  return {
    data: templates,
  };
}

// export async function syncPendingTemplatesFromMeta(
//   accountId,
//   wabaId,
//   systemToken
// ) {
//   // 1. Fetch templates from DB
//   const { data: dbTemplates } = await listTemplatesFromDb(accountId);

//   // 2. Find pending ones
//   const pendingTemplates = dbTemplates.filter((t) => t.status === "PENDING");

//   console.log({ pendingTemplates, totalPending: pendingTemplates.length });

//   // Nothing to do → skip Meta
//   if (!pendingTemplates.length) {
//     return { synced: 0 };
//   }

//   // 3. Fetch all templates from Meta ONCE
//   const metaTemplates = await listTemplatesFromMeta(wabaId, systemToken);

//   console.log({ metaTemplates, totalPending: metaTemplates.length });

//   const metaMap = new Map(metaTemplates.map((t) => [t.name, t]));

//   let updatedCount = 0;

//   // 4. Update only pending templates
//   for (const pending of pendingTemplates) {
//     const metaTemplate = metaMap.get(pending.name);

//     console.log({ metaTemplate });

//     if (!metaTemplate) continue;

//     // Status still pending → skip
//     if (metaTemplate.status === "PENDING") continue;

//     // 5. Update DB
//     const { error } = await supabase
//       .from("whatsapp_templates")
//       .update({
//         status: metaTemplate.status,
//         preview: metaTemplate,
//         updated_at: new Date().toISOString(),
//       })
//       .eq("account_id", accountId)
//       .eq("template_name", metaTemplate.name);

//     if (!error) updatedCount++;
//   }

//   return { synced: updatedCount };
// }

//stream media files from meta url for media uploaded
export async function getMediaMeta(mediaId, userToken) {
  const url = `https://graph.facebook.com/v20.0/${mediaId}`;

  const resp = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${userToken}`,
    },
  });

  return resp.data; // contains .url + .mime_type
}

export async function fetchMediaFile(url, userToken) {
  const resp = await axios.get(url, {
    responseType: "stream",
    headers: { Authorization: `Bearer ${userToken}` },
  });

  return resp; // axios stream
}

export async function deleteMetaTemplate(wabaId, accessToken, hsmId, name) {
  const url = `https://graph.facebook.com/v23.0/${wabaId}/message_templates`;

  return axios.delete(url, {
    params: {
      hsm_id: hsmId,
      name: name,
    },
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
}
