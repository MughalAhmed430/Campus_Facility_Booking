import { approveRequest, listRequests, rejectRequest } from '../../api/bookings.js';
import { initAppShell } from '../../components/app-shell.js';
import {
  reasonDialog, renderAlert, renderEmpty, renderError, renderLoading, toast, withButtonLoading,
} from '../../components/feedback.js';
import { campusDateOf } from '../../utils/campus-time.js';
import { h } from '../../utils/dom.js';
import { dateLabel, pluralize, roomLabel } from '../../utils/format.js';
import { BOOKING_TEXT_MAX_LENGTH } from '../../utils/validation.js';

const REASON_MIN_LENGTH = 5; // the same as the server

const list = document.getElementById('requests');
const alertBox = document.getElementById('requests-alert');
const countLine = document.getElementById('requests-count');
const heading = document.getElementById('requests-title');
let requests = null; // null while loading, or when loading failed

const user = await initAppShell({ access: 'admin' });
if (user) load();

async function load() {
  requests = null;
  countLine.textContent = '';
  list.setAttribute('aria-busy', 'true');
  renderLoading(list, 'Loading requests…');
  try {
    ({ requests } = await listRequests());
  } catch (error) {
    renderError(list, error, { title: 'Could not load the requests', onRetry: load });
    return;
  } finally {
    list.removeAttribute('aria-busy');
  }
  render();
}

function render() {
  countLine.textContent = requests.length === 0
    ? 'Nothing is waiting for a decision.'
    : `${pluralize(requests.length, 'request')} waiting for a decision.`;
  if (requests.length === 0) {
    renderEmpty(list, { title: 'No requests waiting', message: 'New booking requests appear here as students send them.' });
    return;
  }
  list.replaceChildren(requestTable());
}

function requestTable() {
  // Participants sit with the facility, next to its capacity: six columns fit from 768px.
  const headers = ['Student', 'Facility', 'Date and time', 'Purpose', 'Clashes'];
  return h('div', { class: 'table-wrap table-wrap--stack' },
    h('table', { class: 'table table--stack', role: 'table' },
      h('caption', { class: 'visually-hidden' }, `Pending booking requests: ${pluralize(requests.length, 'request')}`),
      h('thead', { role: 'rowgroup' },
        h('tr', { role: 'row' },
          headers.map((text) => h('th', { scope: 'col', role: 'columnheader' }, text)),
          h('th', { scope: 'col', role: 'columnheader' }, h('span', { class: 'visually-hidden' }, 'Actions')))),
      h('tbody', { role: 'rowgroup' }, requests.map(requestRow))));
}

/** A cell that shows its column name when the table turns into cards on a phone. */
function cell(label, attrs, ...content) {
  return h('td', { role: 'cell', ...attrs },
    label ? h('span', { class: 'table__label', 'aria-hidden': 'true' }, label) : null,
    ...content);
}

function requestRow(request) {
  const { student, facility } = request;
  return h('tr', { role: 'row', 'data-request-id': request.id },
    cell(null, {},
      student.fullName,
      h('span', { class: 'table__sub' }, [student.studentNumber ? `No. ${student.studentNumber}` : null, student.email].filter(Boolean).join(' · '))),
    cell('Facility', {},
      h('a', { class: 'table__nowrap', href: `/pages/facility.html?id=${encodeURIComponent(facility.id)}` }, facility.name),
      h('span', { class: 'table__sub' }, `${roomLabel(facility)} · ${facility.building.name}`),
      h('span', { class: 'table__sub' }, `${request.participantCount} of ${facility.capacity} people`)),
    cell('Date and time', { class: 'table__nowrap' },
      h('span', { class: 'table__line' }, dateLabel(request.date)),
      h('span', { class: 'table__line' }, `${request.startTime}–${request.endTime}`),
      h('span', { class: 'table__sub' }, `Requested ${dateLabel(campusDateOf(request.createdAt))}`)),
    cell('Purpose', { class: 'table__wide' },
      request.purpose,
      request.notes ? h('span', { class: 'table__sub' }, `Notes: ${request.notes}`) : null),
    cell('Clashes', {}, clashes(request)),
    h('td', { role: 'cell' }, actions(request)));
}

/** Why a request cannot be approved, or which pending requests approving it would reject. */
function clashes(request) {
  const others = request.overlappingRequests;
  if (!request.facility.isBookable) {
    return [h('span', { class: 'badge badge--danger' }, 'Facility closed'),
      h('span', { class: 'table__sub' }, 'This facility is not taking bookings at the moment.')];
  }
  if (request.timeTaken) {
    return [h('span', { class: 'badge badge--danger' }, 'Time already booked'),
      h('span', { class: 'table__sub' }, 'An approved booking takes part of this time, so it cannot be approved.')];
  }
  if (others.length > 0) {
    return [h('span', { class: 'badge badge--warning' }, `Overlaps ${pluralize(others.length, 'request')}`),
      h('ul', { class: 'table__sub list-reset' }, others.map((other) => h('li', {}, `${other.studentName}, ${other.startTime}–${other.endTime}`)))];
  }
  return h('span', { class: 'table__muted' }, 'None');
}

/** "Kim Min-jun: Computer Lab A (ENG 310), Thu, 12 Nov 2026, 10:00–12:00" */
function describe(request) {
  return `${request.student.fullName}: ${request.facility.name} (${roomLabel(request.facility)}), `
    + `${dateLabel(request.date)}, ${request.startTime}–${request.endTime}`;
}

function actions(request) {
  // Every row has these buttons; the hidden part says which request they are for.
  const which = () => h('span', { class: 'visually-hidden' },
    `: ${request.student.fullName}, ${request.facility.name}, ${dateLabel(request.date)}, ${request.startTime}`);
  const approve = h('button', { type: 'button', class: 'btn btn--sm btn--primary', disabled: !request.canApprove }, 'Approve', which());
  const reject = h('button', { type: 'button', class: 'btn btn--sm' }, 'Reject', which());
  approve.addEventListener('click', () => confirmApprove(request, approve));
  reject.addEventListener('click', () => confirmReject(request, reject));
  return h('div', { class: 'table__actions' }, approve, reject);
}

async function confirmApprove(request, button) {
  const others = request.overlappingRequests;
  const note = await reasonDialog({
    title: 'Approve this request?',
    message: `${describe(request)}.`,
    details: others.length > 0
      ? [h('p', {}, others.length === 1
        ? 'Approving it also rejects this overlapping request:'
        : `Approving it also rejects these ${others.length} overlapping requests:`),
      h('ul', { class: 'dialog__list' }, others.map((other) => h('li', {}, `${other.studentName}, ${other.startTime}–${other.endTime}`)))]
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
  await decide(request, button, () => approveRequest(request.id, { note }), (result) => (result.autoRejected.length > 0
    ? `Request approved. ${pluralize(result.autoRejected.length, 'overlapping request')} rejected.`
    : 'Request approved.'));
}

async function confirmReject(request, button) {
  const reason = await reasonDialog({
    title: 'Reject this request?',
    message: `${describe(request)}. The student sees your reason on their My bookings page.`,
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
  await decide(request, button, () => rejectRequest(request.id, { reason }), () => 'Request rejected.');
}

/**
 * Sends a decision. On success the decided request, and any rejected along with it, leave
 * the list; focus moves to the request that takes its place. If someone else decided
 * first (404, 409), says so and reloads the list as it is now.
 */
async function decide(request, button, send, describeResult) {
  renderAlert(alertBox, {});
  const position = requests.indexOf(request);
  try {
    const result = await withButtonLoading(button, send());
    const gone = new Set([request.id, ...(result.autoRejected ?? [])]);
    requests = requests
      .filter((item) => !gone.has(item.id))
      .map((item) => ({ ...item, overlappingRequests: item.overlappingRequests.filter((other) => !gone.has(other.id)) }));
    render();
    focusRow(position);
    toast(describeResult(result));
  } catch (error) {
    renderAlert(alertBox, { type: 'danger', title: 'Could not save the decision', message: error.message });
    if (error.status === 404 || error.status === 409) await load();
    heading.focus();
  }
}

/** Focuses the first enabled button of the row now at `position` (or the last row), or the heading when none is left. */
function focusRow(position) {
  const rows = list.querySelectorAll('tbody tr');
  const row = rows[Math.min(position, rows.length - 1)];
  const target = row?.querySelector('button:not(:disabled)') ?? heading;
  target.focus();
}
