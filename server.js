import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import { fileURLToPath } from "url";

import { optionalBearerAuth } from "./middleware/auth.js";
import { buildCorsOptions } from "./middleware/cors.js";
import { requestTimeout } from "./middleware/requestTimeout.js";
import { chatRouter } from "./routes/chatRoutes.js";
import { imageRouter } from "./routes/imageRoutes.js";
import { legacyChatRouter } from "./routes/legacyChatRoutes.js";
import { modelsRouter } from "./routes/modelsRoutes.js";
import { responsesRouter } from "./routes/responsesRoutes.js";
import { getDefaultModel, getJsonBodyLimit, getTrustProxyHops, positiveInt } from "./utils/config.js";
import { errorHandler, sendError } from "./utils/errors.js";

dotenv.config({ quiet: true });

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", getTrustProxyHops());

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(helmet());
app.use(compression());

const corsOptions = buildCorsOptions();
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(requestTimeout());

app.use(rateLimit({
  windowMs: positiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
  max: positiveInt(process.env.RATE_LIMIT_MAX, 60),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => sendError(req, res, 429, "rate_limit_exceeded", "Too many requests")
}));

app.use(express.json({
  limit: getJsonBodyLimit(),
  type: ["application/json", "application/*+json"]
}));

app.use(express.urlencoded({
  extended: false,
  limit: "64kb"
}));

app.get("/", (req, res) => {
  return res.status(200).json({
    status: "SWU API running",
    openai_compatible: true,
    tools_compatible: true,
    responses_api: true,
    default_model: getDefaultModel()
  });
});

app.use(optionalBearerAuth);

app.use("/v1", modelsRouter);
app.use("/v1", chatRouter);
app.use("/v1", responsesRouter);
app.use(imageRouter);
app.use(legacyChatRouter);

app.use(errorHandler);

const PORT = positiveInt(process.env.PORT, 8080);
const HOST = "0.0.0.0";
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  app.listen(PORT, HOST, () => {
    console.log(`Running on http://${HOST}:${PORT}`);
  });
}

export default app;
