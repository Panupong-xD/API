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

/* ---------------- CLOUD RUN PROXY ---------------- */
app.set("trust proxy", true);

/* ---------------- LOGGING ---------------- */
app.use(morgan("combined"));

/* ---------------- SECURITY ---------------- */
app.use(helmet());
app.use(compression());

/* ---------------- CORS (FIXED SIMPLE VERSION) ---------------- */

// ใช้ง่าย + ไม่พัง preflight + รองรับ Cloud Run
const corsOrigin = process.env.CORS_ORIGIN || "*";

app.use(cors({
  origin: corsOrigin === "*"
    ? true
    : function (origin, callback) {
        if (!origin) return callback(null, true);

        const allowed = corsOrigin.split(",").map(s => s.trim());

        if (allowed.includes(origin)) {
          return callback(null, true);
        }

        return callback(null, false);
      },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// IMPORTANT: handle preflight
app.options("*", cors());

/* ---------------- JSON BODY ---------------- */
app.use(express.json({ limit: "10kb" }));

/* ---------------- RATE LIMIT ---------------- */
app.use(rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false
}));

/* ---------------- HEALTH CHECK ---------------- */
app.get("/", (req, res) => {
  res.json({ status: "SWU API running" });
});

/* ---------------- VALIDATION ---------------- */
const chatSchema = Joi.object({
  message: Joi.string().min(1).max(4000).required(),
  model: Joi.string().optional()
});

/* ---------------- CHAT API ---------------- */
app.post("/chat", async (req, res) => {
  try {
    const { error, value } = chatSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const { message, model } = value;

    const reply = await chat(
      [{ role: "user", content: message }],
      model
    );

    res.json({
      reply,
      model: model || process.env.DEFAULT_MODEL || "google/gemini-2.5-flash"
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ---------------- START SERVER ---------------- */
const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`🚀 Running on http://${HOST}:${PORT}`);
});