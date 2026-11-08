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

/** POST /api/auth/register -> 201 { user }. The account starts unverified; a link is emailed. */
export async function register(req, res) {
  const input = parseRegistration(req.body);
  const user = await authService.registerStudent(input);
  res.status(201).json({ success: true, data: { user } });
}

// Tokens are 32 random bytes in base64url: exactly 43 characters from A-Z a-z 0-9 - _.
const VERIFICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * GET /api/auth/verify-email?token=... -> 200 { verified: true, email }
 * Failures: 400 VERIFICATION_TOKEN_INVALID, 409 VERIFICATION_TOKEN_USED, 410 VERIFICATION_TOKEN_EXPIRED.
 */
export async function verifyEmail(req, res) {
  res.set('Cache-Control', 'no-store'); // the answer depends on a one-time token
  const { token } = req.query; // a string, or an array if ?token= appears twice
  if (typeof token !== 'string' || !VERIFICATION_TOKEN_PATTERN.test(token)) {
    throw authService.invalidVerificationLink();
  }
  const { email } = await authService.verifyEmail(token);
  res.json({ success: true, data: { verified: true, email } });
}

// The same words whatever happened, so this endpoint cannot be used to find out which
// email addresses have accounts, or which are already verified.
const RESEND_VERIFICATION_MESSAGE = 'If an account with this email address is waiting to be confirmed, '
  + 'we have sent it a new link. Check your inbox and spam folder. The link works for 24 hours.';

/** POST /api/auth/resend-verification { email } -> 200 { message }, always the same */
export async function resendVerification(req, res) {
  const v = new FieldValidator(req.body);
  const email = readEmail(v);
  v.assertValid();
  await authService.resendVerification(email);
  res.json({ success: true, data: { message: RESEND_VERIFICATION_MESSAGE } });
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
