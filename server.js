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

import { chat, generateImage } from "./swuClient.js";
import { modelRegistry } from "./modelRegistry.js";
import { formatOpenAIMessage, formatGeminiMessage, formatClaudeMessage } from "./adapters.js";

dotenv.config();

const app = express();

/* ---------------- TRUST PROXY ---------------- */

app.set("trust proxy", true);

/* ---------------- LOGGING ---------------- */

app.use(morgan("combined"));

/* ---------------- SECURITY ---------------- */

app.use(helmet());
app.use(compression());

/* ---------------- CORS ---------------- */

const corsOrigin = process.env.CORS_ORIGIN || "*";

app.use(cors({
  origin:
    corsOrigin === "*"
      ? true
      : function (origin, callback) {

          if (!origin) {
            return callback(null, true);
          }

          const allowed = corsOrigin
            .split(",")
            .map(v => v.trim());

          if (allowed.includes(origin)) {
            return callback(null, true);
          }

          return callback(new Error("Not allowed by CORS"));
        },

  methods: ["GET", "POST", "OPTIONS"],

  allowedHeaders: [
    "Content-Type",
    "Authorization"
  ]
}));

app.options("*", cors());

/* ---------------- JSON ---------------- */

app.use(express.json({
  limit: "2mb"
}));

/* ---------------- RATE LIMIT ---------------- */

app.use(rateLimit({
  windowMs:
    Number(process.env.RATE_LIMIT_WINDOW_MS)
    || 60 * 1000,

  max:
    Number(process.env.RATE_LIMIT_MAX)
    || 60,

  standardHeaders: true,
  legacyHeaders: false
}));

/* ---------------- MULTER ---------------- */

const upload = multer({

  storage: multer.memoryStorage(),

  fileFilter: function (req, file, cb) {

    if (
      !file.mimetype ||
      !file.mimetype.startsWith("image/")
    ) {
      return cb(
        new Error("Only image files allowed"),
        false
      );
    }

    cb(null, true);
  },

  limits: {
    fileSize:
      Number(process.env.UPLOAD_MAX_BYTES)
      || 5 * 1024 * 1024
  }
});

/* ---------------- HEALTH CHECK ---------------- */

app.get("/", (req, res) => {

  res.json({
    status: "SWU API running"
  });
});

/* ---------------- MODELS LIST ---------------- */

app.get("/models", (req, res) => {
  try {
    return res.json({ success: true, models: modelRegistry });
  } catch (err) {
    console.error("/models error", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

/* ---------------- VALIDATION ---------------- */

const chatSchema = Joi.object({
  message: Joi.string().min(1).max(4000).required(),
  model: Joi.string().optional(),
  stream: Joi.any().optional()
});

const genImageSchema = Joi.object({
  prompt: Joi.string().min(1).max(20000).required(),
  model: Joi.string().required()
});

/* ---------------- IMAGE GENERATION ---------------- */
app.post("/generate-image", async (req, res) => {
  try {
    const { error, value } = genImageSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const model = value.model;
    const registryEntry = modelRegistry[model];
    if (!registryEntry) return res.status(400).json({ error: "unknown_model" });
    if (!registryEntry.supportsImageGeneration) return res.status(400).json({ error: "model_not_support_image_generation" });

    const result = await generateImage(value.prompt, model);

    // Normalize output
    let image = result?.image;
    if (!image && result?.meta?.image) image = result.meta.image;

    if (!image) return res.status(502).json({ error: "no_image_returned" });

    // If the image is a plain base64 without data URL, try to coerce
    if (/^[A-Za-z0-9+/=]+$/.test(String(image)) && !String(image).startsWith("data:")) {
      image = `data:image/png;base64,${image}`;
    }

    return res.json({
      success: true,
      model,
      image,
      revised_prompt: result?.meta?.revised_prompt || value.prompt
    });
  } catch (err) {
    console.error("Generate image failed:", err);
    return res.status(500).json({ error: "generate_failed" });
  }
});

// OpenAI-compatible alias
app.post("/v1/images/generations", async (req, res) => {
  try {
    const { error, value } = genImageSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const model = value.model;
    const registryEntry = modelRegistry[model];
    if (!registryEntry) return res.status(400).json({ error: "unknown_model" });
    if (!registryEntry.supportsImageGeneration) return res.status(400).json({ error: "model_not_support_image_generation" });

    const result = await generateImage(value.prompt, model);
    let image = result?.image;
    if (!image && result?.meta?.image) image = result.meta.image;
    if (!image) return res.status(502).json({ error: "no_image_returned" });
    if (/^[A-Za-z0-9+/=]+$/.test(String(image)) && !String(image).startsWith("data:")) {
      image = `data:image/png;base64,${image}`;
    }

    return res.json({ success: true, model, image, revised_prompt: result?.meta?.revised_prompt || value.prompt });
  } catch (err) {
    console.error("Generate image (alias) failed:", err);
    return res.status(500).json({ error: "generate_failed" });
  }
});

/* ---------------- OpenAI-compatible chat alias ---------------- */
app.post("/v1/chat/completions", upload.single("image"), async (req, res) => {
  try {
    // Accept either OpenAI-style `messages` or a simple `message` field
    let incomingMessage = null;
    if (Array.isArray(req.body.messages) && req.body.messages.length) {
      incomingMessage = req.body.messages.map(m => m.content || m.message || "").join("\n");
    } else if (req.body.prompt) {
      incomingMessage = req.body.prompt;
    } else {
      incomingMessage = req.body.message;
    }

    const body = { message: incomingMessage, model: req.body.model || req.body.model_name, stream: req.body.stream || req.query.stream };
    const { error, value } = chatSchema.validate(body);
    if (error) return res.status(400).json({ error: error.message });

    // Delegate to main /chat logic by building the same internalMessages
    const model = value.model || process.env.DEFAULT_MODEL || "google/gemini-2.5-flash";
    const registryEntry = modelRegistry[model];
    if (!registryEntry) return res.status(400).json({ error: "unknown_model" });

    const internalMessages = [];
    if (req.file) {
      const detected = await fileTypeFromBuffer(req.file.buffer);
      if (!detected || !detected.mime.startsWith("image/")) return res.status(400).json({ error: "invalid_image" });
      const base64Image = req.file.buffer.toString("base64");
      const dataUrl = `data:${detected.mime};base64,${base64Image}`;
      internalMessages.push({ role: "user", text: value.message || "", image: { mime: detected.mime, dataUrl } });
    } else {
      internalMessages.push({ role: "user", text: value.message });
    }

    let formatted;
    switch (registryEntry.provider) {
      case "google": formatted = formatGeminiMessage(internalMessages); break;
      case "openai": formatted = formatOpenAIMessage(internalMessages); break;
      case "anthropic": formatted = formatClaudeMessage(internalMessages); break;
      default: formatted = formatGeminiMessage(internalMessages);
    }

    const streamRequested = value.stream === true || String(value.stream) === "true" || req.query.stream === "true";
    if (streamRequested && registryEntry.supportsStreaming) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders && res.flushHeaders();
      const keepAlive = setInterval(() => { try { res.write(`: ping\n\n`); } catch (e) {} }, 15000);
      try {
        const fullReply = await chat(formatted.messages ?? formatted, model);
        const text = typeof fullReply === "string" ? fullReply : JSON.stringify(fullReply || "");
        const chunkSize = Number(process.env.STREAM_CHUNK_SIZE) || 256;
        for (let i = 0; i < text.length; i += chunkSize) {
          const chunk = text.slice(i, i + chunkSize);
          res.write(`data: ${chunk.replace(/\n/g, "\\n")}\n\n`);
          await new Promise(r => setTimeout(r, 5));
        }
        res.write(`event: done\ndata: {}\n\n`);
        clearInterval(keepAlive);
        return res.end();
      } catch (err) {
        clearInterval(keepAlive);
        console.error("Streaming alias error:", err);
        try { res.write(`event: error\ndata: ${JSON.stringify({ error: "stream_failed" })}\n\n`); } catch (e) {}
        return res.end();
      }
    }

    const reply = await chat(formatted.messages ?? formatted, model);
    return res.json({ reply, model });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "internal_error" });
  }
});

/* ---------------- CHAT ENDPOINT ---------------- */

app.post("/chat", upload.single("image"), async (req, res) => {
  try {
    const body = { message: req.body.message, model: req.body.model, stream: req.body.stream || req.query.stream };
    const { error, value } = chatSchema.validate(body);
    if (error) return res.status(400).json({ error: error.message });

    const model = value.model || process.env.DEFAULT_MODEL || "google/gemini-2.5-flash";
    const registryEntry = modelRegistry[model];
    if (!registryEntry) return res.status(400).json({ error: "unknown_model" });

    // Build internal messages
    const internalMessages = [];
    const userText = value.message;

    if (req.file) {
      const detected = await fileTypeFromBuffer(req.file.buffer);
      if (!detected || !detected.mime.startsWith("image/")) {
        return res.status(400).json({ error: "invalid_image" });
      }

      const base64Image = req.file.buffer.toString("base64");
      const dataUrl = `data:${detected.mime};base64,${base64Image}`;

      internalMessages.push({ role: "user", text: userText || "", image: { mime: detected.mime, dataUrl } });
    } else {
      internalMessages.push({ role: "user", text: userText });
    }

    // Format by provider
    let formatted;
    switch (registryEntry.provider) {
      case "google":
        formatted = formatGeminiMessage(internalMessages);
        break;
      case "openai":
        formatted = formatOpenAIMessage(internalMessages);
        break;
      case "anthropic":
        formatted = formatClaudeMessage(internalMessages);
        break;
      default:
        formatted = formatGeminiMessage(internalMessages);
    }

    const streamRequested = value.stream === true || String(value.stream) === "true" || req.query.stream === "true";

    // SSE streaming (emulated) if requested and supported
    if (streamRequested && registryEntry.supportsStreaming) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders && res.flushHeaders();

      // keepalive ping
      const keepAlive = setInterval(() => {
        try { res.write(`: ping\n\n`); } catch (e) { /* ignore */ }
      }, 15000);

      try {
        const fullReply = await chat(formatted.messages ?? formatted, model);
        const text = typeof fullReply === "string" ? fullReply : JSON.stringify(fullReply || "");
        const chunkSize = Number(process.env.STREAM_CHUNK_SIZE) || 256;
        for (let i = 0; i < text.length; i += chunkSize) {
          const chunk = text.slice(i, i + chunkSize);
          res.write(`data: ${chunk.replace(/\n/g, "\\n")}\n\n`);
          // slight delay to allow client to process (non-blocking)
          await new Promise((r) => setTimeout(r, 5));
        }

        res.write(`event: done\ndata: {}\n\n`);
        clearInterval(keepAlive);
        return res.end();
      } catch (err) {
        clearInterval(keepAlive);
        console.error("Streaming error:", err);
        try { res.write(`event: error\ndata: ${JSON.stringify({ error: "stream_failed" })}\n\n`); } catch (e) {}
        return res.end();
      }
    }

    // Non-streaming path
    const reply = await chat(formatted.messages ?? formatted, model);
    return res.json({ reply, model });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "internal_error" });
  }
});

/* ---------------- START ---------------- */

const PORT =
  Number(process.env.PORT)
  || 8080;

const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {

  console.log(
    `🚀 Running on http://${HOST}:${PORT}`
  );
});