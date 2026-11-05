import AppError from '../utils/app-error.js';

/**
 * Central error handler. Every error ends up here (Express 5 also forwards
 * rejected promises from async handlers). Clients get a consistent JSON shape:
 *
 *   { "success": false, "error": { "code": "...", "message": "...", "details"?: ... } }
 *
 * Stack traces and internal error messages are logged on the server only.
 */
// Express recognises error handlers by their four parameters, so `next` must stay.
export default function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const { status, code, message, details } = toClientError(err);

  if (status >= 500) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${status}`, err);
  }

  const error = { code, message };
  if (details !== undefined) error.details = details;
  res.status(status).json({ success: false, error });
}

function toClientError(err) {
  if (err instanceof AppError) {
    return { status: err.statusCode, code: err.code, message: err.message, details: err.details };
  }

  // Errors raised by express.json() while reading the request body.
  if (err.type === 'entity.parse.failed') {
    return { status: 400, code: 'INVALID_JSON', message: 'The request body must be valid JSON.' };
  }
  if (err.type === 'entity.too.large') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' };
  }

  // Other client errors from Express internals that are marked safe to expose.
  if (err.expose === true && err.status >= 400 && err.status < 500) {
    return { status: err.status, code: 'BAD_REQUEST', message: err.message };
  }

  return { status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again later.' };
}
