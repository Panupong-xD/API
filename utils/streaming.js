export function startSse(res, contentType = "text/event-stream; charset=utf-8") {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  return setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      // The response close path clears the interval.
    }
  }, 15000);
}

export function writeSseError(res, err) {
  res.write(`data: ${JSON.stringify({
    error: {
      message: err?.message || "Internal server error",
      type: err?.status >= 500 ? "server_error" : "invalid_request_error",
      code: err?.code || "stream_failed"
    }
  })}\n\n`);
}
