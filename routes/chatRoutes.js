import { Router } from "express";
import Joi from "joi";

import { singleImageUpload } from "../middleware/upload.js";
import { allowedModelIds } from "../modelRegistry.js";
import { runOpenAICompletion } from "../services/openaiService.js";
import { getStreamChunkSize, isTruthy } from "../utils/config.js";
import { handleRouteError, sendJoiError } from "../utils/errors.js";
import { buildOpenAIInternalMessages, normalizeOpenAIChatBody } from "../utils/messageNormalizer.js";
import { createOpenAIChatCompletion, writeOpenAIChatStream } from "../utils/openaiFormatter.js";
import { startSse, writeSseError } from "../utils/streaming.js";

export const chatRouter = Router();

const openAIMessageSchema = Joi.object({
  role: Joi.string().valid("system", "developer", "user", "assistant", "tool").required(),
  content: Joi.alternatives().try(
    Joi.string().allow(""),
    Joi.array().items(Joi.object().unknown(true)).min(1),
    Joi.allow(null)
  ).required(),
  tool_calls: Joi.array().items(Joi.object().unknown(true)).optional(),
  tool_call_id: Joi.string().optional(),
  name: Joi.string().optional()
}).unknown(true);

const openAIChatSchema = Joi.object({
  model: Joi.string().valid(...allowedModelIds).required(),
  messages: Joi.array().items(openAIMessageSchema).min(1).required(),
  stream: Joi.alternatives().try(Joi.boolean(), Joi.string().valid("true", "false")).optional(),
  tools: Joi.array().items(Joi.object().unknown(true)).optional(),
  tool_choice: Joi.alternatives().try(
    Joi.string().valid("auto", "none", "required"),
    Joi.object().unknown(true)
  ).optional()
}).unknown(true);

chatRouter.post("/chat/completions", singleImageUpload, async (req, res) => {
  try {
    const body = normalizeOpenAIChatBody(req.body);
    const { error, value } = openAIChatSchema.validate(body);

    if (error) {
      return sendJoiError(req, res, error);
    }

    const internalMessages = await buildOpenAIInternalMessages(value.messages, req.file);
    const streamRequested = isTruthy(value.stream);

    if (streamRequested) {
      return streamChatCompletion(req, res, value, internalMessages);
    }

    const result = await runOpenAICompletion({
      model: value.model,
      internalMessages,
      tools: value.tools,
      tool_choice: value.tool_choice
    });

    return res.json(createOpenAIChatCompletion(value.model, result));
  } catch (err) {
    return handleRouteError(req, res, err, "OpenAI chat completion failed");
  }
});

async function streamChatCompletion(req, res, value, internalMessages) {
  const keepAlive = startSse(res);

  try {
    const result = await runOpenAICompletion({
      model: value.model,
      internalMessages,
      tools: value.tools,
      tool_choice: value.tool_choice
    });

    writeOpenAIChatStream(res, value.model, result, getStreamChunkSize());
  } catch (err) {
    console.error("OpenAI chat streaming failed:", err);
    writeSseError(res, err);
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
}
