import * as authService from '../services/auth.service.js';
import { checkEmailDomain } from '../utils/email-domain.js';
import { FieldValidator, isValidEmail } from '../utils/validation.js';
import { readNewPassword } from '../utils/password-rules.js';
import { clearSessionCookie, readSessionToken, setSessionCookie } from '../utils/session-cookie.js';
const STUDENT_NUMBER_PATTERN = /^[0-9]{1,6}$/;

function readEmail(v) {
  const email = v.string('email', { label: 'Email', max: 254 })?.toLowerCase();
  if (email !== undefined && !isValidEmail(email)) {
    v.addError('email', 'Enter a valid email address.');
    return undefined;
  }
  return email;
}

async function parseRegistration(body) {
  const v = new FieldValidator(body);

  if ('role' in body) {
    v.addError('role', 'The role cannot be chosen at registration. New accounts are always students.');
  }

  const fullName = v.string('fullName', { label: 'Full name', max: 100 })?.replace(/\s+/g, ' ');
  const email = readEmail(v);
  // A well-formed address must also have a domain that can receive mail and is not a
  // disposable email service. Its error joins the others in the same 400 response.
  if (email !== undefined) {
    const domainProblem = await checkEmailDomain(email);
    if (domainProblem) v.addError('email', domainProblem);
  }

  const password = readNewPassword(v, 'password');

  const studentNumber = v.string('studentNumber', { label: 'Student number', required: false });
  if (studentNumber !== undefined && !STUDENT_NUMBER_PATTERN.test(studentNumber)) {
    v.addError('studentNumber', 'Student number must be 1 to 6 digits.');
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
  const input = await parseRegistration(req.body);
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
