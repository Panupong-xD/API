/* adapters.js
 * Convert internal message format to provider-specific message payloads.
 * Exports: formatOpenAIMessage, formatGeminiMessage, formatClaudeMessage
 */

export function formatOpenAIMessage(internalMessages) {
  // OpenAI-like chat expects an array of { role, content }
  const messages = internalMessages.map((m) => {
    const role = m.role || "user";
    let content = "";
    if (m.text) content += String(m.text);
    if (m.image && m.image.dataUrl) {
      // embed image as an inline note (OpenAI chat does not accept images in messages by default)
      content += `\n[Image embedded as data URL]\n${m.image.dataUrl}`;
    }
    return { role, content };
  });

  return { messages };
}

export function formatGeminiMessage(internalMessages) {
  // Gemini/Google often supports mixed content objects. We keep image as image_url object.
  const messages = internalMessages.map((m) => {
    const role = m.role || "user";
    if (m.image && m.image.dataUrl) {
      return {
        role,
        content: [
          { type: "text", text: m.text || "" },
          { type: "image_url", image_url: { url: m.image.dataUrl } }
        ]
      };
    }
    return { role, content: m.text || "" };
  });

  return { messages };
}

export function formatClaudeMessage(internalMessages) {
  // Claude accepts text-first messages. Attach image data as inline text.
  const messages = internalMessages.map((m) => {
    const role = m.role || "user";
    let content = "";
    if (m.text) content += m.text;
    if (m.image && m.image.dataUrl) {
      content += `\n[Image data URL attached]\n${m.image.dataUrl}`;
    }
    return { role, content };
  });

  return { messages };
}

export default { formatOpenAIMessage, formatGeminiMessage, formatClaudeMessage };
