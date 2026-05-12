import express from "express";
import dotenv from "dotenv";
import { chat } from "./swuClient.js";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors({
  origin: "*", // ตอน dev ใช้แบบนี้ก่อน
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

// ---------------- HEALTH ----------------
app.get("/", (req, res) => {
  res.json({ status: "SWU API running" });
});

// ---------------- CHAT ----------------
app.post("/chat", async (req, res) => {
  try {
    const { message, model } = req.body;

    if (!message) {
      return res.status(400).json({ error: "message required" });
    }

    const reply = await chat(
      [{ role: "user", content: message }],
      model // 👈 เลือก model ได้แล้ว
    );

    res.json({
      reply,
      model: model || "google/gemini-2.5-flash"
    });

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

// ---------------- START ----------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Running on http://localhost:${PORT}`);
});