export function startSse(res, contentType = "text/event-stream; charset=utf-8") {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-cache, no-transform");
  // Help proxies (nginx, Cloud Run) avoid buffering SSE responses
  res.setHeader("X-Accel-Buffering", "no");
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
  try {
    res.write(`data: ${JSON.stringify({
      error: {
        message: err?.message || "Internal server error",
        type: err?.status >= 500 ? "server_error" : "invalid_request_error",
        code: err?.code || "stream_failed"
      }
    })}\n\n`);
  } catch (e) {
    try {
      res.write(`data: ${JSON.stringify({ error: { message: "Internal server error", code: "stream_failed" } })}\n\n`);
    } catch {
      // nothing else we can do
    }
  }
}
