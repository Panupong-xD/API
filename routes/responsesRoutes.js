import { Router } from "express";
import Joi from "joi";

import { allowedModelIds } from "../modelRegistry.js";
import { runOpenAICompletion } from "../services/openaiService.js";
import { getStreamChunkSize, isTruthy } from "../utils/config.js";
import { handleRouteError, sendJoiError } from "../utils/errors.js";
import { buildOpenAIInternalMessages, responsesInputToMessages } from "../utils/messageNormalizer.js";
import { createResponsesObject, writeResponsesStream } from "../utils/openaiFormatter.js";
import { startSse, writeSseError } from "../utils/streaming.js";

export const responsesRouter = Router();

const responsesSchema = Joi.object({
  model: Joi.string().valid(...allowedModelIds).required(),
  input: Joi.alternatives().try(
    Joi.string().allow(""),
    Joi.array().items(Joi.object().unknown(true)).min(1)
  ).required(),
  stream: Joi.alternatives().try(Joi.boolean(), Joi.string().valid("true", "false")).optional(),
  tools: Joi.array().items(Joi.object().unknown(true)).optional(),
  tool_choice: Joi.alternatives().try(
    Joi.string().valid("auto", "none", "required"),
    Joi.object().unknown(true)
  ).optional()
}).unknown(true);

responsesRouter.post("/responses", async (req, res) => {
  try {
    const { error, value } = responsesSchema.validate(req.body);

    if (error) {
      return sendJoiError(req, res, error);
    }

    const messages = responsesInputToMessages(value.input);
    const internalMessages = await buildOpenAIInternalMessages(messages);
    const streamRequested = isTruthy(value.stream);

    if (streamRequested) {
      return streamResponse(res, value, internalMessages);
    }

    const result = await runOpenAICompletion({
      model: value.model,
      internalMessages,
      tools: value.tools,
      tool_choice: value.tool_choice
    });

    return res.json(createResponsesObject(value.model, result));
  } catch (err) {
    return handleRouteError(req, res, err, "OpenAI response failed");
  }
});

async function streamResponse(res, value, internalMessages) {
  const keepAlive = startSse(res);

  try {
    const result = await runOpenAICompletion({
      model: value.model,
      internalMessages,
      tools: value.tools,
      tool_choice: value.tool_choice
    });

    writeResponsesStream(res, value.model, result, getStreamChunkSize());
  } catch (err) {
    console.error("OpenAI response streaming failed:", err);
    writeSseError(res, err);
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
}
