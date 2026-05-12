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

import { chat } from "./swuClient.js";

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

/* ---------------- VALIDATION ---------------- */

const chatSchema = Joi.object({

  message: Joi.string()
    .min(1)
    .max(4000)
    .required(),

  model: Joi.string().optional()
});

/* ---------------- CHAT ENDPOINT ---------------- */

app.post(
  "/chat",
  upload.single("image"),

  async (req, res) => {

    try {

      const body = {
        message: req.body.message,
        model: req.body.model
      };

      const { error, value } =
        chatSchema.validate(body);

      if (error) {

        return res.status(400).json({
          error: error.message
        });
      }

      const {
        message,
        model
      } = value;

      let messages;

      /* ---------- IMAGE MODE ---------- */

      if (req.file) {

        const detected =
          await fileTypeFromBuffer(
            req.file.buffer
          );

        if (
          !detected ||
          !detected.mime.startsWith("image/")
        ) {

          return res.status(400).json({
            error: "invalid_image"
          });
        }

        const base64Image =
          req.file.buffer.toString("base64");

        messages = [
          {
            role: "user",

            content: [
              {
                type: "text",
                text: message
              },

              {
                type: "image_url",

                image_url: {
                  url:
                    `data:${detected.mime};base64,${base64Image}`
                }
              }
            ]
          }
        ];

      } else {

        /* ---------- TEXT MODE ---------- */

        messages = [
          {
            role: "user",
            content: message
          }
        ];
      }

      const reply =
        await chat(messages, model);

      return res.json({

        reply,

        model:
          model
          || process.env.DEFAULT_MODEL
          || "google/gemini-2.5-flash"
      });

    } catch (err) {

      console.error(err);

      return res.status(500).json({
        error: "internal_error"
      });
    }
  }
);

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