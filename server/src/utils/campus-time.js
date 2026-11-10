// Campus local time. Opening hours, "today" and weekends are all Korea time, whichever
// time zone the server runs in. Korea has had one UTC offset all year since 1988 (no
// daylight saving), so a fixed offset is exact.
const UTC_OFFSET = '+09:00';
const UTC_OFFSET_MS = 9 * 60 * 60 * 1000;

const realClock = () => new Date();
let clock = realClock;

/** Tests: `replacement` returns the current time as a Date. null restores the real clock. */
export function setClockForTests(replacement) {
  clock = replacement ?? realClock;
}

/** The current moment, as a Date. Use it instead of `new Date()` wherever a rule depends on the time. */
export function currentInstant() {
  return clock();
}

/** Today's date on campus, e.g. '2026-11-10'. */
export function campusToday() {
  return new Date(clock().getTime() + UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** A campus date and time as one absolute moment: '2026-11-10T14:30:00+09:00'. */
export function campusInstant(date, time) {
  return `${date}T${time}:00${UTC_OFFSET}`;
}

/** True once that campus date and time is over. */
export function hasPassed(date, time) {
  return Date.parse(campusInstant(date, time)) < clock().getTime();
}

/** True for a Saturday or Sunday. A calendar date's weekday does not depend on any time zone. */
export function isWeekend(date) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}
