import { createHash, timingSafeEqual } from "crypto";

import { sendError } from "../utils/errors.js";

export function optionalBearerAuth(req, res, next) {
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

function safeEqual(actual, expected) {
  const actualHash = createHash("sha256").update(String(actual)).digest();
  const expectedHash = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(actualHash, expectedHash);
}
