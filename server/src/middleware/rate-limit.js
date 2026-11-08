import { rateLimit } from 'express-rate-limit';
import AppError from '../utils/app-error.js';

// Counters live in server memory: they reset when the server restarts, and they are
// per IP address, so many users behind one campus network share a budget. Both are
// acceptable simplifications for this project (see README, Security notes).
function limiter({ windowMinutes, limit, skipSuccessfulRequests = false, message }) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    skipSuccessfulRequests,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res, next) => next(new AppError(429, 'TOO_MANY_REQUESTS', message)),
  });
}

/** Failed logins only: 10 per 15 minutes per IP address. Successful logins are not counted. */
export const loginLimiter = limiter({
  windowMinutes: 15,
  limit: 10,
  skipSuccessfulRequests: true,
  message: 'Too many failed login attempts. Please wait 15 minutes and try again.',
});

/** Registrations: 10 per hour per IP address. */
export const registerLimiter = limiter({
  windowMinutes: 60,
  limit: 10,
  message: 'Too many registration attempts. Please try again later.',
});

/** Requests for a new verification email: the same limit as registration, counted separately. */
export const resendVerificationLimiter = limiter({
  windowMinutes: 60,
  limit: 10,
  message: 'Too many requests for a new verification email. Please try again later.',
});
