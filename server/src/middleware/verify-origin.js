import config from '../config/index.js';
import AppError from '../utils/app-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-based sessions: a request that changes data must come
 * from this server's own pages or from an origin listed in CORS_ORIGINS.
 *
 * Browsers always send an Origin header on cross-origin requests (and on same-origin
 * POST/PUT/PATCH/DELETE), so a malicious page cannot hide where it comes from.
 * Requests without Origin are not from a browser page (curl, tests) and carry no
 * cookie that a third-party site could have triggered, so they are allowed.
 */
export default function verifyOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  if (!origin) return next();

  const ownOrigin = `${req.protocol}://${req.get('host')}`;
  if (origin === ownOrigin || config.corsOrigins.includes(origin)) return next();

  next(new AppError(403, 'ORIGIN_NOT_ALLOWED', 'Requests from this origin are not allowed.'));
}
