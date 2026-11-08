import { getFacility } from '../api/facilities.js';
import { initAppShell, ROUTES } from '../components/app-shell.js';
import { quantity } from '../components/facility-card.js';
import { renderEmpty, renderError, renderLoading } from '../components/feedback.js';
import { statusBadge } from '../components/status-badge.js';
import { h } from '../utils/dom.js';
import { facilityTypeLabel, floorLabel, hoursLabel, locationLabel, openDaysLabel, roomLabel } from '../utils/format.js';
import { sessionGet, STORAGE_KEYS } from '../utils/storage.js';

const SITE_NAME = 'Campus Facility Booking';

// Shown when a facility cannot take booking requests.
const STATUS_NOTICES = {
  maintenance: {
    type: 'warning',
    title: 'Under maintenance',
    message: 'This facility is temporarily closed and cannot be booked. Choose another room, or check again later.',
  },
  inactive: {
    type: 'info',
    title: 'No longer in use',
    message: 'This facility has been retired and can no longer be booked.',
  },
};

const user = await initAppShell({ access: 'signed-in' });
if (user) await load();

async function load() {
  const root = document.getElementById('facility');
  const id = new URLSearchParams(window.location.search).get('id') ?? '';

  if (!/^[1-9]\d{0,9}$/.test(id)) {
    renderNotFound(root, 'This link does not point to a facility. It may be incomplete.');
    return;
  }

  renderLoading(root, 'Loading facility…');
  try {
    const { facility } = await getFacility(id);
    renderFacility(root, facility);
  } catch (error) {
    if (error.status === 404 || error.code === 'VALIDATION_ERROR') {
      renderNotFound(root, error.message);
      return;
    }
    renderError(root, error, { title: 'Could not load this facility', heading: 'h1', onRetry: load });
  }
}

/** The facility list, with the filters the user last used (if any). */
function backToListUrl() {
  const search = sessionGet(STORAGE_KEYS.lastFacilitySearch) ?? '';
  return search.startsWith('?') ? `${ROUTES.facilities}${search}` : ROUTES.facilities;
}

function renderNotFound(root, message) {
  document.title = `Facility not found | ${SITE_NAME}`;
  renderEmpty(root, {
    title: 'Facility not found',
    heading: 'h1',
    message,
    action: { label: 'Browse facilities', href: backToListUrl() },
  });
}

function renderFacility(root, facility) {
  document.title = `${facility.name} | ${SITE_NAME}`;
  const notice = STATUS_NOTICES[facility.status];

  root.replaceChildren(
    h('div', { class: 'stack stack--lg' },
      h('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' },
        h('ol', {},
          h('li', {}, h('a', { href: backToListUrl() }, 'Facilities')),
          h('li', { 'aria-current': 'page' }, facility.name))),

      h('header', { class: 'page-header' },
        h('div', {},
          h('span', { class: 'eyebrow' }, facilityTypeLabel(facility.type)),
          h('div', { class: 'cluster' },
            h('h1', { class: 'page-header__title' }, facility.name),
            statusBadge(facility.status)),
          h('p', { class: 'page-header__description' }, locationLabel(facility)))),

      notice
        ? h('div', { class: `alert alert--${notice.type}`, role: 'status' },
          h('div', { class: 'alert__body' },
            h('p', { class: 'alert__title' }, notice.title),
            h('p', {}, notice.message)))
        : null,

      h('div', { class: 'split' },
        h('div', { class: 'stack stack--lg' },
          aboutSection(facility),
          equipmentSection(facility)),
        h('div', { class: 'stack stack--lg' },
          factsSection(facility),
          locationSection(facility)))),
  );
}

function section(id, title, ...content) {
  return h('section', { class: 'card', 'aria-labelledby': id },
    h('div', { class: 'card__body' },
      h('h2', { class: 'card__section-title', id }, title),
      ...content));
}

function aboutSection(facility) {
  return section('about-title', 'About this facility',
    facility.description
      ? h('p', {}, facility.description)
      : h('p', { class: 'hint' }, 'No description has been added for this facility yet.'));
}

function equipmentSection(facility) {
  if (facility.equipment.length === 0) {
    return section('equipment-title', 'Equipment and amenities',
      h('p', { class: 'hint' }, 'No equipment is listed for this facility.'));
  }
  return section('equipment-title', 'Equipment and amenities',
    h('ul', { class: 'item-list' }, facility.equipment.map((item) =>
      h('li', {},
        h('span', { class: 'item-list__name' }, item.name, item.quantity > 1 ? ' ' : null, quantity(item.quantity)),
        item.description ? h('span', { class: 'item-list__description' }, item.description) : null))));
}

function detail(term, ...description) {
  return h('div', {}, h('dt', {}, term), h('dd', {}, ...description));
}

function factsSection(facility) {
  return section('facts-title', 'At a glance',
    h('dl', { class: 'details-list' },
      detail('Type', facilityTypeLabel(facility.type)),
      detail('Capacity', `${facility.capacity} ${facility.capacity === 1 ? 'person' : 'people'}`),
      detail('Opening hours',
        hoursLabel(facility.openingHours),
        h('p', { class: 'hint' },
          `${openDaysLabel(facility.openingHours)}, Korea time (KST).`,
          facility.openingHours.openWeekends ? null : ' Closed on Saturdays and Sundays.')),
      detail('Status',
        statusBadge(facility.status),
        h('p', { class: 'hint' }, facility.isBookable
          ? 'Takes booking requests.'
          : 'Does not take booking requests at the moment.'))));
}

function locationSection(facility) {
  const { building } = facility;
  return section('location-title', 'Location',
    h('dl', { class: 'details-list' },
      detail('Building', `${building.name} (${building.code})`,
        building.description ? h('p', { class: 'hint' }, building.description) : null),
      detail('Room', roomLabel(facility)),
      detail('Floor', floorLabel(facility.floor))));
}
