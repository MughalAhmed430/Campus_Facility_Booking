import { getDaySchedule, listRequests } from '../../api/bookings.js';
import { listFacilities } from '../../api/facilities.js';
import { getReportSummary } from '../../api/reports.js';
import { initAppShell, ROUTES } from '../../components/app-shell.js';
import { renderEmpty, renderError, renderLoading } from '../../components/feedback.js';
import { failedStatCard, NO_FIGURE, statCard, statGrid } from '../../components/stat-card.js';
import { statusBadge } from '../../components/status-badge.js';
import { addDays, campusToday, mondayOf } from '../../utils/campus-time.js';
import { h } from '../../utils/dom.js';
import { dateLabel, dateRangeLabel, longDateLabel, pluralize, roomLabel } from '../../utils/format.js';

// The administrators' start page. It has no data of its own: each figure and preview comes
// from the call behind the page it links to (Requests, Schedule, Facilities, Reports), so
// a number here cannot disagree with that page.
const REQUESTS_SHOWN = 5;
const NUMBER = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

const dashboard = document.getElementById('dashboard');
const stats = document.getElementById('dashboard-stats');
const requestsBox = document.getElementById('dashboard-requests');
const todayBox = document.getElementById('dashboard-today');

const user = await initAppShell({ access: 'admin' });
if (user) load();

/** Loads the four sources. One failing leaves the rest of the page working. */
async function load() {
  const today = campusToday();
  const week = { from: mondayOf(today), to: addDays(mondayOf(today), 6) }; // Monday to Sunday
  document.getElementById('dashboard-date').textContent = `Today is ${longDateLabel(today)}.`;

  dashboard.setAttribute('aria-busy', 'true');
  renderLoading(stats, 'Loading the figures…');
  renderLoading(requestsBox, 'Loading requests…');
  renderLoading(todayBox, 'Loading today\'s bookings…');

  const [requests, day, facilities, summary] = await Promise.allSettled([
    listRequests(),
    getDaySchedule({ date: today }),
    listFacilities({ status: 'active' }),
    getReportSummary(week),
  ]);
  const loaded = (result) => result.status === 'fulfilled';

  // Bookings that hold time today. Requests still pending are under "Requests" instead.
  const todays = loaded(day)
    ? day.value.facilities
      .flatMap((facility) => facility.bookings
        .filter((booking) => booking.status === 'approved' || booking.status === 'completed')
        .map((booking) => ({ ...booking, facility })))
      .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.facility.name.localeCompare(b.facility.name) || a.id - b.id)
    : null;

  const figures = {
    pending: { id: 'pending', label: 'Pending requests', href: ROUTES.adminRequests },
    today: { id: 'today', label: 'Bookings today', href: ROUTES.adminSchedule },
    facilities: { id: 'facilities', label: 'Active facilities', href: ROUTES.adminFacilities },
    // "Estimate" is part of the name: the figure is the simplified one the Reports page explains.
    utilization: {
      id: 'utilization',
      label: 'Utilization this week (estimate)',
      href: `${ROUTES.adminReports}?from=${week.from}&to=${week.to}`,
    },
  };
  stats.replaceChildren(statGrid([
    loaded(requests)
      ? statCard({
        ...figures.pending,
        value: String(requests.value.requests.length),
        note: requests.value.requests.length === 0 ? 'Nothing is waiting for a decision' : 'Waiting for a decision',
      })
      : failedStatCard(figures.pending),
    todays
      ? statCard({ ...figures.today, value: String(todays.length), note: `Approved, ${dateLabel(today)}` })
      : failedStatCard(figures.today),
    loaded(facilities)
      ? statCard({ ...figures.facilities, value: String(facilities.value.facilities.length), note: 'Taking booking requests' })
      : failedStatCard(figures.facilities),
    loaded(summary) ? utilizationCard(figures.utilization, summary.value) : failedStatCard(figures.utilization),
  ]));

  if (loaded(requests)) renderRequests(requests.value.requests);
  else renderError(requestsBox, requests.reason, { title: 'Could not load the requests', onRetry: load });

  if (todays) renderToday(todays);
  else renderError(todayBox, day.reason, { title: 'Could not load today\'s bookings', onRetry: load });

  dashboard.removeAttribute('aria-busy');
}

/**
 * Booked hours out of open hours, Monday to Sunday of this week, from the Reports API.
 * It counts approved bookings later in the week as well, and uses each facility's opening
 * hours and status as they are today, so the card says "estimate" twice and links to Reports.
 */
function utilizationCard(figure, { range, totals }) {
  const percent = totals.utilizationPercent;
  return statCard({
    ...figure,
    value: percent === null ? NO_FIGURE : `${NUMBER.format(percent)}%`,
    note: totals.openHours > 0
      ? `Estimate: ${NUMBER.format(totals.bookedHours)} of ${NUMBER.format(totals.openHours)} open hours booked, `
        + `${dateRangeLabel(range.from, range.to)}. See Reports for how it is calculated.`
      : 'Estimate: no facility is open this week.',
  });
}

/** A cell that shows its column name when the table turns into cards on a phone. */
function cell(label, attrs, ...content) {
  return h('td', { role: 'cell', ...attrs },
    label ? h('span', { class: 'table__label', 'aria-hidden': 'true' }, label) : null,
    ...content);
}

function previewTable({ id, caption, headers, rows }) {
  return h('div', { class: 'table-wrap table-wrap--stack' },
    h('table', { class: 'table table--stack', role: 'table', id },
      h('caption', { class: 'visually-hidden' }, caption),
      h('thead', { role: 'rowgroup' },
        h('tr', { role: 'row' }, headers.map((text) => h('th', { scope: 'col', role: 'columnheader' }, text)))),
      h('tbody', { role: 'rowgroup' }, rows)));
}

/** The pending requests that start soonest: the order of the Requests page. To look at, not to decide. */
function renderRequests(requests) {
  if (requests.length === 0) {
    renderEmpty(requestsBox, { title: 'No requests waiting', message: 'New booking requests appear here as students send them.' });
    return;
  }
  const shown = requests.slice(0, REQUESTS_SHOWN);
  requestsBox.replaceChildren(
    previewTable({
      id: 'dashboard-requests-table',
      caption: `The ${pluralize(shown.length, 'pending request')} starting soonest`,
      headers: ['Student', 'Facility', 'Date and time', 'Clashes'],
      rows: shown.map((request) => h('tr', { role: 'row', 'data-request-id': request.id },
        cell(null, {},
          request.student.fullName,
          request.student.studentNumber ? h('span', { class: 'table__sub' }, `No. ${request.student.studentNumber}`) : null),
        cell('Facility', {},
          request.facility.name,
          h('span', { class: 'table__sub' }, `${roomLabel(request.facility)} · ${request.participantCount} of ${request.facility.capacity} people`)),
        cell('Date and time', { class: 'table__nowrap' },
          h('span', { class: 'table__line' }, dateLabel(request.date)),
          h('span', { class: 'table__line' }, `${request.startTime}–${request.endTime}`)),
        cell('Clashes', {}, clash(request)))),
    }),
    h('p', { class: 'dash-more' },
      requests.length > shown.length
        ? `Showing the ${shown.length} starting soonest of ${requests.length}. Approve or reject them on the Requests page.`
        : 'Approve or reject them on the Requests page.'),
  );
}

/** The short form of the Requests page's "Clashes" column. */
function clash(request) {
  if (!request.facility.isBookable) return h('span', { class: 'badge badge--danger' }, 'Facility closed');
  if (request.timeTaken) return h('span', { class: 'badge badge--danger' }, 'Time already booked');
  if (request.overlappingRequests.length > 0) {
    return h('span', { class: 'badge badge--warning' }, `Overlaps ${pluralize(request.overlappingRequests.length, 'request')}`);
  }
  return h('span', { class: 'table__muted' }, 'None');
}

/** Today's approved bookings in every facility, by start time (ended ones show as completed). */
function renderToday(bookings) {
  if (bookings.length === 0) {
    renderEmpty(todayBox, { title: 'No bookings today', message: 'Approved bookings for today appear here.' });
    return;
  }
  todayBox.replaceChildren(previewTable({
    id: 'dashboard-today-table',
    caption: `Approved bookings today: ${pluralize(bookings.length, 'booking')}, earliest first`,
    headers: ['Time', 'Facility', 'Student', 'Purpose', 'Status'],
    rows: bookings.map((booking) => h('tr', { role: 'row', 'data-booking-id': booking.id },
      cell(null, { class: 'table__nowrap' }, `${booking.startTime}–${booking.endTime}`),
      cell('Facility', {},
        booking.facility.name,
        h('span', { class: 'table__sub' }, roomLabel(booking.facility))),
      cell('Student', {}, booking.student.fullName),
      cell('Purpose', { class: 'table__wide' }, booking.purpose),
      cell('Status', {}, statusBadge(booking.status)))),
  }));
}
