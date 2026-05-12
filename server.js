import express from "express";
import dotenv from "dotenv";
import { chat } from "./swuClient.js";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import Joi from "joi";

dotenv.config();

const app = express();

// trust proxy (Cloud Run uses proxy)
app.set("trust proxy", true);

// logging to stdout
app.use(morgan("combined"));

// security & perf
app.use(helmet());
app.use(compression());

// CORS: comma-separated list in CORS_ORIGIN env (or '*' to allow all)
const raw = (process.env.CORS_ORIGIN || "").trim();
const allowedOrigins = raw ? raw.split(",").map(s => s.trim()).filter(Boolean) : [];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes("*")) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    for (const pattern of allowedOrigins) {
      if (pattern.startsWith("*.")) {
        const domain = pattern.slice(2);
        if (origin.endsWith("." + domain) || origin === `https://${domain}`) {
          return callback(null, true);
        }
      }
    }
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: process.env.CORS_CREDENTIALS === "true"
}));

app.use(express.json({ limit: "10kb" }));

const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// health
app.get("/", (req, res) => res.json({ status: "SWU API running" }));

const chatSchema = Joi.object({
  message: Joi.string().min(1).max(4000).required(),
  model: Joi.string().optional()
});

app.post("/chat", async (req, res) => {
  try {
    const { error, value } = chatSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const { message, model } = value;
    const reply = await chat([{ role: "user", content: message }], model);

    res.json({
      reply,
      model: model || process.env.DEFAULT_MODEL || "google/gemini-2.5-flash"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`🚀 Running on http://${HOST}:${PORT}`);
});