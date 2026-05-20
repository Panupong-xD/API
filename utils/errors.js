export function httpError(status, code, message, param = null) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.param = param;
  return err;
}

export function sendJoiError(req, res, error) {
  return sendError(
    req,
    res,
    400,
    "invalid_request_error",
    error.details?.[0]?.message || error.message,
    error.details?.[0]?.path?.join(".")
  );
}

export function handleRouteError(req, res, err, label) {
  if (res.headersSent) {
    console.error(label, err);
    return res.end();
  }

  if (err?.status) {
    return sendError(req, res, err.status, err.code || "invalid_request_error", err.message, err.param);
  }

  if (err?.name === "AbortError") {
    return sendError(req, res, 504, "upstream_timeout", "The upstream SWU AI request timed out");
  }

  console.error(label, err);
  return sendError(req, res, 500, "internal_error", "Internal server error");
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  if (err?.type === "entity.too.large") {
    return sendError(req, res, 413, "request_too_large", "Request body is too large");
  }

  if (err instanceof SyntaxError && "body" in err) {
    return sendError(req, res, 400, "invalid_json", "Invalid JSON request body");
  }

  return handleRouteError(req, res, err, "Unhandled server error");
}

export function sendError(req, res, status, code, message, param = null) {
  if (req.path.startsWith("/v1/")) {
    return res.status(status).json({
      error: {
        message,
        type: errorType(status),
        param,
        code
      }
    });
  }

  return res.status(status).json({
    error: code,
    message
  });
}

export function publicErrorMessage(err) {
  if (err?.status && err.message) {
    return err.message;
  }

  if (err?.name === "AbortError") {
    return "The upstream SWU AI request timed out";
  }

  return "Internal server error";
}

function errorType(status) {
  if (status === 401) {
    return "authentication_error";
  }

  if (status === 429) {
    return "rate_limit_error";
  }

  if (status >= 500) {
    return "server_error";
  }

  return "invalid_request_error";
}
