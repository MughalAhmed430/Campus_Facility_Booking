import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import config from '../config/index.js';
import { query } from '../db/pool.js';
import AppError from '../utils/app-error.js';

const { bcryptRounds, sessionTtlMs } = config.auth;

// Login answers "wrong email", "wrong password" and "deactivated account" identically,
// including how long it takes: for an unknown email we still run one bcrypt
// comparison, against this hash of a random password nobody knows.
const dummyPasswordHash = bcrypt.hash(crypto.randomBytes(16).toString('hex'), bcryptRounds);

const INVALID_CREDENTIALS = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');

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

/** The cookie holds the token; the database holds only its SHA-256 hash. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Creates a student account. The role is fixed here; it never comes from the request. */
export async function registerStudent({ fullName, email, password, studentNumber }) {
  const passwordHash = await bcrypt.hash(password, bcryptRounds);
  try {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, student_number)
       VALUES ($1, $2, $3, 'student', $4)
       RETURNING id, full_name, email, role, student_number`,
      [fullName, email, passwordHash, studentNumber ?? null],
    );
    return toPublicUser(rows[0]);
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
    `SELECT id, full_name, email, role, student_number, is_active, password_hash
     FROM users WHERE email = $1`,
    [email],
  );
  const user = rows[0];

  const passwordMatches = await bcrypt.compare(password, user ? user.password_hash : await dummyPasswordHash);
  if (!user || !passwordMatches || !user.is_active) throw INVALID_CREDENTIALS();

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
