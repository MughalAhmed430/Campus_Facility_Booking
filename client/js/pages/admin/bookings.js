import { cancelBooking, listAllBookings } from '../../api/bookings.js';
import { listFacilities } from '../../api/facilities.js';
import { initAppShell, ROUTES } from '../../components/app-shell.js';
import { facilityUrl } from '../../components/facility-card.js';
import {
  clearFieldErrors, infoDialog, reasonDialog, renderAlert, renderEmpty, renderError, renderLoading,
  showFieldErrors, toast, withButtonLoading,
} from '../../components/feedback.js';
import { statusBadge, statusLabel } from '../../components/status-badge.js';
import { campusDateOf, isDateText } from '../../utils/campus-time.js';
import { h } from '../../utils/dom.js';
import { dateLabel, pluralize, roomLabel } from '../../utils/format.js';
import { BOOKING_TEXT_MAX_LENGTH } from '../../utils/validation.js';

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'completed'];
const REASON_MIN_LENGTH = 5; // the same as the server
// Typing in the search or a date box waits this long, so one request is sent per pause.
const TYPING_DELAY_MS = 300;
const TYPED_INPUTS = new Set(['search', 'date']);

const form = document.getElementById('filter-form');
const filtersBox = document.getElementById('filters');
const toggle = document.getElementById('filter-toggle');
const filterCount = document.getElementById('filter-count');
const resultCount = document.getElementById('result-count');
const resultsTitle = document.getElementById('results-title');
const alertBox = document.getElementById('bookings-alert');
const list = document.getElementById('bookings');
const pages = document.getElementById('bookings-pages');

let page = 1;
let typingTimer;
let activeRequest;

const user = await initAppShell({ access: 'admin' });
if (user) await init();

async function init() {
  renderLoading(list, 'Loading bookings…');
  let facilities;
  try {
    ({ facilities } = await listFacilities());
  } catch (error) {
    renderError(list, error, { title: 'Could not load the bookings', onRetry: () => window.location.reload() });
    return;
  }

  form.elements.facility.append(...facilities
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((facility) => h('option', { value: facility.id }, `${facility.name} (${roomLabel(facility)})`)));
  document.getElementById('filter-status-options').append(...STATUSES.map((status) =>
    h('label', { class: 'checkbox' },
      h('input', { type: 'checkbox', name: 'status', value: status }),
      h('span', {}, statusLabel(status)))));
  applyToForm(new URLSearchParams(window.location.search));

  // Any change to the filters starts again from the first page.
  form.addEventListener('input', (event) => {
    clearTimeout(typingTimer);
    page = 1;
    if (TYPED_INPUTS.has(event.target.type)) typingTimer = setTimeout(load, TYPING_DELAY_MS);
    else load();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault(); // Enter in the search box searches at once
    clearTimeout(typingTimer);
    page = 1;
    load();
  });
  document.getElementById('filter-clear').addEventListener('click', clearFilters);
  toggle.addEventListener('click', () => {
    const open = !filtersBox.classList.contains('is-open');
    filtersBox.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });

  await load();
}

function clearFilters() {
  form.reset();
  clearTimeout(typingTimer);
  page = 1;
  load();
}

// ---- Loading ---------------------------------------------------------------------------

/** Loads the current page of the current filters. Resolves once it is shown (or failed). */
async function load() {
  const filters = readForm();
  clearFieldErrors(form);
  const problems = validate(filters);
  if (problems) {
    showFieldErrors(form, problems);
    return;
  }
  remember(filters);
  const active = countActive(filters);
  filterCount.textContent = active > 0 ? `(${active} active)` : '';

  // A newer search replaces an older one that is still waiting for the server.
  activeRequest?.abort();
  const request = new AbortController();
  activeRequest = request;

  list.setAttribute('aria-busy', 'true');
  if (!list.querySelector('table')) renderLoading(list, 'Loading bookings…'); // otherwise the old rows stay until the new ones arrive
  try {
    const result = await listAllBookings({ ...filters, page }, { signal: request.signal });
    // The last booking of the last page went away (or the address named a page too far).
    if (result.bookings.length === 0 && result.total > 0 && page > result.totalPages) {
      page = result.totalPages;
      await load();
      return;
    }
    render(result, active > 0);
  } catch (error) {
    if (request.signal.aborted) return;
    resultCount.textContent = '';
    pages.replaceChildren();
    const unmatched = error.details ? showFieldErrors(form, error.details) : [];
    if (error.details && unmatched.length === 0) list.replaceChildren(); // the messages are next to the filters
    else renderError(list, error, { title: 'Could not load the bookings', onRetry: load });
  } finally {
    if (activeRequest === request) list.removeAttribute('aria-busy');
  }
}

function render({ bookings, total, pageSize, totalPages }, filtered) {
  if (total === 0) {
    resultCount.textContent = filtered ? 'No bookings match your filters' : 'No bookings yet';
    pages.replaceChildren();
    renderEmpty(list, filtered
      ? { title: 'No bookings match these filters', message: 'Try a wider date range, another status or a different student.', action: { label: 'Clear filters', onClick: clearFilters } }
      : { title: 'No bookings yet', message: 'Booking requests appear here as students send them.' });
    return;
  }
  // "45 bookings match your filters, showing 21–40"
  const first = (page - 1) * pageSize + 1;
  const matching = filtered ? ` ${total === 1 ? 'matches' : 'match'} your filters` : '';
  const shown = totalPages > 1 ? `, showing ${first}–${first + bookings.length - 1}` : '';
  resultCount.textContent = `${pluralize(total, 'booking')}${matching}${shown}`;
  list.replaceChildren(bookingTable(bookings, total));
  pages.replaceChildren(totalPages > 1 ? pagination(totalPages) : '');
}

// ---- The table -----------------------------------------------------------------------------

function bookingTable(bookings, total) {
  const headers = ['Student', 'Facility', 'Date and time', 'Status', 'Purpose'];
  return h('div', { class: 'table-wrap table-wrap--stack' },
    h('table', { class: 'table table--stack', role: 'table' },
      h('caption', { class: 'visually-hidden' }, `Bookings: ${bookings.length} of ${total}, latest first`),
      h('thead', { role: 'rowgroup' },
        h('tr', { role: 'row' },
          headers.map((text) => h('th', { scope: 'col', role: 'columnheader' }, text)),
          h('th', { scope: 'col', role: 'columnheader' }, h('span', { class: 'visually-hidden' }, 'Actions')))),
      h('tbody', { role: 'rowgroup' }, bookings.map(bookingRow))));
}

/** A cell that shows its column name when the table turns into cards on a phone. */
function cell(label, attrs, ...content) {
  return h('td', { role: 'cell', ...attrs },
    label ? h('span', { class: 'table__label', 'aria-hidden': 'true' }, label) : null,
    ...content);
}

function bookingRow(booking) {
  const { student, facility } = booking;
  return h('tr', { role: 'row', 'data-booking-id': booking.id },
    cell(null, {},
      student.fullName,
      h('span', { class: 'table__sub' }, [student.studentNumber ? `No. ${student.studentNumber}` : null, student.email].filter(Boolean).join(' · '))),
    cell('Facility', {},
      h('a', { class: 'table__nowrap', href: facilityUrl(facility.id) }, facility.name),
      h('span', { class: 'table__sub' }, `${roomLabel(facility)} · ${facility.building.name}`)),
    cell('Date and time', { class: 'table__nowrap' },
      h('span', { class: 'table__line' }, dateLabel(booking.date)),
      h('span', { class: 'table__line' }, `${booking.startTime}–${booking.endTime}`)),
    cell('Status', {}, statusBadge(booking.status), statusNote(booking)),
    cell('Purpose', { class: 'table__wide' }, booking.purpose),
    h('td', { role: 'cell' }, actions(booking)));
}

/** A short line under the status: who cancelled, or that a request was never reviewed. */
function statusNote(booking) {
  let text = null;
  if (booking.status === 'cancelled') text = booking.cancellation.byStudent ? 'By the student' : 'By an administrator';
  else if (booking.status === 'pending' && booking.hasStarted) text = 'Not reviewed before the start time';
  return text ? h('span', { class: 'table__sub' }, text) : null;
}

/** "Kim Min-jun: Computer Lab A (ENG 310), Thu, 12 Nov 2026, 10:00–12:00" */
function describe(booking) {
  return `${booking.student.fullName}: ${booking.facility.name} (${roomLabel(booking.facility)}), `
    + `${dateLabel(booking.date)}, ${booking.startTime}–${booking.endTime}`;
}

function actions(booking) {
  // Every row has these buttons; the hidden part says which booking they are for.
  const which = () => h('span', { class: 'visually-hidden' },
    `: ${booking.student.fullName}, ${booking.facility.name}, ${dateLabel(booking.date)}, ${booking.startTime}`);
  const details = h('button', { type: 'button', class: 'btn btn--sm' }, 'Details', which());
  details.addEventListener('click', () => showDetails(booking, details));
  if (!booking.canCancel) return h('div', { class: 'table__actions' }, details);
  const cancel = h('button', { type: 'button', class: 'btn btn--sm' }, 'Cancel', which());
  cancel.addEventListener('click', () => confirmCancel(booking, cancel));
  return h('div', { class: 'table__actions' }, details, cancel);
}

// ---- Details -------------------------------------------------------------------------------

function detail(term, ...description) {
  return h('div', {}, h('dt', {}, term), h('dd', {}, ...description));
}

/** '2026-11-10T05:30:00.000Z' -> "Tue, 10 Nov 2026, 14:30" in Korea time */
function momentLabel(isoInstant) {
  const time = new Date(Date.parse(isoInstant) + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
  return `${dateLabel(campusDateOf(isoInstant))}, ${time}`;
}

async function showDetails(booking, button) {
  const { student, facility, decision, cancellation } = booking;
  // "Approved" for a booking that was approved, whatever happened to it afterwards.
  const decisionTerm = booking.status === 'rejected' ? 'Rejected' : 'Approved';
  await infoDialog({
    title: booking.status === 'pending' ? 'Booking request' : 'Booking',
    content: h('dl', { class: 'details-list' },
      detail('Status', statusBadge(booking.status),
        booking.status === 'pending'
          ? h('p', { class: 'hint' }, booking.hasStarted
            ? 'It was not reviewed before its start time.'
            : 'Waiting for a decision. It holds no time until it is approved.')
          : null),
      detail('Student', student.fullName,
        h('p', { class: 'hint' }, [student.studentNumber ? `No. ${student.studentNumber}` : null, student.email].filter(Boolean).join(' · '))),
      detail('Facility', `${facility.name} (${roomLabel(facility)})`, h('p', { class: 'hint' }, facility.building.name)),
      detail('When', `${dateLabel(booking.date)}, ${booking.startTime}–${booking.endTime}`),
      detail('Participants', `${booking.participantCount} of ${facility.capacity} people`),
      detail('Purpose', booking.purpose),
      booking.notes ? detail('Notes', booking.notes) : null,
      detail('Requested', momentLabel(booking.createdAt)),
      decision
        ? detail(decisionTerm, `${momentLabel(decision.decidedAt)}, by ${decision.by.fullName}`,
          decision.note ? h('p', { class: 'hint' }, `${booking.status === 'rejected' ? 'Reason' : 'Note'}: ${decision.note}`) : null)
        : null,
      cancellation
        ? detail('Cancelled', `${momentLabel(cancellation.cancelledAt)}, by ${cancellation.byStudent ? 'the student' : cancellation.by.fullName}`,
          h('p', { class: 'hint' }, cancellation.reason ? `Reason: ${cancellation.reason}` : 'No reason given.'))
        : null),
    // Requests that have not started are in the review queue.
    link: booking.status === 'pending' && !booking.hasStarted ? { label: 'Review in Requests', href: ROUTES.adminRequests } : null,
  });
  button.focus();
}

// ---- Cancelling ---------------------------------------------------------------------------

async function confirmCancel(booking, button) {
  const reason = await reasonDialog({
    title: 'Cancel this booking?',
    message: `${describe(booking)}. The time becomes free for other requests, and the student sees your reason on their My bookings page.`,
    label: 'Reason',
    required: true,
    minLength: REASON_MIN_LENGTH,
    maxLength: BOOKING_TEXT_MAX_LENGTH,
    hint: `${REASON_MIN_LENGTH} to ${BOOKING_TEXT_MAX_LENGTH} characters.`,
    confirmLabel: 'Cancel booking',
    cancelLabel: 'Keep booking',
    danger: true,
  });
  if (reason === null) {
    button.focus();
    return;
  }

  renderAlert(alertBox, {});
  try {
    await withButtonLoading(button, cancelBooking(booking.id, { reason }));
  } catch (error) {
    renderAlert(alertBox, { type: 'danger', title: 'Could not cancel the booking', message: error.message });
    // Changed somewhere else (the student, another administrator): show it as it is now.
    if (error.status === 404 || error.status === 409) await load();
    resultsTitle.focus();
    return;
  }
  // Reloaded from the server: with a status filter on, the booking may leave the list.
  await load();
  toast('Booking cancelled.');
  const row = list.querySelector(`tr[data-booking-id="${booking.id}"]`);
  (row?.querySelector('button') ?? resultsTitle).focus();
}

// ---- Pages ---------------------------------------------------------------------------------

function pagination(totalPages) {
  const step = (label, target, disabled) => h('button', {
    type: 'button', class: 'btn btn--sm', disabled, onClick: () => goToPage(target),
  }, label);
  return h('nav', { class: 'pagination', 'aria-label': 'Pages of bookings' },
    step('Previous page', page - 1, page <= 1),
    h('p', { class: 'pagination__status' }, `Page ${page} of ${totalPages}`),
    step('Next page', page + 1, page >= totalPages));
}

async function goToPage(target) {
  page = target;
  await load();
  // The button pressed may be gone or disabled now: start again at the top of the results.
  resultsTitle.focus();
  resultsTitle.scrollIntoView({ block: 'start' });
}

// ---- Form <-> filters <-> URL ------------------------------------------------------------

function readForm() {
  const data = new FormData(form);
  const text = (name) => String(data.get(name) ?? '').trim();
  return { q: text('q'), facility: text('facility'), from: text('from'), to: text('to'), status: data.getAll('status').map(String) };
}

/** The same rule as the server, checked first. Returns { field: message }, or null. */
function validate(filters) {
  return filters.from && filters.to && filters.to < filters.from ? { to: 'Must be on or after the "From" date.' } : null;
}

function countActive(filters) {
  return Object.values(filters).filter((value) => (Array.isArray(value) ? value.length > 0 : Boolean(value))).length;
}

/** Fills the form from ?q=&facility=&from=&to=&status=a,b&page=. Values that match nothing are ignored. */
function applyToForm(params) {
  form.elements.q.value = params.get('q') ?? '';
  form.elements.facility.value = params.get('facility') ?? '';
  for (const name of ['from', 'to']) form.elements[name].value = isDateText(params.get(name)) ? params.get(name) : '';
  const selected = new Set((params.get('status') ?? '').split(','));
  for (const box of form.querySelectorAll('input[name="status"]')) box.checked = selected.has(box.value);
  const wanted = Number(params.get('page'));
  page = Number.isSafeInteger(wanted) && wanted >= 1 && wanted <= 1_000_000 ? wanted : 1;
}

/** Keeps the filters and the page in the address bar (reload, back button, sharing a link). */
function remember(filters) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    const text = Array.isArray(value) ? value.join(',') : value;
    if (text) params.set(name, text);
  }
  if (page > 1) params.set('page', page);
  window.history.replaceState(null, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`);
}
