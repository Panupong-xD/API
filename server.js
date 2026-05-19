import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import Joi from "joi";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { fileURLToPath } from "url";

import { chat, generateImage } from "./swuClient.js";
import {
  DEFAULT_MODEL,
  allowedModelIds,
  isAllowedModel,
  modelRegistry
} from "./modelRegistry.js";
import {
  formatOpenAIMessage,
  formatGeminiMessage,
  formatClaudeMessage
} from "./adapters.js";

dotenv.config({ quiet: true });

const app = express();

const maxUploadBytes = positiveInt(process.env.UPLOAD_MAX_BYTES, 5 * 1024 * 1024);
const jsonBodyLimit = process.env.JSON_BODY_LIMIT || "12mb";
const requestTimeoutMs = positiveInt(process.env.REQUEST_TIMEOUT_MS, 70 * 1000);
const defaultModel = isAllowedModel(process.env.DEFAULT_MODEL)
  ? process.env.DEFAULT_MODEL
  : DEFAULT_MODEL;
const streamChunkSize = positiveInt(process.env.STREAM_CHUNK_SIZE, 256);
const allowRemoteImageUrls = parseBoolean(process.env.ALLOW_REMOTE_IMAGE_URLS, true);
const allowedImageMimeTypes = parseAllowedImageMimeTypes(process.env.ALLOWED_IMAGE_MIME_TYPES);

/* ---------------- APP SECURITY ---------------- */

app.disable("x-powered-by");
app.set("trust proxy", positiveInt(process.env.TRUST_PROXY_HOPS, 1));

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(helmet());
app.use(compression());
app.use(cors(buildCorsOptions()));
app.options("*", cors(buildCorsOptions()));
app.use(requestTimeout());

/* ---------------- RATE LIMIT ---------------- */

app.use(rateLimit({
  windowMs: positiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
  max: positiveInt(process.env.RATE_LIMIT_MAX, 60),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => sendError(req, res, 429, "rate_limit_exceeded", "Too many requests")
}));

/* ---------------- BODY PARSERS ---------------- */

app.use(express.json({
  limit: jsonBodyLimit,
  type: ["application/json", "application/*+json"]
}));

app.use(express.urlencoded({
  extended: false,
  limit: "64kb"
}));

/* ---------------- MULTER ---------------- */

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const declaredMime = normalizeMime(file.mimetype);

    if (!declaredMime || !allowedImageMimeTypes.has(declaredMime)) {
      return cb(new Error("Only PNG, JPEG, WebP, and GIF images are allowed"), false);
    }

    return cb(null, true);
  },
  limits: {
    fileSize: maxUploadBytes,
    files: 1,
    fields: 30,
    parts: 40,
    fieldNameSize: 100,
    fieldSize: 512 * 1024
  }
});

function singleImageUpload(req, res, next) {
  upload.single("image")(req, res, (err) => {
    if (!err) {
      return next();
    }

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return sendError(req, res, 413, "upload_too_large", `Image must be ${maxUploadBytes} bytes or smaller`);
      }

      return sendError(req, res, 400, "invalid_multipart_request", err.message);
    }

    return sendError(req, res, 400, "invalid_image", err.message);
  });
}

/* ---------------- HEALTH CHECK ---------------- */

app.get("/", (req, res) => {
  res.json({
    status: "SWU API running",
    openai_compatible: true,
    default_model: defaultModel
  });
});

/* ---------------- AUTH ---------------- */

app.use(optionalBearerAuth);

/* ---------------- VALIDATION ---------------- */

const chatSchema = Joi.object({
  message: Joi.string().min(1).max(20000).required(),
  model: Joi.string().valid(...allowedModelIds).optional(),
  stream: Joi.any().optional()
});

const openAIMessageSchema = Joi.object({
  role: Joi.string().valid("system", "developer", "user", "assistant", "tool").required(),
  content: Joi.alternatives().try(
    Joi.string().allow(""),
    Joi.array().items(Joi.object().unknown(true)).min(1),
    Joi.allow(null)
  ).required()
}).unknown(true);

const openAIChatSchema = Joi.object({
  model: Joi.string().valid(...allowedModelIds).required(),
  messages: Joi.array().items(openAIMessageSchema).min(1).required(),
  stream: Joi.alternatives().try(Joi.boolean(), Joi.string().valid("true", "false")).optional()
}).unknown(true);

const genImageSchema = Joi.object({
  prompt: Joi.string().min(1).max(20000).required(),
  model: Joi.string().valid(...allowedModelIds).required(),
  response_format: Joi.string().valid("url", "b64_json").optional()
}).unknown(true);

/* ---------------- MODELS ---------------- */

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: allowedModelIds.map((id) => ({
      id,
      object: "model"
    }))
  });
});

/* ---------------- IMAGE GENERATION ---------------- */

app.post("/generate-image", async (req, res) => {
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

    return res.json({
      success: true,
      model: value.model,
      image,
      revised_prompt: result?.meta?.revised_prompt || value.prompt
    });
  } catch (err) {
    return handleRouteError(req, res, err, "Generate image failed");
  }
});

app.post("/v1/images/generations", async (req, res) => {
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

    return res.json({
      created: unixNow(),
      data: [toOpenAIImageData(image, value.response_format)]
    });
  } catch (err) {
    return handleRouteError(req, res, err, "OpenAI image generation failed");
  }
});

/* ---------------- OPENAI-COMPATIBLE CHAT ---------------- */

app.post("/v1/chat/completions", singleImageUpload, async (req, res) => {
  try {
    const body = normalizeOpenAIChatBody(req.body);
    const { error, value } = openAIChatSchema.validate(body);

    if (error) {
      return sendJoiError(req, res, error);
    }

    const internalMessages = await buildOpenAIInternalMessages(value.messages, req.file);
    const upstreamMessages = formatForProvider(value.model, internalMessages);
    const streamRequested = isTruthy(value.stream);

    if (streamRequested) {
      return streamOpenAICompletion(req, res, value.model, upstreamMessages);
    }

    const reply = await chat(upstreamMessages, value.model);
    return res.json(createOpenAIChatCompletion(value.model, serializeReply(reply)));
  } catch (err) {
    return handleRouteError(req, res, err, "OpenAI chat completion failed");
  }
});

/* ---------------- LEGACY CHAT ENDPOINT ---------------- */

app.post("/chat", singleImageUpload, async (req, res) => {
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

    const model = value.model || defaultModel;
    const internalMessages = await buildLegacyInternalMessages(value.message, req.file);
    const upstreamMessages = formatForProvider(model, internalMessages);
    const streamRequested = isTruthy(value.stream) || req.query.stream === "true";

    if (streamRequested && modelRegistry[model]?.supportsStreaming) {
      return streamLegacyCompletion(res, model, upstreamMessages);
    }

    const reply = await chat(upstreamMessages, model);
    return res.json({ reply, model });
  } catch (err) {
    return handleRouteError(req, res, err, "Chat failed");
  }
});

/* ---------------- ERROR HANDLER ---------------- */

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err?.type === "entity.too.large") {
    return sendError(req, res, 413, "request_too_large", "Request body is too large");
  }

  if (err instanceof SyntaxError && "body" in err) {
    return sendError(req, res, 400, "invalid_json", "Invalid JSON request body");
  }

  return handleRouteError(req, res, err, "Unhandled server error");
});

/* ---------------- HELPERS ---------------- */

function buildCorsOptions() {
  const rawOrigin = process.env.CORS_ORIGIN || "*";
  const allowAll = rawOrigin.trim() === "*";
  const allowedOrigins = rawOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }

      if (allowAll) {
        return callback(null, "*");
      }

      return callback(null, allowedOrigins.includes(origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "OpenAI-Organization",
      "OpenAI-Project",
      "X-Requested-With"
    ],
    credentials: false,
    maxAge: 86400
  };
}

function requestTimeout() {
  return (req, res, next) => {
    req.setTimeout(requestTimeoutMs);

    res.setTimeout(requestTimeoutMs, () => {
      if (!res.headersSent) {
        sendError(req, res, 504, "request_timeout", "Request timed out");
      } else {
        res.end();
      }
    });

    next();
  };
}

function optionalBearerAuth(req, res, next) {
  if (req.method === "OPTIONS") {
    return next();
  }

  const configuredKey = process.env.API_KEY;
  if (!configuredKey) {
    return next();
  }

  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match || !safeEqual(match[1], configuredKey)) {
    return sendError(req, res, 401, "invalid_api_key", "Invalid or missing API key");
  }

  return next();
}

function normalizeOpenAIChatBody(body) {
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

  normalized.model = normalized.model || normalized.model_name || defaultModel;

  return normalized;
}

async function buildLegacyInternalMessages(message, file) {
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

async function buildOpenAIInternalMessages(messages, file) {
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

async function normalizeOpenAIMessage(message) {
  const role = normalizeRole(message.role);
  const content = message.content;

  if (content == null) {
    return { role, text: "", images: [] };
  }

  if (typeof content === "string") {
    return { role, text: content, images: [] };
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

    if (part.type === "text" || part.type === "input_text") {
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
    text: textParts.filter(Boolean).join("\n"),
    images
  };
}

async function normalizeImageUrlPart(part) {
  const rawUrl = typeof part.image_url === "string"
    ? part.image_url
    : part.image_url?.url || part.url;

  if (!rawUrl || typeof rawUrl !== "string") {
    throw httpError(400, "invalid_image_url", "image_url.url is required", "messages");
  }

  const url = rawUrl.trim();

  if (url.startsWith("data:")) {
    return validateDataUrlImage(url);
  }

  if (!allowRemoteImageUrls) {
    throw httpError(400, "remote_image_url_not_allowed", "Remote image URLs are disabled", "messages");
  }

  validateRemoteImageUrl(url);
  return { url };
}

async function validateUploadedImage(file) {
  if (!file?.buffer || !Buffer.isBuffer(file.buffer)) {
    throw httpError(400, "invalid_image", "Image upload is missing file data", "image");
  }

  if (file.size > maxUploadBytes) {
    throw httpError(413, "upload_too_large", `Image must be ${maxUploadBytes} bytes or smaller`, "image");
  }

  const declaredMime = normalizeMime(file.mimetype);
  if (!declaredMime || !allowedImageMimeTypes.has(declaredMime)) {
    throw httpError(400, "unsupported_image_type", "Only PNG, JPEG, WebP, and GIF images are allowed", "image");
  }

  const detected = await fileTypeFromBuffer(file.buffer);
  const detectedMime = normalizeMime(detected?.mime);

  if (!detectedMime || !allowedImageMimeTypes.has(detectedMime)) {
    throw httpError(400, "invalid_image", "Uploaded file content is not a supported image", "image");
  }

  if (!mimeMatches(declaredMime, detectedMime)) {
    throw httpError(400, "image_mime_mismatch", "Uploaded image MIME type does not match its file signature", "image");
  }

  return {
    mime: detectedMime,
    dataUrl: `data:${detectedMime};base64,${file.buffer.toString("base64")}`
  };
}

async function validateDataUrlImage(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/is);
  if (!match) {
    throw httpError(400, "invalid_image_url", "Only base64 data image URLs are supported", "messages");
  }

  const declaredMime = normalizeMime(match[1]);
  if (!declaredMime || !allowedImageMimeTypes.has(declaredMime)) {
    throw httpError(400, "unsupported_image_type", "Only PNG, JPEG, WebP, and GIF images are allowed", "messages");
  }

  const base64 = match[2].replace(/\s+/g, "");
  if (!base64 || base64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw httpError(400, "invalid_image_url", "Image data URL contains invalid base64", "messages");
  }

  const estimatedBytes = base64DecodedLength(base64);
  if (estimatedBytes > maxUploadBytes) {
    throw httpError(413, "upload_too_large", `Image must be ${maxUploadBytes} bytes or smaller`, "messages");
  }

  const buffer = Buffer.from(base64, "base64");
  const detected = await fileTypeFromBuffer(buffer);
  const detectedMime = normalizeMime(detected?.mime);

  if (!detectedMime || !allowedImageMimeTypes.has(detectedMime)) {
    throw httpError(400, "invalid_image", "Image data URL content is not a supported image", "messages");
  }

  if (!mimeMatches(declaredMime, detectedMime)) {
    throw httpError(400, "image_mime_mismatch", "Image data URL MIME type does not match its file signature", "messages");
  }

  return {
    mime: detectedMime,
    dataUrl: `data:${detectedMime};base64,${buffer.toString("base64")}`
  };
}

function validateRemoteImageUrl(url) {
  if (url.length > 4096) {
    throw httpError(400, "invalid_image_url", "Remote image URL is too long", "messages");
  }

  try {
    const parsed = new URL(url);

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("invalid protocol");
    }
  } catch {
    throw httpError(400, "invalid_image_url", "Remote image URL must be a valid http or https URL", "messages");
  }
}

function formatForProvider(model, internalMessages) {
  const registryEntry = modelRegistry[model];
  let formatted;

  switch (registryEntry?.provider) {
    case "google":
      formatted = formatGeminiMessage(internalMessages);
      break;
    case "anthropic":
      formatted = formatClaudeMessage(internalMessages);
      break;
    default:
      formatted = formatOpenAIMessage(internalMessages);
  }

  return formatted.messages ?? formatted;
}

async function streamOpenAICompletion(req, res, model, upstreamMessages) {
  const id = `chatcmpl-${randomUUID()}`;
  const created = unixNow();

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(keepAlive);
    }
  }, 15000);

  try {
    writeOpenAIStreamChunk(res, {
      id,
      created,
      model,
      delta: { role: "assistant" }
    });

    const reply = await chat(upstreamMessages, model);
    const text = serializeReply(reply);

    for (let i = 0; i < text.length; i += streamChunkSize) {
      writeOpenAIStreamChunk(res, {
        id,
        created,
        model,
        delta: { content: text.slice(i, i + streamChunkSize) }
      });
      await delay(5);
    }

    writeOpenAIStreamChunk(res, {
      id,
      created,
      model,
      delta: {},
      finish_reason: "stop"
    });
    res.write("data: [DONE]\n\n");
  } catch (err) {
    console.error("OpenAI streaming error:", err);
    res.write(`data: ${JSON.stringify({
      error: {
        message: publicErrorMessage(err),
        type: "server_error",
        code: "stream_failed"
      }
    })}\n\n`);
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
}

async function streamLegacyCompletion(res, model, upstreamMessages) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(keepAlive);
    }
  }, 15000);

  try {
    const reply = await chat(upstreamMessages, model);
    const text = serializeReply(reply);

    for (let i = 0; i < text.length; i += streamChunkSize) {
      const chunk = text.slice(i, i + streamChunkSize);
      res.write(`data: ${chunk.replace(/\n/g, "\\n")}\n\n`);
      await delay(5);
    }

    res.write("event: done\ndata: {}\n\n");
  } catch (err) {
    console.error("Legacy streaming error:", err);
    res.write(`event: error\ndata: ${JSON.stringify({ error: "stream_failed" })}\n\n`);
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
}

function createOpenAIChatCompletion(model, content) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: unixNow(),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content
        },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

function writeOpenAIStreamChunk(res, chunk) {
  res.write(`data: ${JSON.stringify({
    id: chunk.id,
    object: "chat.completion.chunk",
    created: chunk.created,
    model: chunk.model,
    choices: [
      {
        index: 0,
        delta: chunk.delta,
        finish_reason: chunk.finish_reason ?? null
      }
    ]
  })}\n\n`);
}

function normalizeGeneratedImage(result) {
  let image = result?.image;

  if (!image && result?.meta?.image) {
    image = result.meta.image;
  }

  if (!image) {
    return null;
  }

  const text = String(image);
  if (/^[A-Za-z0-9+/=]+$/.test(text) && !text.startsWith("data:")) {
    return `data:image/png;base64,${text}`;
  }

  return text;
}

function toOpenAIImageData(image, responseFormat = "url") {
  if (responseFormat === "b64_json" && image.startsWith("data:")) {
    return { b64_json: image.split(",")[1] || "" };
  }

  if (responseFormat === "b64_json" && /^[A-Za-z0-9+/=]+$/.test(image)) {
    return { b64_json: image };
  }

  return { url: image };
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

function sendJoiError(req, res, error) {
  return sendError(req, res, 400, "invalid_request_error", error.details?.[0]?.message || error.message, error.details?.[0]?.path?.join("."));
}

function handleRouteError(req, res, err, label) {
  if (res.headersSent) {
    console.error(label, err);
    return res.end();
  }

  if (err?.status) {
    return sendError(req, res, err.status, err.code || "invalid_request_error", err.message, err.param);
  }

  if (err?.name === "AbortError") {
    return sendError(req, res, 504, "upstream_timeout", "The upstream SWU AI request timed out");
  }

  console.error(label, err);
  return sendError(req, res, 500, "internal_error", "Internal server error");
}

function sendError(req, res, status, code, message, param = null) {
  if (req.path.startsWith("/v1/")) {
    return res.status(status).json({
      error: {
        message,
        type: errorType(status),
        param,
        code
      }
    });
  }

  return res.status(status).json({
    error: code,
    message
  });
}

function errorType(status) {
  if (status === 401) {
    return "authentication_error";
  }

  if (status === 429) {
    return "rate_limit_error";
  }

  if (status >= 500) {
    return "server_error";
  }

  return "invalid_request_error";
}

function httpError(status, code, message, param = null) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.param = param;
  return err;
}

function publicErrorMessage(err) {
  if (err?.status && err.message) {
    return err.message;
  }

  if (err?.name === "AbortError") {
    return "The upstream SWU AI request timed out";
  }

  return "Internal server error";
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

function normalizeMime(mime) {
  if (!mime || typeof mime !== "string") {
    return null;
  }

  const value = mime.split(";")[0].trim().toLowerCase();

  if (value === "image/jpg" || value === "image/pjpeg") {
    return "image/jpeg";
  }

  if (value === "image/x-png") {
    return "image/png";
  }

  return value;
}

function mimeMatches(declaredMime, detectedMime) {
  return normalizeMime(declaredMime) === normalizeMime(detectedMime);
}

function parseAllowedImageMimeTypes(value) {
  const defaults = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  const values = value
    ? value.split(",").map((mime) => normalizeMime(mime)).filter(Boolean)
    : defaults;

  return new Set(values);
}

function base64DecodedLength(base64) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function isTruthy(value) {
  return value === true || String(value).toLowerCase() === "true";
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeEqual(actual, expected) {
  const actualHash = createHash("sha256").update(String(actual)).digest();
  const expectedHash = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------- START ---------------- */

const PORT = positiveInt(process.env.PORT, 8080);
const HOST = "0.0.0.0";
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  app.listen(PORT, HOST, () => {
    console.log(`Running on http://${HOST}:${PORT}`);
  });
}

export default app;
