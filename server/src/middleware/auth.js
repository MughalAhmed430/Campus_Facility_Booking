import { findSessionUser } from '../services/auth.service.js';
import AppError from '../utils/app-error.js';
import { clearSessionCookie, readSessionToken } from '../utils/session-cookie.js';

/**
 * Requires a valid session. On success sets req.user = { id, fullName, email, role, studentNumber }.
 * 401 if there is no session cookie, or the session is unknown, expired, logged out,
 * or belongs to a deactivated account.
 */
export async function requireAuth(req, res, next) {
  const token = readSessionToken(req);
  if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'Please log in to continue.');

  const user = await findSessionUser(token);
  if (!user) {
    clearSessionCookie(res); // the browser should stop sending a dead token
    throw new AppError(401, 'SESSION_INVALID', 'Your session has ended. Please log in again.');
  }

  req.user = user;
  req.sessionToken = token;
  next();
}

/**
 * Allows only the listed roles. Use after requireAuth:
 *   router.get('/admin-thing', requireAuth, requireRole('admin'), handler)
 * 403 when the user is logged in but has a different role.
 */
export function requireRole(...roles) {
  return function checkRole(req, res, next) {
    if (!req.user) throw new AppError(401, 'AUTH_REQUIRED', 'Please log in to continue.');
    if (!roles.includes(req.user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to access this resource.');
    }
    next();
  };
}
