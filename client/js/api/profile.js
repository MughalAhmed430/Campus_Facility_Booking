import { api, apiUrl } from './client.js';

/** Resolves to { user }: the signed-in user's profile (id, fullName, email, role, studentNumber, hasPhoto, createdAt). */
export function getProfile({ signal } = {}) {
  return api.get('/profile', { signal });
}

/** Only the full name can be changed. Resolves to { user }. */
export function updateProfile({ fullName }) {
  return api.patch('/profile', { fullName });
}

/**
 * Resolves to { otherSessionsEnded }. Rejects with ApiError 400: WRONG_PASSWORD
 * (details.currentPassword) or VALIDATION_ERROR (details.newPassword), or 429.
 */
export function changePassword({ currentPassword, newPassword }) {
  return api.post('/profile/password', { currentPassword, newPassword });
}

/** file: a File (JPEG, PNG or WebP, at most 2 MB). Resolves to { user }. Rejects with 400 (details.photo). */
export function uploadPhoto(file) {
  const body = new FormData();
  body.append('photo', file);
  return api.put('/profile/photo', body);
}

export function removePhoto() {
  return api.delete('/profile/photo');
}

/**
 * The address of a user's photo, for an <img>. `version` changes the address after an
 * upload, so the browser does not keep showing the old picture.
 */
export function photoUrl(userId, version = '') {
  return apiUrl(`/users/${encodeURIComponent(userId)}/photo`, version ? { v: version } : undefined);
}
