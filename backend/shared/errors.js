// One error format for the whole API: { error: { code, message, details? } }
const { log } = require('./logger');

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new HttpError(400, 'VALIDATION_ERROR', message, details);
const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found`);
const conflict = (code, message, details) => new HttpError(409, code, message, details);
const forbidden = (message = 'You do not have permission to do this') => new HttpError(403, 'FORBIDDEN', message);

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

// Maps known errors to safe responses. Internal details (stack traces, SQL)
// are logged, never sent to the client.
function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }
  // Postgres constraint violations -> 409 so clients get a meaningful status.
  if (err.code === '23505') return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with these values already exists' } });
  if (err.code === '23503') return res.status(409).json({ error: { code: 'IN_USE', message: 'This record is referenced by other data' } });
  if (err.code === '23514') return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'A value is outside the allowed range' } });

  log('error', 'unhandled_error', { requestId: req.id, path: req.path, message: err.message });
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}

module.exports = { HttpError, badRequest, notFound, conflict, forbidden, notFoundHandler, errorHandler };
