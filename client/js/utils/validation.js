// Quick checks in the browser, so obvious mistakes are shown before a request is sent.
// The server validates everything again; these rules mirror server/src (keep them in step).

// Same pattern as the server: one "@", no spaces, a dot in the domain.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value) {
  return EMAIL_PATTERN.test(value);
}

/** Length in UTF-8 bytes. bcrypt (and so the server) accepts passwords up to 72 bytes. */
export function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;
export const STUDENT_NUMBER_PATTERN = /^[0-9]{1,6}$/;

// Booking requests: the same limits as server/src/services/booking.service.js.
export const BOOKING_MIN_MINUTES = 30;
export const BOOKING_MAX_MINUTES = 240;
export const BOOKING_PURPOSE_MIN_LENGTH = 5;
export const BOOKING_TEXT_MAX_LENGTH = 500;
