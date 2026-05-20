import { getRequestTimeoutMs } from "../utils/config.js";
import { sendError } from "../utils/errors.js";

export function requestTimeout() {
  return (req, res, next) => {
    const timeoutMs = getRequestTimeoutMs();

    req.setTimeout(timeoutMs);

    res.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        sendError(req, res, 504, "request_timeout", "Request timed out");
      } else {
        res.end();
      }
    });

    next();
  };
}
