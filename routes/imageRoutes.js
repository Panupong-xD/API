import { Router } from "express";
import Joi from "joi";

import { allowedModelIds, modelRegistry } from "../modelRegistry.js";
import { generateImage } from "../services/swuClient.js";
import { handleRouteError, sendError, sendJoiError } from "../utils/errors.js";
import { normalizeGeneratedImage, toOpenAIImageData, unixNow } from "../utils/openaiFormatter.js";

export const imageRouter = Router();

const genImageSchema = Joi.object({
  prompt: Joi.string().min(1).max(20000).required(),
  model: Joi.string().valid(...allowedModelIds).required(),
  response_format: Joi.string().valid("url", "b64_json").optional()
}).unknown(true);

imageRouter.post("/generate-image", async (req, res) => {
  try {
    const { error, value } = genImageSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const registryEntry = modelRegistry[value.model];
    if (!registryEntry?.supportsImageGeneration) {
      return res.status(400).json({ error: "model_not_support_image_generation" });
    }

    const result = await generateImage(value.prompt, value.model);
    const image = normalizeGeneratedImage(result);

    if (!image) {
      return res.status(502).json({ error: "no_image_returned" });
    }

    return res.status(200).json({
      success: true,
      model: value.model,
      image,
      revised_prompt: result?.meta?.revised_prompt || value.prompt
    });
  } catch (err) {
    return handleRouteError(req, res, err, "Generate image failed");
  }
});

imageRouter.post("/v1/images/generations", async (req, res) => {
  try {
    const { error, value } = genImageSchema.validate(req.body);
    if (error) {
      return sendJoiError(req, res, error);
    }

    const registryEntry = modelRegistry[value.model];
    if (!registryEntry?.supportsImageGeneration) {
      return sendError(req, res, 400, "model_not_support_image_generation", "This model does not support image generation", "model");
    }

    const result = await generateImage(value.prompt, value.model);
    const image = normalizeGeneratedImage(result);

    if (!image) {
      return sendError(req, res, 502, "no_image_returned", "The upstream image model did not return an image");
    }

    return res.status(200).json({
      created: unixNow(),
      data: [toOpenAIImageData(image, value.response_format)]
    });
  } catch (err) {
    return handleRouteError(req, res, err, "OpenAI image generation failed");
  }
});
