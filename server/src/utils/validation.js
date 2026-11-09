import AppError from './app-error.js';

/** Largest value of a PostgreSQL INTEGER column (ids, capacities). */
export const MAX_INTEGER = 2_147_483_647;

/** "42" or 42 -> 42. Anything else ("4.5", "1e3", "", " 7x", 2.5) -> undefined. */
function toInteger(raw) {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : undefined;
  if (typeof raw !== 'string' || !/^-?\d{1,15}$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

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
    if (value.length === 0 && !required) return undefined; // only spaces: treat as not given
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

  /**
   * Reads a whole number. Accepts a JSON number or a string of digits (query strings
   * are always text). Returns the number, or undefined if it is missing/invalid.
   */
  integer(field, { label, required = true, min = 1, max = MAX_INTEGER } = {}) {
    const raw = this.body[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this.addError(field, `${label} is required.`);
      return undefined;
    }
    const value = toInteger(raw);
    if (value === undefined) {
      this.addError(field, `${label} must be a whole number.`);
      return undefined;
    }
    if (value < min || value > max) {
      this.addError(field, `${label} must be between ${min} and ${max}.`);
      return undefined;
    }
    return value;
  }

  /** Reads one value from a fixed list, e.g. a facility type. */
  oneOf(field, allowed, { label, required = true } = {}) {
    const value = this.string(field, { label, required, max: 100 });
    if (value === undefined) return undefined;
    if (!allowed.includes(value)) {
      this.addError(field, `${label} must be one of: ${allowed.join(', ')}.`);
      return undefined;
    }
    return value;
  }

  /**
   * Reads a list of whole numbers, sent as "1,3" or as a repeated parameter
   * (?equipment=1&equipment=3). Returns the distinct values, or undefined if missing/invalid.
   */
  integerList(field, { label, required = true, min = 1, max = MAX_INTEGER, maxItems = 50 } = {}) {
    const items = this.#listItems(field, { label, required, maxItems });
    if (items === undefined) return undefined;
    const values = items.map(toInteger);
    if (values.some((value) => value === undefined || value < min || value > max)) {
      this.addError(field, `${label} must be a list of whole numbers between ${min} and ${max}.`);
      return undefined;
    }
    return [...new Set(values)];
  }

  /** Reads a list of values from a fixed list, sent as "a,b" or as a repeated parameter. */
  oneOfList(field, allowed, { label, required = true } = {}) {
    const items = this.#listItems(field, { label, required, maxItems: allowed.length });
    if (items === undefined) return undefined;
    if (items.some((item) => !allowed.includes(item))) {
      this.addError(field, `${label} must be one or more of: ${allowed.join(', ')}.`);
      return undefined;
    }
    return [...new Set(items)];
  }

  #listItems(field, { label, required, maxItems }) {
    const raw = this.body[field];
    const parts = (Array.isArray(raw) ? raw : [raw])
      .flatMap((part) => (typeof part === 'string' ? part.split(',') : [part]))
      .map((part) => (typeof part === 'string' ? part.trim() : part))
      .filter((part) => part !== undefined && part !== null && part !== '');
    if (parts.length === 0) {
      if (required) this.addError(field, `${label} is required.`);
      return undefined;
    }
    if (parts.length > maxItems) {
      this.addError(field, `${label} accepts at most ${maxItems} values.`);
      return undefined;
    }
    return parts;
  }

  /** Throws a 400 if any field failed. */
  assertValid() {
    if (Object.keys(this.errors).length > 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', { details: this.errors });
    }
  }
}

// Deliberately simple: one "@", no spaces, a dot in the domain. At registration,
// utils/email-domain.js then checks that the domain can receive mail and is not a
// disposable email service. Proof that the mailbox itself exists would need an email
// to be sent, which this project does not do.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value) {
  return EMAIL_PATTERN.test(value);
}
