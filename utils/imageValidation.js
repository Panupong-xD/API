import { fileTypeFromBuffer } from "file-type";

import {
  allowRemoteImageUrls,
  getAllowedImageMimeTypes,
  getMaxUploadBytes,
  normalizeMime
} from "./config.js";
import { httpError } from "./errors.js";

export async function validateUploadedImage(file) {
  if (!file?.buffer || !Buffer.isBuffer(file.buffer)) {
    throw httpError(400, "invalid_image", "Image upload is missing file data", "image");
  }

  const maxUploadBytes = getMaxUploadBytes();
  if (file.size > maxUploadBytes) {
    throw httpError(413, "upload_too_large", `Image must be ${maxUploadBytes} bytes or smaller`, "image");
  }

  const allowedImageMimeTypes = getAllowedImageMimeTypes();
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

export async function normalizeImageUrlPart(part) {
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

  if (!allowRemoteImageUrls()) {
    throw httpError(400, "remote_image_url_not_allowed", "Remote image URLs are disabled", "messages");
  }

  validateRemoteImageUrl(url);
  return { url };
}

export async function validateDataUrlImage(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/is);
  if (!match) {
    throw httpError(400, "invalid_image_url", "Only base64 data image URLs are supported", "messages");
  }

  const allowedImageMimeTypes = getAllowedImageMimeTypes();
  const declaredMime = normalizeMime(match[1]);
  if (!declaredMime || !allowedImageMimeTypes.has(declaredMime)) {
    throw httpError(400, "unsupported_image_type", "Only PNG, JPEG, WebP, and GIF images are allowed", "messages");
  }

  const base64 = match[2].replace(/\s+/g, "");
  if (!base64 || base64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw httpError(400, "invalid_image_url", "Image data URL contains invalid base64", "messages");
  }

  const maxUploadBytes = getMaxUploadBytes();
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

function mimeMatches(declaredMime, detectedMime) {
  return normalizeMime(declaredMime) === normalizeMime(detectedMime);
}

function base64DecodedLength(base64) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
