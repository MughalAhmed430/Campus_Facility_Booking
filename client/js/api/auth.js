import { api, ApiError } from './client.js';

/** The signed-in user ({ id, fullName, email, role, studentNumber }), or null when signed out. */
export async function getCurrentUser() {
  try {
    const { user } = await api.get('/auth/me');
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** Resolves to { user, sessionExpiresAt }; the server sets the session cookie. */
export function login(email, password) {
  return api.post('/auth/login', { email, password });
}

/** fields: { fullName, email, password, studentNumber? }. Resolves to { user }. */
export function register(fields) {
  return api.post('/auth/register', fields);
}

export function logout() {
  return api.post('/auth/logout');
}

/**
 * Uses the token from a verification email. Resolves to { verified: true, email }.
 * Fails with ApiError code VERIFICATION_TOKEN_INVALID (400), VERIFICATION_TOKEN_USED (409)
 * or VERIFICATION_TOKEN_EXPIRED (410).
 */
export function verifyEmail(token) {
  return api.get('/auth/verify-email', { query: { token } });
}

/** Asks for a new verification link. Resolves to { message }, the same for every address. */
export function resendVerification(email) {
  return api.post('/auth/resend-verification', { email });
}
