// services/whatsappTemplateService.js
import axios from "axios";
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

export async function checkTemplateStatusOnMeta(templateId, systemToken) {
  const url = `${GRAPH}/${templateId}?fields=status,name`;
  const resp = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${systemToken}`,
      "Content-Type": "application/json",
    },
  });
  return resp.data;
}

export async function createUploadSession(
  appId,
  userToken,
  { file_name, file_type }
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
  accessToken
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
  formData
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
export async function listTemplatesFromMeta(wabaId, userToken) {
  const url = `https://graph.facebook.com/v20.0/${wabaId}/message_templates`;

  const resp = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${userToken}`,
    },
  });

  return resp.data;
}

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
