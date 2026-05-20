import { randomUUID } from "crypto";

import { getToolsRetryMax } from "./config.js";
import { httpError } from "./errors.js";

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function normalizeTools(tools = []) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return [];
  }

  return tools.map((tool, index) => {
    if (tool?.type !== "function") {
      throw httpError(400, "unsupported_tool_type", "Only function tools are supported", `tools.${index}.type`);
    }

    const fn = tool.function || tool;
    const name = fn.name;

    if (!TOOL_NAME_RE.test(String(name || ""))) {
      throw httpError(400, "invalid_tool_name", "Function tool names must match ^[a-zA-Z0-9_-]{1,64}$", `tools.${index}.function.name`);
    }

    const parameters = fn.parameters && typeof fn.parameters === "object"
      ? fn.parameters
      : { type: "object", properties: {} };

    return {
      type: "function",
      function: {
        name,
        description: fn.description || "",
        parameters
      }
    };
  });
}

export function normalizeToolChoice(toolChoice, tools) {
  if (toolChoice == null) {
    return { mode: "auto", raw: undefined };
  }

  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return { mode: toolChoice, raw: toolChoice };
  }

  if (typeof toolChoice === "object") {
    const name = toolChoice.function?.name || toolChoice.name;
    if (!name) {
      throw httpError(400, "invalid_tool_choice", "tool_choice.function.name is required", "tool_choice");
    }

    if (!tools.some((tool) => tool.function.name === name)) {
      throw httpError(400, "invalid_tool_choice", `Unknown tool_choice function: ${name}`, "tool_choice");
    }

    return {
      mode: "function",
      name,
      raw: {
        type: "function",
        function: { name }
      }
    };
  }

  throw httpError(400, "invalid_tool_choice", "tool_choice must be auto, none, required, or a function choice object", "tool_choice");
}

export function toOpenAIChatTools(tools) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    }
  }));
}

export function buildToolPromptMessages(messages, tools, toolChoice, attempt = 0, previousError = null) {
  const instructions = [
    "You are connected to external tools through an OpenAI-compatible gateway.",
    "When a tool is needed, respond only with valid JSON and no markdown.",
    "Use exactly this JSON shape:",
    "{\"tool_calls\":[{\"name\":\"tool_name\",\"arguments\":{\"key\":\"value\"}}]}",
    "If no tool is needed, answer normally in plain text.",
    "Do not invent tools. Do not include comments or trailing commas."
  ];

  if (toolChoice.mode === "required") {
    instructions.push("You must call at least one available tool.");
  }

  if (toolChoice.mode === "function") {
    instructions.push(`You must call the tool named ${JSON.stringify(toolChoice.name)}.`);
  }

  if (previousError) {
    instructions.push(`Your previous tool-call JSON was invalid: ${previousError}. Return corrected JSON only.`);
  } else if (attempt > 0) {
    instructions.push("Retry with corrected tool-call JSON only.");
  }

  const toolCatalog = tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description || "",
    parameters: tool.function.parameters || { type: "object", properties: {} }
  }));

  return [
    {
      role: "system",
      content: `${instructions.join("\n")}\n\nAvailable tools:\n${JSON.stringify(toolCatalog, null, 2)}`
    },
    ...messages
  ];
}

export function normalizeToolAwareModelOutput(output, tools, toolChoice = { mode: "auto" }) {
  const nativeToolCalls = extractNativeToolCalls(output);
  if (nativeToolCalls.length > 0) {
    return finalizeToolCalls(nativeToolCalls, tools, toolChoice);
  }

  const content = extractText(output);
  const parsed = parseToolCallsFromText(content);

  if (parsed.toolCalls.length > 0) {
    return finalizeToolCalls(parsed.toolCalls, tools, toolChoice);
  }

  if (parsed.error && isToolRequired(toolChoice)) {
    return {
      content,
      toolCalls: [],
      finishReason: "stop",
      parseError: parsed.error
    };
  }

  return {
    content: cleanTextOutput(content),
    toolCalls: [],
    finishReason: "stop",
    parseError: parsed.error
  };
}

export function parseToolCallsFromText(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { toolCalls: [], error: null };
  }

  const candidates = extractJsonCandidates(text);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const toolCalls = normalizeToolCallPayload(parsed);

      if (toolCalls.length > 0) {
        return { toolCalls, error: null };
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  if (looksLikeToolJson(text)) {
    return { toolCalls: [], error: lastError || "No valid tool_calls JSON found" };
  }

  return { toolCalls: [], error: null };
}

export function formatToolCallsForOpenAI(toolCalls) {
  return toolCalls.map((toolCall) => ({
    id: toolCall.id || `call_${randomUUID().replace(/-/g, "")}`,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: stringifyArguments(toolCall.arguments)
    }
  }));
}

export function maxToolAttempts() {
  return getToolsRetryMax() + 1;
}

function finalizeToolCalls(toolCalls, tools, toolChoice) {
  const validated = [];

  for (const toolCall of toolCalls) {
    const tool = tools.find((candidate) => candidate.function.name === toolCall.name);
    if (!tool) {
      throw httpError(502, "invalid_tool_call", `Model requested unknown tool: ${toolCall.name}`, "tool_calls");
    }

    if (toolChoice.mode === "function" && toolCall.name !== toolChoice.name) {
      throw httpError(502, "invalid_tool_call", `Model requested ${toolCall.name}, but tool_choice requires ${toolChoice.name}`, "tool_calls");
    }

    const args = parseArguments(toolCall.arguments);
    const validationErrors = validateToolArguments(args, tool.function.parameters);

    if (validationErrors.length > 0) {
      throw httpError(502, "invalid_tool_arguments", validationErrors.join("; "), "tool_calls");
    }

    validated.push({
      id: toolCall.id,
      name: toolCall.name,
      arguments: args
    });
  }

  if (validated.length === 0 && isToolRequired(toolChoice)) {
    throw httpError(502, "tool_call_failed", "Model did not return a required tool call", "tool_calls");
  }

  return {
    content: null,
    toolCalls: formatToolCallsForOpenAI(validated),
    finishReason: "tool_calls",
    parseError: null
  };
}

export function validateToolArguments(value, schema, path = "arguments") {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const errors = [];
  const expectedType = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];

  if (expectedType.length && !expectedType.some((type) => matchesJsonSchemaType(value, type))) {
    errors.push(`${path} must be ${expectedType.join(" or ")}`);
    return errors;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }

  if (schema.type === "object" || schema.properties || schema.required) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path} must be an object`);
      return errors;
    }

    for (const requiredKey of schema.required || []) {
      if (!(requiredKey in value)) {
        errors.push(`${path}.${requiredKey} is required`);
      }
    }

    for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
      if (key in value) {
        errors.push(...validateToolArguments(value[key], propertySchema, `${path}.${key}`));
      }
    }

    if (schema.additionalProperties === false) {
      const allowedKeys = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) {
          errors.push(`${path}.${key} is not allowed`);
        }
      }
    }
  }

  if (schema.type === "array" || schema.items) {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return errors;
    }

    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateToolArguments(item, schema.items, `${path}.${index}`));
      });
    }
  }

  return errors;
}

function normalizeToolCallPayload(parsed) {
  const list = [];

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      list.push(...normalizeToolCallPayload(item));
    }
    return list;
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  if (Array.isArray(parsed.tool_calls)) {
    return parsed.tool_calls.flatMap((item) => normalizeToolCallPayload(item));
  }

  if (parsed.tool_call) {
    return normalizeToolCallPayload(parsed.tool_call);
  }

  if (parsed.function_call) {
    return normalizeToolCallPayload(parsed.function_call);
  }

  const name = parsed.name || parsed.function?.name;
  const args = parsed.arguments ?? parsed.args ?? parsed.input ?? parsed.function?.arguments ?? {};

  if (name) {
    return [{
      id: parsed.id,
      name,
      arguments: args
    }];
  }

  return [];
}

function extractNativeToolCalls(output) {
  const choices = Array.isArray(output?.choices) ? output.choices : [];
  const toolCalls = [];

  for (const choice of choices) {
    const calls = choice?.message?.tool_calls || choice?.delta?.tool_calls;
    if (Array.isArray(calls)) {
      toolCalls.push(...calls.map((call) => ({
        id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments ?? {}
      })));
    }

    if (choice?.message?.function_call) {
      toolCalls.push({
        name: choice.message.function_call.name,
        arguments: choice.message.function_call.arguments ?? {}
      });
    }
  }

  return toolCalls.filter((toolCall) => toolCall.name);
}

function extractText(output) {
  if (typeof output === "string") {
    return output;
  }

  if (output == null) {
    return "";
  }

  const messageContent = output?.choices?.[0]?.message?.content;
  if (typeof messageContent === "string") {
    return messageContent;
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .map((part) => part?.text || part?.content || "")
      .filter(Boolean)
      .join("\n");
  }

  if (typeof output.reply === "string") {
    return output.reply;
  }

  if (typeof output.response === "string") {
    return output.response;
  }

  return JSON.stringify(output);
}

function parseArguments(argumentsValue) {
  if (typeof argumentsValue === "string") {
    try {
      const trimmed = argumentsValue.trim();
      return trimmed ? JSON.parse(trimmed) : {};
    } catch {
      throw httpError(502, "invalid_tool_arguments", "Tool arguments must be valid JSON", "tool_calls");
    }
  }

  if (argumentsValue == null) {
    return {};
  }

  if (typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    throw httpError(502, "invalid_tool_arguments", "Tool arguments must be a JSON object", "tool_calls");
  }

  return argumentsValue;
}

function stringifyArguments(argumentsValue) {
  if (typeof argumentsValue === "string") {
    return argumentsValue;
  }

  return JSON.stringify(argumentsValue ?? {});
}

function extractJsonCandidates(text) {
  const candidates = [];
  const trimmed = text.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    candidates.push(trimmed);
  }

  const codeFenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch;
  while ((fenceMatch = codeFenceRegex.exec(text)) !== null) {
    candidates.push(fenceMatch[1].trim());
  }

  const tagRegex = /<tool_calls?>([\s\S]*?)<\/tool_calls?>/gi;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(text)) !== null) {
    candidates.push(tagMatch[1].trim());
  }

  const objectCandidate = extractBalancedJson(text, "{", "}");
  if (objectCandidate) {
    candidates.push(objectCandidate);
  }

  const arrayCandidate = extractBalancedJson(text, "[", "]");
  if (arrayCandidate) {
    candidates.push(arrayCandidate);
  }

  return [...new Set(candidates)].filter(Boolean);
}

function extractBalancedJson(text, open, close) {
  const start = text.indexOf(open);
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function looksLikeToolJson(text) {
  return /tool_calls?|function_call|arguments/i.test(text);
}

function cleanTextOutput(text) {
  return typeof text === "string" ? text : "";
}

function isToolRequired(toolChoice) {
  return toolChoice.mode === "required" || toolChoice.mode === "function";
}

function matchesJsonSchemaType(value, type) {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}
