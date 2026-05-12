import express from "express";
import dotenv from "dotenv";
import { chat } from "./swuClient.js";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import fs from "fs";
import path from "path";
import Joi from "joi";

dotenv.config();

const app = express();

// logging (container-friendly: stdout)
app.use(morgan("combined"));

// security and performance
app.use(helmet());
app.use(compression());

app.use(cors({
  origin: process.env.CORS_ORIGIN || "https://your-frontend.example.com",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "10kb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: Number(process.env.RATE_LIMIT_MAX) || 60, // limit each IP
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// ---------------- HEALTH ----------------
app.get("/", (req, res) => {
  res.json({ status: "SWU API running" });
});

// input validation schema
const chatSchema = Joi.object({
  message: Joi.string().min(1).max(4000).required(),
  model: Joi.string().optional()
});

// ---------------- CHAT ----------------
app.post("/chat", async (req, res) => {
  try {
    const { error, value } = chatSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const { message, model } = value;

    const reply = await chat([{ role: "user", content: message }], model);

    res.json({ reply, model: model || process.env.DEFAULT_MODEL || "google/gemini-2.5-flash" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ---------------- START ----------------
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`🚀 Running on http://${HOST}:${PORT}`);
});