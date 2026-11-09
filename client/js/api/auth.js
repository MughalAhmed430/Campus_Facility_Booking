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
