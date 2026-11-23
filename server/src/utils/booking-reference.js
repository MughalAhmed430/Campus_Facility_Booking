// The reservation reference shown wherever a booking appears: booking 42 -> 'FR-000042'.
// It is the booking id in a fixed format, so it is unique and never changes, and needs no
// column of its own. client/js/utils/format.js formats it the same way.

const PATTERN = /^\s*FR-?0*([0-9]{1,9})\s*$/i;

export function bookingReference(id) {
  return `FR-${String(id).padStart(6, '0')}`;
}

/** 'FR-000042', 'fr42', ' FR-42 ' -> 42; anything else -> null. */
export function parseBookingReference(text) {
  const match = PATTERN.exec(String(text ?? ''));
  if (!match) return null;
  const id = Number(match[1]);
  return id >= 1 && id <= 2_147_483_647 ? id : null;
}
