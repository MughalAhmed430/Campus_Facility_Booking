import AppError from './app-error.js';

/**
 * Collects field errors while reading an untrusted request body, then throws a
 * single 400 response listing every problem, so a form can highlight all fields at once:
 *
 *   { "code": "VALIDATION_ERROR", "message": "...", "details": { "email": "Enter a valid email address." } }
 */
export class FieldValidator {
  constructor(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(400, 'INVALID_BODY', 'Send a JSON object with the header Content-Type: application/json.');
    }
    this.body = body;
    this.errors = {};
  }

  addError(field, message) {
    if (!this.errors[field]) this.errors[field] = message;
  }

  /** Reads a string field. Returns the trimmed value, or undefined if it is missing/invalid. */
  string(field, { label, required = true, min = 1, max, trim = true } = {}) {
    const raw = this.body[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this.addError(field, `${label} is required.`);
      return undefined;
    }
    if (typeof raw !== 'string') {
      this.addError(field, `${label} must be text.`);
      return undefined;
    }
    const value = trim ? raw.trim() : raw;
    if (value.length < min) {
      this.addError(field, required && value.length === 0 ? `${label} is required.` : `${label} must be at least ${min} characters.`);
      return undefined;
    }
    if (max !== undefined && value.length > max) {
      this.addError(field, `${label} must be at most ${max} characters.`);
      return undefined;
    }
    return value;
  }

  /** Throws a 400 if any field failed. */
  assertValid() {
    if (Object.keys(this.errors).length > 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', { details: this.errors });
    }
  }
}

// Deliberately simple: one "@", no spaces, a dot in the domain. Real proof that an
// address exists would need email verification, which is out of scope.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value) {
  return EMAIL_PATTERN.test(value);
}
