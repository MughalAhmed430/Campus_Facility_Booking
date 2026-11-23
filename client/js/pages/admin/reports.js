import { getReportSummary } from '../../api/reports.js';
import { initAppShell } from '../../components/app-shell.js';
import { clearFieldErrors, renderAlert, renderError, renderLoading, showFieldErrors } from '../../components/feedback.js';
import { statusBadge, statusLabel } from '../../components/status-badge.js';
import { isDateText } from '../../utils/campus-time.js';
import { barChart } from '../../components/bar-chart.js';
import { h } from '../../utils/dom.js';
import { dateRangeLabel, facilityTypeLabel, pluralize } from '../../utils/format.js';

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'completed'];
const NUMBER = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const NOT_AVAILABLE = '–';

const form = document.getElementById('range-form');
const reportTitle = document.getElementById('report-title');
const rangeText = document.getElementById('report-range');
const report = document.getElementById('report');

let activeRequest;

const user = await initAppShell({ access: 'admin' });
if (user) init();

function init() {
  // ?from=&to= keep a chosen range across a reload. Anything that is not a date is ignored.
  const params = new URLSearchParams(window.location.search);
  for (const name of ['from', 'to']) form.elements[name].value = isDateText(params.get(name)) ? params.get(name) : '';

  form.addEventListener('change', () => load());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    load();
  });
  document.getElementById('range-reset').addEventListener('click', () => {
    form.reset();
    load();
  });
  load();
}

/** Loads the figures for the dates in the form. An empty date is left to the server (the last 30 days). */
async function load() {
  const chosen = { from: form.elements.from.value, to: form.elements.to.value };
  clearFieldErrors(form);
  // The same rule as the server, checked first.
  if (chosen.from && chosen.to && chosen.to < chosen.from) {
    showFieldErrors(form, { to: 'Must be on or after the "From" date.' });
    return;
  }
  remember(chosen);

  // A newer range replaces an older one that is still waiting for the server.
  activeRequest?.abort();
  const request = new AbortController();
  activeRequest = request;

  report.setAttribute('aria-busy', 'true');
  if (!report.querySelector('table')) renderLoading(report, 'Loading the figures…'); // otherwise the old figures stay until the new ones arrive
  try {
    const summary = await getReportSummary({ from: chosen.from || undefined, to: chosen.to || undefined }, { signal: request.signal });
    // Show the dates the figures are for, including the ones the server filled in.
    form.elements.from.value = summary.range.from;
    form.elements.to.value = summary.range.to;
    render(summary);
  } catch (error) {
    if (request.signal.aborted) return;
    rangeText.textContent = '';
    const unmatched = error.details ? showFieldErrors(form, error.details) : [];
    if (error.details && unmatched.length === 0) {
      report.replaceChildren(); // the messages are next to the dates
    } else {
      renderError(report, error, { title: 'Could not load the figures', onRetry: load });
      reportTitle.focus();
    }
  } finally {
    if (activeRequest === request) report.removeAttribute('aria-busy');
  }
}

function render({ range, totals, byStatus, facilities }) {
  rangeText.textContent = `${dateRangeLabel(range.from, range.to)} (${pluralize(range.days, 'day')})`;
  let nothing = null;
  if (totals.requests === 0) {
    nothing = h('div', { class: 'page-alert' });
    renderAlert(nothing, { title: 'No booking requests are dated in this range', message: 'Choose other dates to see figures.' });
  }
  report.replaceChildren(
    ...(nothing ? [nothing] : []),
    h('div', { class: 'grid grid--stats', id: 'report-figures' },
      stat('Booking requests', NUMBER.format(totals.requests), 'For dates in this range'),
      stat('Approval rate', percentText(totals.approvalRatePercent),
        totals.decided > 0 ? `${totals.approved} of ${pluralize(totals.decided, 'decided request')} approved` : 'No request was decided'),
      stat('Hours booked', NUMBER.format(totals.bookedHours), 'Approved and completed bookings'),
      stat('Utilization', percentText(totals.utilizationPercent),
        totals.openHours > 0 ? `Of ${NUMBER.format(totals.openHours)} open hours (estimate, see below)` : 'No facility was open')),
    statusTable(byStatus, totals.requests),
    facilityTable(facilities),
  );
}

function stat(label, value, note) {
  return h('div', { class: 'card stat' },
    h('p', { class: 'stat__label' }, label),
    h('p', { class: 'stat__value' }, value),
    h('p', { class: 'stat__note' }, note));
}

/** 12.5 -> "12.5%"; null (nothing to divide by) -> "–" */
function percentText(value) {
  return value === null ? NOT_AVAILABLE : `${NUMBER.format(value)}%`;
}

function statusTable(byStatus, total) {
  return h('section', { class: 'report-section', 'aria-labelledby': 'status-title' },
    h('h3', { class: 'section-title', id: 'status-title' }, 'Bookings by status'),
    barChart({
      label: 'Bookings by status',
      bars: STATUSES.map((status) => ({ label: statusLabel(status), value: byStatus[status], display: NUMBER.format(byStatus[status]), tone: status })),
    }),
    h('div', { class: 'table-wrap report-table--narrow' },
      h('table', { class: 'table', id: 'report-status' },
        h('caption', { class: 'visually-hidden' }, 'Booking requests in the range, by status'),
        h('thead', {},
          h('tr', {},
            h('th', { scope: 'col' }, 'Status'),
            h('th', { scope: 'col', class: 'num' }, 'Bookings'))),
        h('tbody', {}, STATUSES.map((status) => h('tr', { 'data-status': status },
          h('th', { scope: 'row' }, statusBadge(status)),
          h('td', { class: 'num' }, NUMBER.format(byStatus[status]))))),
        h('tfoot', {},
          h('tr', {},
            h('th', { scope: 'row' }, 'All requests'),
            h('td', { class: 'num' }, NUMBER.format(total)))))));
}

/** A cell that shows its column name when the table turns into cards on a phone. */
function cell(label, attrs, ...content) {
  return h('td', { role: 'cell', ...attrs },
    label ? h('span', { class: 'table__label', 'aria-hidden': 'true' }, label) : null,
    ...content);
}

function facilityTable(facilities) {
  const headers = [['Facility', null], ['Bookings', 'num'], ['Hours booked', 'num'], ['Open hours', 'num'], ['Utilization', null]];
  return h('section', { class: 'report-section', 'aria-labelledby': 'facilities-title' },
    h('h3', { class: 'section-title', id: 'facilities-title' }, 'Facilities by hours booked'),
    h('div', { class: 'table-wrap table-wrap--stack' },
      h('table', { class: 'table table--stack', role: 'table', id: 'report-facilities' },
        h('caption', { class: 'visually-hidden' }, 'Approved and completed bookings per facility, busiest first'),
        h('thead', { role: 'rowgroup' },
          h('tr', { role: 'row' }, headers.map(([text, className]) => h('th', { scope: 'col', role: 'columnheader', class: className }, text)))),
        h('tbody', { role: 'rowgroup' }, facilities.map(facilityRow)))));
}

function facilityRow(facility) {
  const counted = facility.openHours !== null; // an inactive facility has no open hours

  return h('tr', { role: 'row', 'data-facility-id': facility.id },
    cell(null, {},
      facility.name,
      h('span', { class: 'table__sub' }, `${facility.building.code} ${facility.roomNumber} · ${facilityTypeLabel(facility.type)}`),
      facility.status === 'active' ? null : h('span', { class: 'table__sub' }, statusBadge(facility.status))),
    cell('Bookings', { class: 'num' }, NUMBER.format(facility.bookings)),
    cell('Hours booked', { class: 'num' }, NUMBER.format(facility.bookedHours)),
    cell('Open hours', { class: 'num' }, counted ? NUMBER.format(facility.openHours) : NOT_AVAILABLE),
    cell('Utilization', {}, counted ? utilization(facility.utilizationPercent) : h('span', { class: 'table__muted' }, 'Not counted (inactive)')));
}

/** "12.5%" with a bar. The number is always written; the bar only supports it. */
function utilization(value) {
  if (value === null) return h('span', { class: 'table__muted' }, 'Not open in this range');
  const fill = h('span', { class: 'meter__fill' });
  fill.style.setProperty('--meter-value', `${Math.min(100, value)}%`); // set from script: the CSP blocks style attributes
  return h('span', { class: 'meter' },
    h('span', { class: 'meter__track', 'aria-hidden': 'true' }, fill),
    h('span', { class: 'meter__value' }, `${NUMBER.format(value)}%`));
}

/** Keeps a chosen range in the address bar (reload, back button, sharing a link). */
function remember(chosen) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(chosen)) if (value) params.set(name, value);
  window.history.replaceState(null, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`);
}
