/* adapters.js
 * Convert internal message format to provider-specific message payloads.
 * Exports: formatOpenAIMessage, formatGeminiMessage, formatClaudeMessage
 */

export function formatOpenAIMessage(internalMessages) {
  const messages = internalMessages.map((m) => {
    const role = m.role || "user";

    if (hasImages(m)) {
      return {
        role,
        content: buildVisionContent(m)
      };
    }

    return { role, content: m.text || "" };
  });

  return { messages };
}

export function formatGeminiMessage(internalMessages) {
  const messages = internalMessages.map((m) => {
    const role = m.role || "user";

    if (hasImages(m)) {
      return {
        role,
        content: buildVisionContent(m)
      };
    }

    return { role, content: m.text || "" };
  });

  return { messages };
}

export function formatClaudeMessage(internalMessages) {
  const messages = internalMessages.map((m) => {
    const role = m.role || "user";
    let content = "";

    if (m.text) content += m.text;

    for (const image of normalizeImages(m)) {
      const url = image.dataUrl || image.url;
      if (url) {
        content += `\n[Image attached]\n${url}`;
      }
    }

    return { role, content };
  });

  return { messages };
}

function hasImages(message) {
  return normalizeImages(message).length > 0;
}

function normalizeImages(message) {
  if (Array.isArray(message.images)) {
    return message.images;
  }

  if (message.image) {
    return [message.image];
  }

  return [];
}

function buildVisionContent(message) {
  const content = [];

  if (message.text) {
    content.push({
      type: "text",
      text: String(message.text)
    });
  }

  for (const image of normalizeImages(message)) {
    const url = image.dataUrl || image.url;

    if (url) {
      content.push({
        type: "image_url",
        image_url: { url }
      });
    }
  }

  return content.length ? content : [{ type: "text", text: "" }];
}

export default { formatOpenAIMessage, formatGeminiMessage, formatClaudeMessage };
