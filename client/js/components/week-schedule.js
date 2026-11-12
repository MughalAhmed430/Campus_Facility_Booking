import { getFacilitySchedule } from '../api/facilities.js';
import { addDays, campusTimeNow, campusToday, mondayOf } from '../utils/campus-time.js';
import { h } from '../utils/dom.js';
import { dateRangeLabel, dayLabel } from '../utils/format.js';
import { assignLanes, freeGaps, minutesOf, setVars, timeOf } from '../utils/timeline.js';
import { BOOKING_MIN_MINUTES } from '../utils/validation.js';
import { renderError, renderLoading } from './feedback.js';

// What each kind of booking from the API is called on screen.
const KIND_LABELS = {
  booked: 'Booked',
  yours: 'Your booking',
  'your-request': 'Your request',
};

// Choosing free time today starts it at the next half hour; the form gets one hour (or
// less, when the free time is shorter), which the student can change.
const START_STEP_MINUTES = 30;
const SUGGESTED_MINUTES = 60;

/**
 * A facility's week, Monday to Sunday, with Previous week / This week / Next week.
 * One list of days, shown as a 7-column grid from 768px and as a day-by-day list on
 * phones; screen readers always get the list.
 *   week          the Monday to show first
 *   forStudent    show the student's own bookings and requests in the key
 *   onChoose      when given (and the facility takes requests), free times are buttons
 *                 that call it with { date, startTime, endTime }
 *   onWeekChange  called with the Monday of the week now shown
 * Returns { element, reload }.
 */
export function weekSchedule(facility, { week, forStudent = false, onChoose = null, onWeekChange = null }) {
  let monday = week;
  let request = null;
  const canChoose = Boolean(onChoose) && facility.isBookable;

  const range = h('p', { class: 'schedule__range', 'aria-live': 'polite' });
  const body = h('div', { class: 'schedule__body' });
  const navButton = (label, nextMonday) =>
    h('button', { type: 'button', class: 'btn btn--sm', onClick: () => show(nextMonday()) }, label);

  const element = h('section', { class: 'card schedule', 'aria-labelledby': 'schedule-title' },
    h('div', { class: 'card__body stack' },
      h('div', { class: 'schedule__header' },
        h('div', {},
          h('h2', { class: 'card__section-title', id: 'schedule-title' }, 'Schedule'),
          range),
        h('div', { class: 'schedule__nav', role: 'group', 'aria-label': 'Week' },
          navButton('Previous week', () => addDays(monday, -7)),
          navButton('This week', () => mondayOf(campusToday())),
          navButton('Next week', () => addDays(monday, 7)))),
      legend({ forStudent, canChoose }),
      body));

  function show(nextMonday) {
    monday = nextMonday;
    onWeekChange?.(monday);
    return load();
  }

  async function load() {
    request?.abort(); // a newer week replaces one still loading
    const controller = new AbortController();
    request = controller;
    range.textContent = `${dateRangeLabel(monday, addDays(monday, 6))}, Korea time (KST)`;
    body.setAttribute('aria-busy', 'true');
    renderLoading(body, 'Loading the schedule…');
    try {
      const schedule = await getFacilitySchedule(facility.id, { from: monday }, { signal: controller.signal });
      body.replaceChildren(renderWeek(schedule, canChoose ? onChoose : null));
    } catch (error) {
      if (controller.signal.aborted) return;
      renderError(body, error, { title: 'Could not load the schedule', onRetry: load, heading: 'h3' });
    } finally {
      if (request === controller) body.removeAttribute('aria-busy');
    }
  }

  load();
  return { element, reload: load };
}

function legend({ forStudent, canChoose }) {
  const items = [
    ['booked', 'Booked'],
    forStudent ? ['yours', 'Your booking'] : null,
    forStudent ? ['your-request', 'Your request, waiting for a decision'] : null,
    canChoose ? ['free', 'Free: choose it to fill in the form'] : null,
    ['past', 'Past or closed'],
  ].filter(Boolean);
  return h('ul', { class: 'schedule-legend list-reset', 'aria-label': 'Key' },
    items.map(([kind, label]) => h('li', {},
      h('span', { class: `schedule-legend__swatch schedule-legend__swatch--${kind}`, 'aria-hidden': 'true' }),
      label)));
}

function renderWeek(schedule, onChoose) {
  const { openingHours } = schedule;
  // The hours shown: the opening hours, widened to whole hours, and to any booking made
  // before the hours changed.
  const all = schedule.days.flatMap((day) => day.bookings);
  const rangeStart = Math.floor(Math.min(minutesOf(openingHours.opensAt), ...all.map((b) => minutesOf(b.startTime))) / 60) * 60;
  const rangeEnd = Math.ceil(Math.max(minutesOf(openingHours.closesAt), ...all.map((b) => minutesOf(b.endTime))) / 60) * 60;
  const context = { openingHours, onChoose, rangeStart, rangeEnd, today: campusToday(), now: minutesOf(campusTimeNow()) };

  const hours = [];
  for (let minute = rangeStart; minute < rangeEnd; minute += 60) hours.push(minute);

  return setVars(h('div', { class: 'week' },
    h('div', { class: 'week__hours', 'aria-hidden': 'true' }, hours.map((minute) => h('span', {}, timeOf(minute)))),
    h('ol', { class: 'week__days list-reset' }, schedule.days.map((day) => renderDay(day, context)))),
  { '--range-start': rangeStart, '--range-span': rangeEnd - rangeStart, '--hours': hours.length });
}

function renderDay(day, { openingHours, onChoose, rangeStart, rangeEnd, today, now }) {
  const isToday = day.date === today;
  const isPast = day.date < today;
  const blocks = day.bookings.map((booking) => ({ booking, start: minutesOf(booking.startTime), end: minutesOf(booking.endTime) }));
  const holdsTime = (block) => block.booking.kind !== 'your-request';

  // Free time: only approved bookings hold time, so requests (even the student's own)
  // leave it free. Today, it starts at the next half hour that has not begun.
  let gaps = [];
  if (onChoose && day.isOpen && !isPast) {
    const opens = minutesOf(openingHours.opensAt);
    const from = isToday ? Math.max(opens, Math.ceil((now + 1) / START_STEP_MINUTES) * START_STEP_MINUTES) : opens;
    gaps = freeGaps(from, minutesOf(openingHours.closesAt), blocks.filter(holdsTime), BOOKING_MIN_MINUTES);
  }

  // Bookings get the first lane; a request overlapping one goes beside it.
  const { lanes, laneOf } = assignLanes([...blocks.filter(holdsTime), ...blocks.filter((block) => !holdsTime(block))]);
  const entries = [
    ...blocks.map((block) => ({ start: block.start, node: bookingSlot(block, laneOf.get(block), lanes) })),
    ...gaps.map((gap) => ({ start: gap.start, node: freeSlot(day.date, gap, onChoose) })),
  ].sort((a, b) => a.start - b.start);

  let note = null;
  if (!day.isOpen) note = 'Closed';
  else if (entries.length === 0) note = isPast ? 'No bookings' : 'Nothing booked';

  const classes = ['week__day', isToday && 'is-today', isPast && 'is-past', !day.isOpen && 'is-closed'].filter(Boolean);
  const dayBody = h('div', { class: 'week__body' },
    entries.length > 0 ? h('ol', { class: 'week__items list-reset' }, entries.map((entry) => entry.node)) : null,
    note ? h('p', { class: `week__note${note === 'Closed' ? '' : ' week__note--empty'}` }, note) : null);
  // Today, the part of the day that has gone is shaded.
  if (isToday) setVars(dayBody, { '--now': Math.min(Math.max(now, rangeStart), rangeEnd) });

  return h('li', { class: classes.join(' '), 'data-date': day.date },
    h('h3', { class: 'week__date' }, dayLabel(day.date), isToday ? [' ', h('span', { class: 'week__today' }, 'Today')] : null),
    dayBody);
}

function bookingSlot({ booking, start, end }, lane, lanes) {
  return setVars(h('li', { class: `slot slot--${booking.kind}` },
    h('span', { class: 'slot__time' }, `${booking.startTime}–${booking.endTime}`),
    ' ',
    h('span', { class: 'slot__label' }, KIND_LABELS[booking.kind]),
    booking.kind === 'your-request' ? h('span', { class: 'visually-hidden' }, ', waiting for a decision') : null),
  { '--start': start, '--end': end, '--lane': lane, '--lanes': lanes });
}

function freeSlot(date, gap, onChoose) {
  const startTime = timeOf(gap.start);
  const endTime = timeOf(Math.min(gap.start + SUGGESTED_MINUTES, gap.end));
  return setVars(h('li', { class: 'slot slot--free' },
    h('button', { type: 'button', class: 'slot__button', onClick: () => onChoose({ date, startTime, endTime }) },
      h('span', { class: 'slot__time' }, `${timeOf(gap.start)}–${timeOf(gap.end)}`),
      ' ',
      h('span', { class: 'slot__label' }, 'Free'),
      h('span', { class: 'visually-hidden' }, `, ${dayLabel(date)}. Fills in the form with ${startTime}–${endTime}.`))),
  { '--start': gap.start, '--end': gap.end, '--lane': 0, '--lanes': 1 });
}
