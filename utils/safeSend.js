import util from "util";

function safeStringify(obj) {
  const seen = new WeakSet();
  let circularFound = false;
  let undefinedFound = false;

  const body = JSON.stringify(obj, function replacer(key, value) {
    if (typeof value === "undefined") {
      undefinedFound = true;
      return null;
    }

    if (typeof value === "function") {
      return undefined;
    }

    if (value && typeof value === "object") {
      if (seen.has(value)) {
        circularFound = true;
        return null;
      }
      seen.add(value);
    }

    return value;
  });

  if (circularFound) console.warn("safeStringify: circular reference detected and replaced with null");
  if (undefinedFound) console.warn("safeStringify: undefined values detected and replaced with null");

  return body;
}

export function safeJson(res, status, obj) {
  try {
    const body = safeStringify(obj);

    if (!res.headersSent) {
      res.status(status);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      // Do not set Content-Length to remain compatible with compression middleware
      return res.end(body);
    }

    // If headers already sent, attempt to write remaining bytes and close
    try {
      res.write(body);
    } catch (err) {
      console.error("safeJson: failed to write body after headers sent", err);
    }

    try {
      return res.end();
    } catch (err) {
      console.error("safeJson: failed to end response after headers sent", err);
      return undefined;
    }
  } catch (err) {
    console.error("safeJson: serialization failed", err, util.inspect(obj, { depth: 2 }));
    if (!res.headersSent) {
      return res.status(500).json({
        error: {
          message: "Response serialization failed",
          type: "server_error",
          code: "response_serialization_failed"
        }
      });
    }

    try {
      return res.end();
    } catch (e) {
      console.error("safeJson: failed to end response in error case", e);
      return undefined;
    }
  }
}

export function assertIsObject(value) {
  return value !== null && typeof value === "object";
}
