import multer from "multer";

import { getAllowedImageMimeTypes, getMaxUploadBytes, normalizeMime } from "../utils/config.js";
import { sendError } from "../utils/errors.js";

function createUpload() {
  return multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
      const declaredMime = normalizeMime(file.mimetype);

      if (!declaredMime || !getAllowedImageMimeTypes().has(declaredMime)) {
        return cb(new Error("Only PNG, JPEG, WebP, and GIF images are allowed"), false);
      }

      return cb(null, true);
    },
    limits: {
      fileSize: getMaxUploadBytes(),
      files: 1,
      fields: 30,
      parts: 40,
      fieldNameSize: 100,
      fieldSize: 512 * 1024
    }
  });
}

export function singleImageUpload(req, res, next) {
  createUpload().single("image")(req, res, (err) => {
    if (!err) {
      return next();
    }

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return sendError(req, res, 413, "upload_too_large", `Image must be ${getMaxUploadBytes()} bytes or smaller`);
      }

      return sendError(req, res, 400, "invalid_multipart_request", err.message);
    }

    return sendError(req, res, 400, "invalid_image", err.message);
  });
}
