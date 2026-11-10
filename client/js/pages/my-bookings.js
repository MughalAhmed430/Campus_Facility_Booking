import { cancelBooking, listMyBookings } from '../api/bookings.js';
import { initAppShell, ROUTES } from '../components/app-shell.js';
import {
  reasonDialog, renderAlert, renderEmpty, renderError, renderLoading, toast, withButtonLoading,
} from '../components/feedback.js';
import { statusBadge } from '../components/status-badge.js';
import { createTabs } from '../components/tabs.js';
import { h } from '../utils/dom.js';
import { dateLabel, pluralize, roomLabel } from '../utils/format.js';
import { BOOKING_TEXT_MAX_LENGTH } from '../utils/validation.js';

// The tabs, in order, and which bookings each one shows. Upcoming and pending lists start
// with the soonest; history starts with the latest (the API's own order).
const TABS = [
  {
    id: 'upcoming',
    label: 'Upcoming',
    soonestFirst: true,
    includes: (booking) => booking.status === 'approved', // ended ones are already completed
    empty: {
      title: 'No upcoming bookings',
      message: 'Approved bookings appear here. Requests still waiting for a decision are under Pending.',
      action: { label: 'Browse facilities', href: ROUTES.facilities },
    },
  },
  {
    id: 'pending',
    label: 'Pending',
    soonestFirst: true,
    includes: (booking) => booking.status === 'pending' && !booking.hasStarted,
    empty: {
      title: 'No pending requests',
      message: 'Requests you submit wait here until an administrator approves or rejects them.',
      action: { label: 'Browse facilities', href: ROUTES.facilities },
    },
  },
  {
    id: 'past',
    label: 'Past',
    soonestFirst: false,
    // A request nobody reviewed before its start time is no longer waiting for anything.
    includes: (booking) => booking.status === 'completed' || (booking.status === 'pending' && booking.hasStarted),
    empty: { title: 'No past bookings', message: 'Bookings appear here once they are over.' },
  },
  {
    id: 'closed',
    label: 'Cancelled & rejected',
    soonestFirst: false,
    includes: (booking) => booking.status === 'cancelled' || booking.status === 'rejected',
    empty: { title: 'No cancelled or rejected bookings', message: 'Bookings you cancel, and requests that are rejected, appear here.' },
  },
];

const alertBox = document.getElementById('bookings-alert');
let tabs;
let bookings = null; // null while loading, or when loading failed

const user = await initAppShell({ access: 'student' });
if (user) init();

function init() {
  tabs = createTabs({
    label: 'Bookings by status',
    tabs: TABS,
    selected: new URLSearchParams(window.location.search).get('tab'),
    onSelect: (id) => {
      rememberTab(id);
      renderPanel();
    },
  });
  document.getElementById('bookings').append(tabs.list, tabs.panel);
  load();
}

async function load() {
  bookings = null;
  updateCounts();
  tabs.panel.setAttribute('aria-busy', 'true');
  renderLoading(tabs.panel, 'Loading your bookings…');
  try {
    ({ bookings } = await listMyBookings());
  } catch (error) {
    renderError(tabs.panel, error, { title: 'Could not load your bookings', onRetry: load });
    return;
  } finally {
    tabs.panel.removeAttribute('aria-busy');
  }
  updateCounts();
  renderPanel();
}

/** Keeps the tab in the address, so a reload or a shared link opens the same tab. */
function rememberTab(id) {
  const url = new URL(window.location.href);
  if (id === TABS[0].id) url.searchParams.delete('tab');
  else url.searchParams.set('tab', id);
  window.history.replaceState(null, '', url);
}

function updateCounts() {
  for (const tab of TABS) tabs.setCount(tab.id, bookings ? bookings.filter(tab.includes).length : null);
}

function renderPanel() {
  if (!bookings) return; // still loading, or the error is showing
  const tab = TABS.find((item) => item.id === tabs.selected);
  const list = bookings.filter(tab.includes);
  if (tab.soonestFirst) list.reverse();

  if (list.length === 0) {
    renderEmpty(tabs.panel, tab.empty);
    return;
  }
  tabs.panel.replaceChildren(bookingTable(tab, list));
}

function bookingTable(tab, list) {
  return h('div', { class: 'table-wrap table-wrap--stack' },
    h('table', { class: 'table table--stack', role: 'table' },
      h('caption', { class: 'visually-hidden' }, `${tab.label}: ${pluralize(list.length, 'booking')}`),
      h('thead', { role: 'rowgroup' },
        h('tr', { role: 'row' },
          h('th', { scope: 'col', role: 'columnheader' }, 'Facility'),
          h('th', { scope: 'col', role: 'columnheader' }, 'Date and time'),
          h('th', { scope: 'col', role: 'columnheader', class: 'num' }, 'Participants'),
          h('th', { scope: 'col', role: 'columnheader' }, 'Purpose'),
          h('th', { scope: 'col', role: 'columnheader' }, 'Status'),
          h('th', { scope: 'col', role: 'columnheader' }, h('span', { class: 'visually-hidden' }, 'Actions')))),
      h('tbody', { role: 'rowgroup' }, list.map(bookingRow))));
}

/** A cell that shows its column name when the table turns into cards on a phone. */
function cell(label, attrs, ...content) {
  return h('td', { role: 'cell', ...attrs },
    label ? h('span', { class: 'table__label', 'aria-hidden': 'true' }, label) : null,
    ...content);
}

function bookingRow(booking) {
  const { facility } = booking;
  const note = statusNote(booking);
  return h('tr', { role: 'row', 'data-booking-id': booking.id },
    cell(null, {},
      h('a', { href: `/pages/facility.html?id=${encodeURIComponent(facility.id)}` }, facility.name),
      h('span', { class: 'table__sub' }, `${roomLabel(facility)} · ${facility.building.name}`)),
    cell('Date and time', { class: 'table__nowrap' },
      h('span', { class: 'table__line' }, dateLabel(booking.date)),
      h('span', { class: 'table__line' }, `${booking.startTime}–${booking.endTime}`)),
    cell('Participants', { class: 'num' }, String(booking.participantCount)),
    cell('Purpose', { class: 'table__wide' },
      booking.purpose,
      booking.notes ? h('span', { class: 'table__sub' }, `Notes: ${booking.notes}`) : null),
    cell('Status', {},
      statusBadge(booking.status),
      note ? h('span', { class: 'table__sub' }, note) : null),
    h('td', { role: 'cell' }, booking.canCancel ? cancelButton(booking) : null));
}

/** The line under the status badge: what the status means for this booking. */
function statusNote({ status, hasStarted, decision, cancellation }) {
  switch (status) {
    case 'pending':
      return hasStarted ? 'Not reviewed before the start time.' : 'Waiting for an administrator to review it.';
    case 'approved':
      if (hasStarted) return 'Happening now.';
      return decision?.note ? `Note: ${decision.note}` : null;
    case 'rejected':
      return decision?.note ? `Reason: ${decision.note}` : 'No reason was given.';
    case 'cancelled': {
      const who = cancellation.byYou ? 'Cancelled by you.' : 'Cancelled by an administrator.';
      return cancellation.reason ? `${who} Reason: ${cancellation.reason}` : who;
    }
    default:
      return null;
  }
}

function cancelButton(booking) {
  const what = booking.status === 'pending' ? 'request' : 'booking';
  const button = h('button', { type: 'button', class: 'btn btn--sm' },
    `Cancel ${what}`,
    // Every row has this button; the hidden part says which booking it is for.
    h('span', { class: 'visually-hidden' }, `: ${booking.facility.name}, ${dateLabel(booking.date)}, ${booking.startTime}`));
  button.addEventListener('click', () => confirmCancel(booking, button));
  return button;
}

async function confirmCancel(booking, button) {
  const isRequest = booking.status === 'pending';
  const reason = await reasonDialog({
    title: isRequest ? 'Cancel this request?' : 'Cancel this booking?',
    message: `${booking.facility.name} (${roomLabel(booking.facility)}), ${dateLabel(booking.date)}, `
      + `${booking.startTime}–${booking.endTime}. `
      + (isRequest ? 'The request is withdrawn and will not be reviewed.' : 'The room becomes free for others to book.')
      + ' This cannot be undone.',
    confirmLabel: isRequest ? 'Cancel request' : 'Cancel booking',
    cancelLabel: isRequest ? 'Keep request' : 'Keep booking',
    danger: true,
    hint: `Up to ${BOOKING_TEXT_MAX_LENGTH} characters.`,
    maxLength: BOOKING_TEXT_MAX_LENGTH,
  });
  if (reason === null) {
    button.focus();
    return;
  }

  renderAlert(alertBox, {});
  try {
    const { booking: updated } = await withButtonLoading(button, cancelBooking(booking.id, { reason }));
    bookings = bookings.map((item) => (item.id === updated.id ? updated : item));
    updateCounts();
    renderPanel();
    tabs.focusSelected(); // the row has moved to another tab, so focus returns to the tabs
    toast(isRequest ? 'Request cancelled' : 'Booking cancelled');
  } catch (error) {
    renderAlert(alertBox, { type: 'danger', title: 'Could not cancel', message: error.message });
    // Changed somewhere else (an administrator, another tab): show every booking as it is now.
    if (error.status === 404 || error.status === 409) {
      await load();
      tabs.focusSelected();
    }
  }
}
