// The rules for a new password, shared by registration and changing a password.

// bcrypt only uses the first 72 bytes of a password; longer ones are rejected
// rather than silently truncated.
export const PASSWORD_MAX_BYTES = 72;
export const PASSWORD_MIN_LENGTH = 8;

/**
 * Reads a new password from `field` into `v`, adding an error for every rule it breaks.
 * Passwords are not trimmed: spaces are allowed and count. Returns the password or undefined.
 */
export function readNewPassword(v, field, { label = 'Password' } = {}) {
  const password = v.string(field, { label, min: PASSWORD_MIN_LENGTH, trim: false });
  if (password !== undefined && Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    v.addError(field, `${label} must be at most ${PASSWORD_MAX_BYTES} bytes (about 72 English characters).`);
  }
  if (password !== undefined && password.trim() === '') {
    v.addError(field, `${label} cannot be only spaces.`);
  }
  return password;
}
