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

    return withToolCalls({ role, content: m.text || "" }, m);
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

    return withToolCalls({ role, content: m.text || "" }, m);
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

    return withToolCalls({ role, content }, m);
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

function withToolCalls(message, internalMessage) {
  if (!Array.isArray(internalMessage.toolCalls) || internalMessage.toolCalls.length === 0) {
    return message;
  }

  return {
    ...message,
    tool_calls: internalMessage.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: typeof toolCall.arguments === "string"
          ? toolCall.arguments
          : JSON.stringify(toolCall.arguments ?? {})
      }
    }))
  };
}

export default { formatOpenAIMessage, formatGeminiMessage, formatClaudeMessage };
