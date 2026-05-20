import { Router } from "express";
import Joi from "joi";

import { singleImageUpload } from "../middleware/upload.js";
import { allowedModelIds, modelRegistry } from "../modelRegistry.js";
import { writeLegacyStream } from "../services/openaiService.js";
import { getDefaultModel, isTruthy } from "../utils/config.js";
import { handleRouteError } from "../utils/errors.js";
import { buildLegacyInternalMessages } from "../utils/messageNormalizer.js";
import { formatForProvider } from "../utils/providerAdapters.js";
import { startSse } from "../utils/streaming.js";
import { chat as swuChat } from "../services/swuClient.js";

export const legacyChatRouter = Router();

const chatSchema = Joi.object({
  message: Joi.string().min(1).max(20000).required(),
  model: Joi.string().valid(...allowedModelIds).optional(),
  stream: Joi.any().optional()
});

legacyChatRouter.post("/chat", singleImageUpload, async (req, res) => {
  try {
    const body = {
      message: req.body.message,
      model: req.body.model,
      stream: req.body.stream || req.query.stream
    };

    const { error, value } = chatSchema.validate(body);
    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const model = value.model || getDefaultModel();
    const internalMessages = await buildLegacyInternalMessages(value.message, req.file);
    const streamRequested = isTruthy(value.stream) || req.query.stream === "true";

    if (streamRequested && modelRegistry[model]?.supportsStreaming) {
      return streamLegacyCompletion(res, model, internalMessages);
    }

    const upstreamMessages = formatForProvider(model, internalMessages);
    const reply = await swuChat(upstreamMessages, model);
    return res.json({ reply, model });
  } catch (err) {
    return handleRouteError(req, res, err, "Chat failed");
  }
});

async function streamLegacyCompletion(res, model, internalMessages) {
  const keepAlive = startSse(res, "text/event-stream");

  try {
    await writeLegacyStream(res, model, internalMessages);
  } catch (err) {
    console.error("Legacy streaming error:", err);
    res.write(`event: error\ndata: ${JSON.stringify({ error: "stream_failed" })}\n\n`);
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
}
