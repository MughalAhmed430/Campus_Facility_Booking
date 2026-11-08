import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import config from '../config/index.js';
import { query } from '../db/pool.js';
import AppError from '../utils/app-error.js';
import { logEmailFailure, sendVerificationEmail } from './email.service.js';

const { bcryptRounds, sessionTtlMs, emailVerificationTtlMs } = config.auth;

// Login answers "wrong email", "wrong password" and "deactivated account" identically,
// including how long it takes: for an unknown email we still run one bcrypt
// comparison, against this hash of a random password nobody knows.
const dummyPasswordHash = bcrypt.hash(crypto.randomBytes(16).toString('hex'), bcryptRounds);

const INVALID_CREDENTIALS = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
const EMAIL_NOT_VERIFIED = () => new AppError(403, 'EMAIL_NOT_VERIFIED',
  'Please confirm your email address before signing in. Open the link in the email we sent you, or ask for a new one.');

/** The only user fields ever sent to the client. Never includes password_hash. */
function toPublicUser(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    studentNumber: row.student_number,
  };
}

/** The cookie (or email link) holds the token; the database holds only its SHA-256 hash. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** 256 bits from the OS CSPRNG, as 43 URL-safe characters. */
function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function verificationExpiry() {
  return new Date(Date.now() + emailVerificationTtlMs);
}

/**
 * Sends the verification email in the background: the HTTP response never waits for
 * Gmail, so its timing cannot tell whether an email was sent. A failure is only logged;
 * the user can ask for a new link from the sign-in or verification page.
 */
function queueVerificationEmail({ email, fullName, token }) {
  sendVerificationEmail({ to: email, fullName, token }).catch((error) => logEmailFailure(error, email));
}

/**
 * Creates an unverified student account and emails it a verification link. The role is
 * fixed here; it never comes from the request.
 */
export async function registerStudent({ fullName, email, password, studentNumber }) {
  const passwordHash = await bcrypt.hash(password, bcryptRounds);
  const token = newToken();
  try {
    // One statement, so the account and its first token are created together or not at all.
    const { rows } = await query(
      `WITH new_user AS (
         INSERT INTO users (full_name, email, password_hash, role, student_number)
         VALUES ($1, $2, $3, 'student', $4)
         RETURNING id, full_name, email, role, student_number
       ), first_token AS (
         INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
         SELECT id, $5, $6 FROM new_user
       )
       SELECT * FROM new_user`,
      [fullName, email, passwordHash, studentNumber ?? null, hashToken(token), verificationExpiry()],
    );
    const user = rows[0];
    queueVerificationEmail({ email: user.email, fullName: user.full_name, token });
    return toPublicUser(user);
  } catch (err) {
    // Rely on the UNIQUE constraints rather than a "check first" query, which two
    // simultaneous registrations could both pass.
    if (err.code === '23505' && err.constraint === 'users_email_key') {
      throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email address already exists.', {
        details: { email: 'An account with this email address already exists.' },
      });
    }
    if (err.code === '23505' && err.constraint === 'users_student_number_key') {
      throw new AppError(409, 'STUDENT_NUMBER_TAKEN', 'This student number is already registered.', {
        details: { studentNumber: 'This student number is already registered.' },
      });
    }
    throw err;
  }
}

/** Verifies credentials and opens a session. Returns the raw token for the cookie. */
export async function login({ email, password }) {
  const { rows } = await query(
    `SELECT id, full_name, email, role, student_number, is_active, email_verified_at, password_hash
     FROM users WHERE email = $1`,
    [email],
  );
  const user = rows[0];

  const passwordMatches = await bcrypt.compare(password, user ? user.password_hash : await dummyPasswordHash);
  if (!user || !passwordMatches || !user.is_active) throw INVALID_CREDENTIALS();
  // Only someone who knows the password gets here, so "not verified" reveals nothing about
  // which emails are registered. It also comes after the bcrypt comparison, so it takes
  // the same time as every other answer.
  if (!user.email_verified_at) throw EMAIL_NOT_VERIFIED();

  const token = crypto.randomBytes(32).toString('base64url'); // 256 bits from the OS CSPRNG
  const expiresAt = new Date(Date.now() + sessionTtlMs);

  // One round trip: remove expired sessions (housekeeping) and store the new one.
  await query(
    `WITH expired AS (DELETE FROM sessions WHERE expires_at <= now())
     INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [hashToken(token), user.id, expiresAt],
  );

  return { token, expiresAt, user: toPublicUser(user) };
}

/** Returns the user for a valid, unexpired session of an active account, or null. */
export async function findSessionUser(token) {
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.email, u.role, u.student_number
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`,
    [hashToken(token)],
  );
  return rows[0] ? toPublicUser(rows[0]) : null;
}

/** Ends one session. Safe to call with an unknown or already-deleted token. */
export async function logout(token) {
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

/**
 * Uses a verification token: marks it used and the account verified. Returns { email }.
 * The UPDATE only matches an unused, unexpired token and locks its row, so two clicks
 * at the same moment cannot both succeed.
 */
export async function verifyEmail(token) {
  const tokenHash = hashToken(token);
  const { rows } = await query(
    `WITH claimed AS (
       UPDATE email_verification_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id
     )
     UPDATE users u SET email_verified_at = COALESCE(u.email_verified_at, now())
     FROM claimed
     WHERE u.id = claimed.user_id
     RETURNING u.email`,
    [tokenHash],
  );
  if (rows.length > 0) return { email: rows[0].email };

  // Say why it failed. Only someone holding the link learns this, and a 256-bit token
  // cannot be guessed, so it gives nothing away about other accounts.
  const { rows: [found] } = await query(
    'SELECT used_at IS NOT NULL AS used FROM email_verification_tokens WHERE token_hash = $1',
    [tokenHash],
  );
  if (!found) throw invalidVerificationLink();
  if (found.used) {
    throw new AppError(409, 'VERIFICATION_TOKEN_USED',
      'This link has already been used. If you confirmed your email address with it, you can sign in.');
  }
  throw new AppError(410, 'VERIFICATION_TOKEN_EXPIRED',
    'This link has expired. Ask for a new one below; it will work for 24 hours.');
}

/** For a token that is missing, malformed or unknown. */
export function invalidVerificationLink() {
  return new AppError(400, 'VERIFICATION_TOKEN_INVALID',
    'This link is not valid. It may be incomplete, or a newer link may have replaced it.');
}

/**
 * Emails a new verification link if `email` belongs to an active, unverified account;
 * otherwise does nothing. Either way it runs the same single query and never waits for
 * the email, so neither the result nor the timing tells the caller whether the address
 * is registered (the controller always gives the same answer).
 */
export async function resendVerification(email) {
  const token = newToken();
  const { rows } = await query(
    `WITH target AS (
       SELECT id, full_name, email FROM users
       WHERE email = $1 AND email_verified_at IS NULL AND is_active
     ), replaced AS (
       -- Only the newest link works: earlier unused links stop working.
       DELETE FROM email_verification_tokens t
       USING target
       WHERE t.user_id = target.id AND t.used_at IS NULL
     ), issued AS (
       INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       SELECT id, $2, $3 FROM target
     )
     SELECT full_name, email FROM target`,
    [email, hashToken(token), verificationExpiry()],
  );
  if (rows[0]) queueVerificationEmail({ email: rows[0].email, fullName: rows[0].full_name, token });
}
