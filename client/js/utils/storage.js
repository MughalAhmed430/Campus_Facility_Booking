// sessionStorage for small conveniences (the last facility search, the email address
// carried from email verification to sign-in). Storage can be unavailable (private
// windows, blocked site data), so every call is wrapped and the pages work without it.

export const STORAGE_KEYS = Object.freeze({
  signInEmail: 'auth:signInEmail',             // verify email -> sign in: pre-fills the email
  lastFacilitySearch: 'facilities:lastSearch', // facility details -> "Back to facilities" keeps the filters
});

export function sessionGet(key) {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function sessionSet(key, value) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Not available: the convenience is simply skipped.
  }
}

/** Reads a value once and removes it. */
export function sessionTake(key) {
  const value = sessionGet(key);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Not available.
  }
  return value;
}
