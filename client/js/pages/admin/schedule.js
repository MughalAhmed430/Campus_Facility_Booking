import { approveRequest, getDaySchedule, rejectRequest } from '../../api/bookings.js';
import { initAppShell } from '../../components/app-shell.js';
import { facilityUrl } from '../../components/facility-card.js';
import {
  infoDialog, reasonDialog, renderAlert, renderEmpty, renderError, renderLoading, toast,
} from '../../components/feedback.js';
import { statusBadge, statusLabel } from '../../components/status-badge.js';
import { addDays, campusTimeNow, campusToday, isDateText } from '../../utils/campus-time.js';
import { h } from '../../utils/dom.js';
import {
  bookingReference, dateLabel, FACILITY_TYPES, facilityTypeLabel, hoursLabel, longDateLabel, pluralize, roomLabel,
} from '../../utils/format.js';
import { assignLanes, minutesOf, setVars, timeOf } from '../../utils/timeline.js';
import { BOOKING_TEXT_MAX_LENGTH } from '../../utils/validation.js';

const REASON_MIN_LENGTH = 5; // the same as the server

const form = document.getElementById('day-form');
const dateInput = form.elements.date;
const typeSelect = form.elements.type;
const title = document.getElementById('day-title');
const summary = document.getElementById('day-summary');
const container = document.getElementById('day-schedule');
const alertBox = document.getElementById('day-alert');
let request = null;

const user = await initAppShell({ access: 'admin' });
if (user) init();

function init() {
  typeSelect.append(...FACILITY_TYPES.map((type) => h('option', { value: type }, facilityTypeLabel(type))));
  const params = new URLSearchParams(window.location.search);
  dateInput.value = isDateText(params.get('date')) ? params.get('date') : campusToday();
  typeSelect.value = FACILITY_TYPES.includes(params.get('type')) ? params.get('type') : '';

  // A date typed in part (or cleared) changes nothing until it is a whole date again.
  dateInput.addEventListener('change', () => {
    if (isDateText(dateInput.value)) load();
  });
  typeSelect.addEventListener('change', load);
  document.getElementById('day-previous').addEventListener('click', () => moveBy(-1));
  document.getElementById('day-next').addEventListener('click', () => moveBy(1));
  document.getElementById('day-today').addEventListener('click', () => {
    dateInput.value = campusToday();
    load();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault(); // Enter in the date box shows that day
    if (isDateText(dateInput.value)) load();
  });
  load();
}

function moveBy(days) {
  dateInput.value = addDays(isDateText(dateInput.value) ? dateInput.value : campusToday(), days);
  load();
}

/** Keeps the day and type in the address bar (reload, back button, sharing a link). */
function remember(date, type) {
  const params = new URLSearchParams({ date });
  if (type) params.set('type', type);
  window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
}

async function load() {
  // A date typed in part reads as empty; changing the type then shows today.
  if (!isDateText(dateInput.value)) dateInput.value = campusToday();
  const date = dateInput.value;
  const type = typeSelect.value;
  remember(date, type);
  title.textContent = longDateLabel(date) + (date === campusToday() ? ' (today)' : '');
  summary.textContent = '';

  request?.abort(); // a newer day replaces one still loading
  const controller = new AbortController();
  request = controller;
  container.setAttribute('aria-busy', 'true');
  renderLoading(container, 'Loading the schedule…');
  try {
    render(await getDaySchedule({ date, type }, { signal: controller.signal }));
  } catch (error) {
    if (controller.signal.aborted) return;
    renderError(container, error, { title: 'Could not load the schedule', onRetry: load, heading: 'h3' });
  } finally {
    if (request === controller) container.removeAttribute('aria-busy');
  }
}

function render(schedule) {
  const all = schedule.facilities.flatMap((facility) => facility.bookings);
  const pending = all.filter((booking) => booking.status === 'pending').length;
  summary.textContent = `${pluralize(all.length - pending, 'booking')} and ${pluralize(pending, 'pending request')} `
    + `in ${pluralize(schedule.facilities.length, 'facility', 'facilities')}.`;
  if (schedule.facilities.length === 0) {
    renderEmpty(container, { title: 'No facilities of this type', message: 'Choose "All types" to see every facility.' });
    return;
  }

  // The hours shown: from the earliest opening to the latest closing, widened to whole
  // hours and to any booking outside the opening hours.
  const starts = schedule.facilities.flatMap((f) => [f.openingHours.opensAt, ...f.bookings.map((b) => b.startTime)]).map(minutesOf);
  const ends = schedule.facilities.flatMap((f) => [f.openingHours.closesAt, ...f.bookings.map((b) => b.endTime)]).map(minutesOf);
  const range = { start: Math.floor(Math.min(...starts) / 60) * 60, end: Math.ceil(Math.max(...ends) / 60) * 60 };
  const hours = [];
  for (let minute = range.start; minute < range.end; minute += 60) hours.push(minute);

  const today = campusToday();
  const context = {
    date: schedule.date,
    range,
    // How much of the day has gone: all of it on a past day, none on a future one.
    now: schedule.date < today ? range.end : schedule.date > today ? range.start : minutesOf(campusTimeNow()),
  };

  container.replaceChildren(setVars(h('div', { class: 'day-grid' },
    h('div', { class: 'day-grid__scale', 'aria-hidden': 'true' }, hours.map((minute) => h('span', {}, timeOf(minute)))),
    h('ol', { class: 'day-grid__rows list-reset' }, schedule.facilities.map((facility) => facilityRow(facility, context)))),
  { '--hours': hours.length }));
}

/** A share of the hours shown, for CSS: 540 -> "12.5%" */
function share(minute, range) {
  const clamped = Math.min(Math.max(minute, range.start), range.end);
  return `${((clamped - range.start) / (range.end - range.start)) * 100}%`;
}

function facilityRow(facility, context) {
  const { range } = context;
  const blocks = facility.bookings.map((booking) => ({ booking, start: minutesOf(booking.startTime), end: minutesOf(booking.endTime) }));
  // Bookings first, so they share the top lane; overlapping requests go below them.
  const { lanes, laneOf } = assignLanes([
    ...blocks.filter((block) => block.booking.status !== 'pending'),
    ...blocks.filter((block) => block.booking.status === 'pending'),
  ]);

  let note = null;
  if (!facility.isOpen) note = blocks.length > 0 ? 'Closed today, but has bookings' : 'Closed today';
  else if (blocks.length === 0) note = 'No bookings';

  const track = setVars(h('div', { class: 'day-row__track' },
    blocks.length > 0
      ? h('ol', { class: 'day-row__items list-reset' }, blocks.map((block) => bookingSlot(facility, block, laneOf.get(block), lanes, context)))
      : null,
    note ? h('p', { class: 'day-row__note' }, note) : null), {
    '--lanes': lanes,
    '--opens-at': facility.isOpen ? share(minutesOf(facility.openingHours.opensAt), range) : '100%',
    '--closes-at': facility.isOpen ? share(minutesOf(facility.openingHours.closesAt), range) : '100%',
    '--now-at': share(context.now, range),
  });

  return h('li', { class: `day-row${facility.isOpen ? '' : ' is-closed'}`, 'data-facility-id': facility.id },
    h('div', { class: 'day-row__facility' },
      h('h3', { class: 'day-row__name' }, h('a', { href: facilityUrl(facility.id) }, facility.name)),
      h('p', { class: 'day-row__meta' },
        `${roomLabel(facility)} · `,
        facility.isOpen ? `Open ${hoursLabel(facility.openingHours)}` : 'Closed at weekends'),
      facility.isBookable ? null : statusBadge(facility.status)),
    track);
}

function bookingSlot(facility, { booking, start, end }, lane, lanes, context) {
  const button = h('button', { type: 'button', class: 'slot__button', onClick: () => showDetails(facility, booking, button, context) },
    h('span', { class: 'visually-hidden' }, `${statusLabel(booking.status)}: `),
    h('span', { class: 'slot__time' }, booking.startTime, h('span', { class: 'slot__end' }, `–${booking.endTime}`)),
    booking.status === 'pending' ? [' ', h('span', { class: 'slot__tag', 'aria-hidden': 'true' }, 'Request')] : null,
    ' ',
    h('span', { class: 'slot__text' },
      h('span', { class: 'slot__label' }, booking.student.fullName),
      h('span', { class: 'visually-hidden' }, ', '),
      ' ',
      h('span', { class: 'slot__purpose' }, booking.purpose)));
  return setVars(h('li', { class: `slot slot--${booking.status}`, 'data-booking-id': booking.id }, button), {
    '--from': share(start, context.range),
    '--to': share(end, context.range),
    '--lane': lane,
    '--lanes': lanes,
  });
}

function detail(term, ...description) {
  return h('div', {}, h('dt', {}, term), h('dd', {}, ...description));
}

/** The other bookings of the facility that overlap `booking` in time. */
function overlapping(facility, booking) {
  return facility.bookings.filter((other) => other.id !== booking.id
    && other.startTime < booking.endTime && booking.startTime < other.endTime);
}

async function showDetails(facility, booking, button, { date }) {
  const { student } = booking;
  const notStarted = date > campusToday() || (date === campusToday() && booking.startTime > campusTimeNow());
  // A request that has not started can be decided here, as on the Requests page.
  const decidable = booking.status === 'pending' && notStarted;
  const others = overlapping(facility, booking);
  const otherRequests = others.filter((other) => other.status === 'pending');
  const timeTaken = others.some((other) => other.status === 'approved' || other.status === 'completed');
  const canApprove = decidable && facility.isBookable && !timeTaken;
  let approveNote = null;
  if (decidable && timeTaken) approveNote = 'It cannot be approved: an approved booking already takes part of this time.';
  else if (decidable && !facility.isBookable) approveNote = 'It cannot be approved: this facility is not taking bookings at the moment.';

  const action = await infoDialog({
    title: booking.status === 'pending' ? 'Booking request' : 'Booking',
    actions: decidable
      ? [{ label: 'Reject', value: 'reject', danger: true }, canApprove ? { label: 'Approve', value: 'approve' } : null].filter(Boolean)
      : [],
    content: h('dl', { class: 'details-list' },
      detail('Reference', h('span', { class: 'reference' }, bookingReference(booking.id))),
      detail('Status', statusBadge(booking.status),
        booking.status === 'pending' ? h('p', { class: 'hint' }, 'Waiting for a decision. It holds no time until it is approved.') : null,
        approveNote ? h('p', { class: 'hint' }, approveNote) : null),
      detail('Student', student.fullName,
        h('p', { class: 'hint' }, [student.studentNumber ? `No. ${student.studentNumber}` : null, student.email].filter(Boolean).join(' · '))),
      detail('Facility', `${facility.name} (${roomLabel(facility)})`),
      detail('When', `${dateLabel(date)}, ${booking.startTime}–${booking.endTime}`),
      detail('Participants', `${booking.participantCount} of ${facility.capacity} people`),
      detail('Purpose', booking.purpose),
      booking.notes ? detail('Notes', booking.notes) : null,
      decidable && otherRequests.length > 0
        ? detail('Overlapping requests', h('ul', { class: 'list-reset' },
          otherRequests.map((other) => h('li', {}, `${other.student.fullName}, ${other.startTime}–${other.endTime}`))))
        : null),
  });
  if (action === 'approve') await approve(facility, booking, otherRequests, button);
  else if (action === 'reject') await reject(facility, booking, button);
  else button.focus();
}

/** "Kim Min-jun: Computer Lab A (ENG 310), Thu, 12 Nov 2026, 10:00–12:00" */
function describe(facility, booking) {
  return `${booking.student.fullName}: ${facility.name} (${roomLabel(facility)}), `
    + `${dateLabel(dateInput.value)}, ${booking.startTime}–${booking.endTime}`;
}

async function approve(facility, booking, otherRequests, button) {
  const note = await reasonDialog({
    title: 'Approve this request?',
    message: `${bookingReference(booking.id)}, ${describe(facility, booking)}.`,
    details: otherRequests.length > 0
      ? [h('p', {}, otherRequests.length === 1
        ? 'Approving it also rejects this overlapping request:'
        : `Approving it also rejects these ${otherRequests.length} overlapping requests:`),
      h('ul', { class: 'dialog__list' }, otherRequests.map((other) => h('li', {}, `${other.student.fullName}, ${other.startTime}–${other.endTime}`)))]
      : null,
    label: 'Note for the student',
    hint: `Shown with the booking on their My bookings page. Up to ${BOOKING_TEXT_MAX_LENGTH} characters.`,
    maxLength: BOOKING_TEXT_MAX_LENGTH,
    confirmLabel: 'Approve request',
    cancelLabel: 'Go back',
  });
  if (note === null) {
    button.focus();
    return;
  }
  await decide(booking, () => approveRequest(booking.id, { note }), (result) => (result.autoRejected.length > 0
    ? `Request approved. ${pluralize(result.autoRejected.length, 'overlapping request')} rejected.`
    : 'Request approved.'));
}

async function reject(facility, booking, button) {
  const reason = await reasonDialog({
    title: 'Reject this request?',
    message: `${bookingReference(booking.id)}, ${describe(facility, booking)}. The student sees your reason on their My bookings page.`,
    label: 'Reason',
    required: true,
    minLength: REASON_MIN_LENGTH,
    maxLength: BOOKING_TEXT_MAX_LENGTH,
    hint: `${REASON_MIN_LENGTH} to ${BOOKING_TEXT_MAX_LENGTH} characters.`,
    confirmLabel: 'Reject request',
    cancelLabel: 'Go back',
    danger: true,
  });
  if (reason === null) {
    button.focus();
    return;
  }
  await decide(booking, () => rejectRequest(booking.id, { reason }), () => 'Request rejected.');
}

/**
 * Sends a decision, then reloads the day so the schedule shows it. If it could not be
 * saved (someone decided first, or the time was taken meanwhile), says why above the
 * schedule and reloads the day as it is now. Focus goes to the booking's block, or to
 * the day's heading when it is no longer shown.
 */
async function decide(booking, send, describeResult) {
  renderAlert(alertBox, {});
  try {
    const result = await send();
    toast(describeResult(result));
  } catch (error) {
    renderAlert(alertBox, { type: 'danger', title: 'Could not save the decision', message: error.message });
  }
  await load();
  const block = container.querySelector(`[data-booking-id="${booking.id}"] button`);
  (block ?? title).focus();
}
