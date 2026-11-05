import * as authService from '../services/auth.service.js';
import { FieldValidator, isValidEmail } from '../utils/validation.js';
import { clearSessionCookie, readSessionToken, setSessionCookie } from '../utils/session-cookie.js';

// bcrypt only uses the first 72 bytes of a password; longer ones are rejected
// rather than silently truncated.
const PASSWORD_MAX_BYTES = 72;
const PASSWORD_MIN_LENGTH = 8;
const STUDENT_NUMBER_PATTERN = /^[A-Za-z0-9]{4,20}$/;

function readEmail(v) {
  const email = v.string('email', { label: 'Email', max: 254 })?.toLowerCase();
  if (email !== undefined && !isValidEmail(email)) {
    v.addError('email', 'Enter a valid email address.');
    return undefined;
  }
  return email;
}

function parseRegistration(body) {
  const v = new FieldValidator(body);

  if ('role' in body) {
    v.addError('role', 'The role cannot be chosen at registration. New accounts are always students.');
  }

  const fullName = v.string('fullName', { label: 'Full name', max: 100 })?.replace(/\s+/g, ' ');
  const email = readEmail(v);

  // Passwords are not trimmed: spaces are allowed and count.
  const password = v.string('password', { label: 'Password', min: PASSWORD_MIN_LENGTH, trim: false });
  if (password !== undefined && Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    v.addError('password', `Password must be at most ${PASSWORD_MAX_BYTES} bytes (about 72 English characters).`);
  }
  if (password !== undefined && password.trim() === '') {
    v.addError('password', 'Password cannot be only spaces.');
  }

  const studentNumber = v.string('studentNumber', { label: 'Student number', required: false });
  if (studentNumber !== undefined && !STUDENT_NUMBER_PATTERN.test(studentNumber)) {
    v.addError('studentNumber', 'Student number must be 4-20 letters or digits.');
  }

  v.assertValid();
  return { fullName, email, password, studentNumber };
}

function parseLogin(body) {
  const v = new FieldValidator(body);
  const email = v.string('email', { label: 'Email', max: 254 })?.toLowerCase();
  // No length rules here: any wrong password simply fails to match.
  const password = v.string('password', { label: 'Password', trim: false, max: 1024 });
  v.assertValid();
  return { email, password };
}

/** POST /api/auth/register -> 201 { user } */
export async function register(req, res) {
  const input = parseRegistration(req.body);
  const user = await authService.registerStudent(input);
  res.status(201).json({ success: true, data: { user } });
}

/** POST /api/auth/login -> 200 { user, sessionExpiresAt } and sets the session cookie */
export async function login(req, res) {
  const credentials = parseLogin(req.body);
  const { token, expiresAt, user } = await authService.login(credentials);
  setSessionCookie(res, token, expiresAt);
  res.json({ success: true, data: { user, sessionExpiresAt: expiresAt.toISOString() } });
}

/** POST /api/auth/logout -> 200. Deletes the session row and clears the cookie. Idempotent. */
export async function logout(req, res) {
  const token = readSessionToken(req);
  if (token) await authService.logout(token);
  clearSessionCookie(res);
  res.json({ success: true, data: { loggedOut: true } });
}

/** GET /api/auth/me -> 200 { user } for the logged-in user (requireAuth runs first) */
export function me(req, res) {
  res.json({ success: true, data: { user: req.user } });
}
