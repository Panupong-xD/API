import { getStreamChunkSize, toolsCompatModeEnabled } from "../utils/config.js";
import { httpError } from "../utils/errors.js";
import { formatForProvider } from "../utils/providerAdapters.js";
import {
  buildToolPromptMessages,
  maxToolAttempts,
  normalizeToolAwareModelOutput,
  normalizeToolChoice,
  normalizeTools,
  toOpenAIChatTools
} from "../utils/toolUtils.js";
import { chat, chatCompletion } from "./swuClient.js";

export async function runOpenAICompletion({ model, internalMessages, tools = [], tool_choice: toolChoice }) {
  const upstreamMessages = formatForProvider(model, internalMessages);
  const normalizedTools = normalizeTools(tools);
  const normalizedToolChoice = normalizeToolChoice(toolChoice, normalizedTools);

  if (normalizedTools.length === 0 && normalizedToolChoice.mode !== "auto" && normalizedToolChoice.mode !== "none") {
    throw httpError(400, "invalid_tool_choice", "tool_choice requires at least one tool", "tool_choice");
  }

  if (normalizedToolChoice.mode === "none" || normalizedTools.length === 0) {
    const reply = await chat(upstreamMessages, model);
    return {
      content: serializeReply(reply),
      toolCalls: [],
      finishReason: "stop"
    };
  }

  if (toolsCompatModeEnabled()) {
    return runEmulatedToolCompletion({
      model,
      messages: upstreamMessages,
      tools: normalizedTools,
      toolChoice: normalizedToolChoice
    });
  }

  const raw = await chatCompletion({
    model,
    messages: upstreamMessages,
    tools: toOpenAIChatTools(normalizedTools),
    tool_choice: normalizedToolChoice.raw
  });

  return normalizeToolAwareModelOutput(raw, normalizedTools, normalizedToolChoice);
}

export async function writeLegacyStream(res, model, internalMessages) {
  const upstreamMessages = formatForProvider(model, internalMessages);
  const reply = await chat(upstreamMessages, model);
  const text = serializeReply(reply);
  const chunkSize = getStreamChunkSize();

  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    res.write(`data: ${chunk.replace(/\n/g, "\\n")}\n\n`);
    await delay(5);
  }

  res.write("event: done\ndata: {}\n\n");
}

async function runEmulatedToolCompletion({ model, messages, tools, toolChoice }) {
  const attempts = maxToolAttempts();
  let previousError = null;
  let lastContent = "";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const promptedMessages = buildToolPromptMessages(messages, tools, toolChoice, attempt, previousError);
    const raw = await chat(promptedMessages, model);
    const content = serializeReply(raw);
    lastContent = content;

    try {
      const result = normalizeToolAwareModelOutput(content, tools, toolChoice);

      if (result.toolCalls.length === 0 && result.parseError) {
        throw httpError(502, "invalid_tool_call", result.parseError, "tool_calls");
      }

      if (result.toolCalls.length === 0 && (toolChoice.mode === "required" || toolChoice.mode === "function")) {
        throw httpError(502, "tool_call_failed", "Model did not return a required tool call", "tool_calls");
      }

      return result;
    } catch (err) {
      previousError = err.message;

      if (attempt >= attempts - 1) {
        if (toolChoice.mode === "auto") {
          return {
            content: lastContent,
            toolCalls: [],
            finishReason: "stop"
          };
        }

        throw err;
      }
    }
  }

  if (toolChoice.mode === "required" || toolChoice.mode === "function") {
    throw httpError(502, "tool_call_failed", "Model did not return a valid required tool call", "tool_calls");
  }

  return {
    content: lastContent,
    toolCalls: [],
    finishReason: "stop"
  };
}

function serializeReply(reply) {
  if (typeof reply === "string") {
    return reply;
  }

  if (reply == null) {
    return "";
  }

  return JSON.stringify(reply);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
