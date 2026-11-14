import { getFacilityUsage, listFacilities, setFacilityStatus } from '../../api/facilities.js';
import { initAppShell, ROUTES } from '../../components/app-shell.js';
import { facilityUrl } from '../../components/facility-card.js';
import { confirmDialog, renderAlert, renderEmpty, renderError, renderLoading, toast, withButtonLoading } from '../../components/feedback.js';
import { statusBadge } from '../../components/status-badge.js';
import { campusToday } from '../../utils/campus-time.js';
import { h } from '../../utils/dom.js';
import { facilityTypeLabel, floorLabel, hoursLabel, openDaysLabel, pluralize, roomLabel } from '../../utils/format.js';

// The status changes offered for a facility in each status, and how each is confirmed.
const CHANGES = {
  active: ['maintenance', 'inactive'],
  maintenance: ['active', 'inactive'],
  inactive: ['active'],
};
const CHANGE_TEXT = {
  maintenance: {
    button: 'Close for maintenance',
    title: 'Close for maintenance?',
    message: (name) => `${name} will be shown as under maintenance, and students cannot request it until you reopen it.`,
    confirm: 'Close for maintenance',
    done: (name) => `${name} is closed for maintenance.`,
  },
  inactive: {
    button: 'Deactivate',
    title: 'Deactivate this facility?',
    message: (name) => `${name} will be shown as inactive, and students cannot request it. You can reactivate it later.`,
    confirm: 'Deactivate facility',
    done: (name) => `${name} is deactivated.`,
  },
  active: {
    button: (from) => (from === 'inactive' ? 'Reactivate' : 'Reopen'),
    title: 'Open this facility for bookings?',
    message: (name) => `Students will be able to request ${name} again.`,
    confirm: 'Open for bookings',
    done: (name) => `${name} is open for bookings.`,
  },
};

const list = document.getElementById('facilities');
const alertBox = document.getElementById('facilities-alert');
const countLine = document.getElementById('facilities-count');
const heading = document.getElementById('facilities-title');
let facilities = null;

const user = await initAppShell({ access: 'admin' });
if (user) {
  announceSaved();
  load();
}

/** After the form: ?saved=created or ?saved=updated says so once, then leaves the address bar. */
function announceSaved() {
  const saved = new URLSearchParams(window.location.search).get('saved');
  if (saved !== 'created' && saved !== 'updated') return;
  toast(saved === 'created' ? 'Facility created.' : 'Facility saved.');
  window.history.replaceState(null, '', window.location.pathname);
}

async function load() {
  facilities = null;
  countLine.textContent = '';
  list.setAttribute('aria-busy', 'true');
  renderLoading(list, 'Loading facilities…');
  try {
    ({ facilities } = await listFacilities());
  } catch (error) {
    renderError(list, error, { title: 'Could not load the facilities', onRetry: load });
    return;
  } finally {
    list.removeAttribute('aria-busy');
  }
  render();
}

function render() {
  const bookable = facilities.filter((facility) => facility.isBookable).length;
  countLine.textContent = `${pluralize(facilities.length, 'facility', 'facilities')}, ${bookable} taking booking requests.`;
  if (facilities.length === 0) {
    renderEmpty(list, { title: 'No facilities yet', message: 'Add the first one with "New facility".' });
    return;
  }
  const headers = ['Facility', 'Type and size', 'Opening hours', 'Status'];
  list.replaceChildren(h('div', { class: 'table-wrap table-wrap--stack' },
    h('table', { class: 'table table--stack', role: 'table' },
      h('caption', { class: 'visually-hidden' }, `Facilities: ${facilities.length}`),
      h('thead', { role: 'rowgroup' },
        h('tr', { role: 'row' },
          headers.map((text) => h('th', { scope: 'col', role: 'columnheader' }, text)),
          h('th', { scope: 'col', role: 'columnheader' }, h('span', { class: 'visually-hidden' }, 'Actions')))),
      h('tbody', { role: 'rowgroup' }, facilities.map(facilityRow)))));
}

/** A cell that shows its column name when the table turns into cards on a phone. */
function cell(label, attrs, ...content) {
  return h('td', { role: 'cell', ...attrs },
    label ? h('span', { class: 'table__label', 'aria-hidden': 'true' }, label) : null,
    ...content);
}

function facilityRow(facility) {
  return h('tr', { role: 'row', 'data-facility-id': facility.id },
    cell(null, {},
      h('a', { href: facilityUrl(facility.id) }, facility.name),
      h('span', { class: 'table__sub' }, `${roomLabel(facility)} · ${facility.building.name} · ${floorLabel(facility.floor)}`)),
    cell('Type and size', {},
      facilityTypeLabel(facility.type),
      h('span', { class: 'table__sub' }, pluralize(facility.capacity, 'seat'))),
    cell('Opening hours', { class: 'table__nowrap' },
      hoursLabel(facility.openingHours),
      h('span', { class: 'table__sub' }, openDaysLabel(facility.openingHours))),
    cell('Status', {}, statusBadge(facility.status)),
    h('td', { role: 'cell' }, actions(facility)));
}

function actions(facility) {
  // Every row has these controls; the hidden part says which facility they are for.
  const which = () => h('span', { class: 'visually-hidden' }, `: ${facility.name}, ${roomLabel(facility)}`);
  const edit = h('a', { class: 'btn btn--sm', href: `${ROUTES.adminFacilityForm}?id=${encodeURIComponent(facility.id)}` }, 'Edit', which());
  const changes = CHANGES[facility.status].map((target) => {
    const text = CHANGE_TEXT[target].button;
    const button = h('button', { type: 'button', class: 'btn btn--sm' }, typeof text === 'function' ? text(facility.status) : text, which());
    button.addEventListener('click', () => changeStatus(facility, target, button));
    return button;
  });
  return h('div', { class: 'table__actions' }, edit, changes);
}

/** The Bookings page, showing this facility's approved bookings from today on. */
function bookingsUrl(facility) {
  const params = new URLSearchParams({ facility: facility.id, from: campusToday(), status: 'approved' });
  return `${ROUTES.adminBookings}?${params}`;
}

/** What closing a facility leaves behind, for the confirmation dialog. */
function closingDetails(facility, { upcomingApprovedBookings: approved, pendingRequests: pending }) {
  if (approved === 0 && pending === 0) return h('p', {}, 'It has no upcoming bookings or pending requests.');
  return [
    approved > 0
      ? h('p', {},
        h('strong', {}, `It has ${pluralize(approved, 'upcoming approved booking')}. `),
        `${approved === 1 ? 'It is' : 'They are'} not cancelled automatically: cancel ${approved === 1 ? 'it' : 'each one'} on the Bookings page, with a reason the student will see. `,
        h('a', { href: bookingsUrl(facility) }, approved === 1 ? 'View this booking' : 'View these bookings'))
      : null,
    pending > 0
      ? h('p', {}, `${pluralize(pending, 'pending request')} for it cannot be approved while it is closed.`)
      : null,
  ];
}

async function changeStatus(facility, target, button) {
  const text = CHANGE_TEXT[target];
  const closing = target !== 'active';
  renderAlert(alertBox, {});

  let details = null;
  if (closing) {
    try {
      const { usage } = await withButtonLoading(button, getFacilityUsage(facility.id));
      details = closingDetails(facility, usage);
    } catch (error) {
      await failed(error);
      return;
    }
  }
  const confirmed = await confirmDialog({
    title: text.title,
    message: text.message(facility.name),
    details,
    confirmLabel: text.confirm,
    cancelLabel: 'Go back',
    danger: target === 'inactive',
  });
  if (!confirmed) {
    button.focus();
    return;
  }

  let result;
  try {
    result = await withButtonLoading(button, setFacilityStatus(facility.id, target));
  } catch (error) {
    await failed(error);
    return;
  }
  facilities = facilities.map((item) => (item.id === facility.id ? { ...item, ...result.facility } : item));
  render();
  toast(text.done(facility.name));
  const approved = result.usage.upcomingApprovedBookings;
  if (closing && approved > 0) {
    renderAlert(alertBox, {
      type: 'warning',
      title: `${facility.name} still has ${pluralize(approved, 'upcoming approved booking')}`,
      message: `${approved === 1 ? 'It was' : 'They were'} left in place. Cancel ${approved === 1 ? 'it' : 'each one'} with a reason, or reopen the facility before ${approved === 1 ? 'it starts' : 'they start'}.`,
      action: { label: 'Review in Bookings', href: bookingsUrl(facility) },
    });
  }
  list.querySelector(`tr[data-facility-id="${facility.id}"] a.btn`)?.focus();
}

/** Says why a change was not saved. A facility that has gone (404) means the list is out of date. */
async function failed(error) {
  renderAlert(alertBox, { type: 'danger', title: 'Could not change the status', message: error.message });
  if (error.status === 404) await load();
  heading.focus();
}
