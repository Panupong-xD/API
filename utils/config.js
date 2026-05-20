import { DEFAULT_MODEL, isAllowedModel } from "../modelRegistry.js";

export function getDefaultModel() {
  return isAllowedModel(process.env.DEFAULT_MODEL)
    ? process.env.DEFAULT_MODEL
    : DEFAULT_MODEL;
}

export function getMaxUploadBytes() {
  return positiveInt(process.env.UPLOAD_MAX_BYTES, 5 * 1024 * 1024);
}

export function getJsonBodyLimit() {
  return process.env.JSON_BODY_LIMIT || "12mb";
}

export function getRequestTimeoutMs() {
  return positiveInt(process.env.REQUEST_TIMEOUT_MS, 70 * 1000);
}

export function getStreamChunkSize() {
  return positiveInt(process.env.STREAM_CHUNK_SIZE, 256);
}

export function getTrustProxyHops() {
  return positiveInt(process.env.TRUST_PROXY_HOPS, 1);
}

export function allowRemoteImageUrls() {
  return parseBoolean(process.env.ALLOW_REMOTE_IMAGE_URLS, true);
}

export function toolsCompatModeEnabled() {
  return parseBoolean(process.env.TOOLS_COMPAT_MODE, true);
}

export function getToolsRetryMax() {
  return positiveInt(process.env.TOOLS_RETRY_MAX, 1);
}

export function getAllowedImageMimeTypes() {
  const defaults = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  const values = process.env.ALLOWED_IMAGE_MIME_TYPES
    ? process.env.ALLOWED_IMAGE_MIME_TYPES.split(",").map((mime) => normalizeMime(mime)).filter(Boolean)
    : defaults;

  return new Set(values);
}

export function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function isTruthy(value) {
  return value === true || String(value).toLowerCase() === "true";
}

export function normalizeMime(mime) {
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
