import { getDefaultModel } from "./config.js";
import { httpError } from "./errors.js";
import { normalizeImageUrlPart, validateUploadedImage } from "./imageValidation.js";

export function normalizeOpenAIChatBody(body) {
  const normalized = { ...body };

  if (typeof normalized.messages === "string") {
    try {
      normalized.messages = JSON.parse(normalized.messages);
    } catch {
      throw httpError(400, "invalid_messages", "messages must be a valid JSON array", "messages");
    }
  }

  if (!normalized.messages && (normalized.message || normalized.prompt)) {
    normalized.messages = [
      {
        role: "user",
        content: normalized.message || normalized.prompt
      }
    ];
  }

  normalized.model = normalized.model || normalized.model_name || getDefaultModel();

  if (!normalized.tools && Array.isArray(normalized.functions)) {
    normalized.tools = normalized.functions.map((fn) => ({
      type: "function",
      function: fn
    }));
  }

  if (!normalized.tool_choice && normalized.function_call) {
    normalized.tool_choice = normalized.function_call === "auto" || normalized.function_call === "none"
      ? normalized.function_call
      : {
        type: "function",
        function: {
          name: normalized.function_call.name
        }
      };
  }

  return normalized;
}

export async function buildLegacyInternalMessages(message, file) {
  const images = [];

  if (file) {
    images.push(await validateUploadedImage(file));
  }

  return [{
    role: "user",
    text: message,
    images
  }];
}

export async function buildOpenAIInternalMessages(messages, file = null) {
  const internalMessages = [];

  for (const message of messages) {
    internalMessages.push(await normalizeOpenAIMessage(message));
  }

  if (file) {
    const uploadedImage = await validateUploadedImage(file);
    const lastUserMessage = [...internalMessages].reverse().find((message) => message.role === "user");

    if (lastUserMessage) {
      lastUserMessage.images.push(uploadedImage);
    } else {
      internalMessages.push({
        role: "user",
        text: "",
        images: [uploadedImage]
      });
    }
  }

  return internalMessages;
}

export function responsesInputToMessages(input) {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (!Array.isArray(input)) {
    throw httpError(400, "invalid_request_error", "Responses API input must be a string or an array", "input");
  }

  return input.map((item) => {
    if (item?.type === "message") {
      return {
        role: item.role || "user",
        content: item.content ?? ""
      };
    }

    if (item?.role) {
      return {
        role: item.role,
        content: item.content ?? ""
      };
    }

    if (item?.type === "input_text") {
      return {
        role: "user",
        content: item.text || ""
      };
    }

    if (item?.type === "function_call") {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id || item.id,
            type: "function",
            function: {
              name: item.name,
              arguments: item.arguments || "{}"
            }
          }
        ]
      };
    }

    if (item?.type === "function_call_output") {
      return {
        role: "tool",
        tool_call_id: item.call_id,
        content: item.output || ""
      };
    }

    throw httpError(400, "invalid_request_error", "Unsupported Responses API input item", "input");
  });
}

async function normalizeOpenAIMessage(message) {
  const originalRole = message.role || "user";
  const role = normalizeRole(originalRole);
  const content = message.content;

  if (content == null) {
    return {
      role,
      text: decorateMessageText("", originalRole, message),
      images: [],
      toolCalls: normalizeMessageToolCalls(message.tool_calls)
    };
  }

  if (typeof content === "string") {
    return {
      role,
      text: decorateMessageText(content, originalRole, message),
      images: [],
      toolCalls: normalizeMessageToolCalls(message.tool_calls)
    };
  }

  if (!Array.isArray(content)) {
    throw httpError(400, "invalid_message_content", "message.content must be a string or content part array", "messages");
  }

  const textParts = [];
  const images = [];

  for (const part of content) {
    if (!part || typeof part !== "object") {
      throw httpError(400, "invalid_message_content_part", "content parts must be objects", "messages");
    }

    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      textParts.push(String(part.text || ""));
      continue;
    }

    if (part.type === "image_url" || part.type === "input_image") {
      images.push(await normalizeImageUrlPart(part));
      continue;
    }

    if (typeof part.text === "string") {
      textParts.push(part.text);
      continue;
    }

    throw httpError(400, "unsupported_message_content_part", `Unsupported content part type: ${part.type || "unknown"}`, "messages");
  }

  return {
    role,
    text: decorateMessageText(textParts.filter(Boolean).join("\n"), originalRole, message),
    images,
    toolCalls: normalizeMessageToolCalls(message.tool_calls)
  };
}

function normalizeRole(role) {
  if (role === "developer") {
    return "system";
  }

  if (role === "tool") {
    return "user";
  }

  return role || "user";
}

function decorateMessageText(text, originalRole, message) {
  if (originalRole === "tool") {
    const name = message.name || message.tool_call_id || "tool";
    return `Tool result (${name}):\n${text}`;
  }

  if (originalRole === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return [
      text,
      `Assistant tool calls:\n${JSON.stringify(normalizeMessageToolCalls(message.tool_calls))}`
    ].filter(Boolean).join("\n");
  }

  return text;
}

function normalizeMessageToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return [];
  }

  return toolCalls
    .filter((toolCall) => toolCall?.function?.name)
    .map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments
    }));
}
