// Korea time, whatever time zone the visitor's device is set to. The same rules as
// server/src/utils/campus-time.js; the server decides, this only gives earlier feedback.
const UTC_OFFSET_MS = 9 * 60 * 60 * 1000;

function campusIso() {
  return new Date(Date.now() + UTC_OFFSET_MS).toISOString();
}

/** Today on campus, e.g. '2026-11-10'. */
export function campusToday() {
  return campusIso().slice(0, 10);
}

/** The time on campus right now, e.g. '14:30'. */
export function campusTimeNow() {
  return campusIso().slice(11, 16);
}

/** The campus date of a moment from the API: '2026-11-10T16:30:00.000Z' -> '2026-11-11'. */
export function campusDateOf(isoInstant) {
  return new Date(Date.parse(isoInstant) + UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** True for a Saturday or Sunday. */
export function isWeekend(date) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/** A calendar date `days` later (or earlier, when negative): addDays('2026-11-30', 1) -> '2026-12-01'. */
export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The Monday of the week a date falls in (weeks run Monday to Sunday). */
export function mondayOf(date) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, weekday === 0 ? -6 : 1 - weekday);
}

/** True for a real calendar date written YYYY-MM-DD, e.g. from the address bar. */
export function isDateText(text) {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(text ?? '')) return false;
  const parsed = new Date(`${text}T00:00:00Z`); // 30 February is invalid, or rolls over into March
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}
