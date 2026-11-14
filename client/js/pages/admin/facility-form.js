import {
  createFacility, getFacility, getFacilityUsage, listBuildings, listEquipment, updateFacility,
} from '../../api/facilities.js';
import { initAppShell, ROUTES } from '../../components/app-shell.js';
import { clearFieldErrors, renderAlert, renderEmpty, renderError, renderLoading, showFieldErrors, withButtonLoading } from '../../components/feedback.js';
import { statusBadge, statusLabel } from '../../components/status-badge.js';
import { campusToday } from '../../utils/campus-time.js';
import { h } from '../../utils/dom.js';
import { FACILITY_TYPES, facilityTypeLabel, pluralize, roomLabel } from '../../utils/format.js';

const SITE_NAME = 'Campus Facility Booking';
const STATUSES = ['active', 'maintenance', 'inactive'];
const DESCRIPTION_MAX_LENGTH = 1000; // the same as the server

const root = document.getElementById('facility-form-page');
const idText = new URLSearchParams(window.location.search).get('id');

const user = await initAppShell({ access: 'admin' });
if (user) await load();

async function load() {
  if (idText !== null && !/^[1-9]\d{0,9}$/.test(idText)) {
    renderNotFound('This link does not point to a facility. It may be incomplete.');
    return;
  }
  renderLoading(root, 'Loading…');
  try {
    const [{ buildings }, { equipment }, existing] = await Promise.all([
      listBuildings(),
      listEquipment(),
      idText === null ? null : Promise.all([getFacility(idText), getFacilityUsage(idText)]),
    ]);
    const [facility, usage] = existing ? [existing[0].facility, existing[1].usage] : [null, null];
    renderPage({ buildings, equipment, facility, usage });
  } catch (error) {
    if (error.status === 404 || error.code === 'VALIDATION_ERROR') renderNotFound(error.message);
    else renderError(root, error, { title: 'Could not load this page', heading: 'h1', onRetry: load });
  }
}

function renderNotFound(message) {
  document.title = `Facility not found | ${SITE_NAME}`;
  renderEmpty(root, { title: 'Facility not found', message, heading: 'h1', action: { label: 'Back to facilities', href: ROUTES.adminFacilities } });
}

/** facility: the one being edited, or null for a new one. */
function renderPage({ buildings, equipment, facility, usage }) {
  const editing = facility !== null;
  const title = editing ? `Edit ${facility.name}` : 'New facility';
  document.title = `${title} | ${SITE_NAME}`;

  const alertBox = h('div', { class: 'form__alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, editing ? 'Save changes' : 'Create facility');
  const form = h('form', { class: 'form', id: 'facility-form', novalidate: true, 'aria-labelledby': 'facility-form-title' },
    alertBox,
    field('name', 'Name', h('input', { class: 'input', type: 'text', name: 'name', maxlength: 100, required: true, autocomplete: 'off' })),
    h('div', { class: 'form-row' },
      field('buildingId', 'Building', h('select', { class: 'select', name: 'buildingId', required: true },
        h('option', { value: '' }, 'Choose a building'),
        buildings.map((building) => h('option', { value: building.id }, `${building.name} (${building.code})`)))),
      field('roomNumber', 'Room number', h('input', { class: 'input', type: 'text', name: 'roomNumber', maxlength: 20, required: true, autocomplete: 'off' }),
        { hint: 'As on the door, e.g. 310. Each room number is used once in a building.' })),
    h('div', { class: 'form-row' },
      field('type', 'Type', h('select', { class: 'select', name: 'type', required: true },
        h('option', { value: '' }, 'Choose a type'),
        FACILITY_TYPES.map((type) => h('option', { value: type }, facilityTypeLabel(type))))),
      field('capacity', 'Seats', h('input', { class: 'input', type: 'number', name: 'capacity', min: 1, max: 1000, step: 1, inputmode: 'numeric', required: true }),
        { hint: 'From 1 to 1000. Requests for more people are refused.' }),
      field('floor', 'Floor', h('input', { class: 'input', type: 'number', name: 'floor', min: -5, max: 50, step: 1, inputmode: 'numeric', required: true }),
        { hint: '0 is the ground floor; −1 is the first basement.' })),
    h('fieldset', { class: 'fieldset', 'aria-describedby': 'facility-hours-hint' },
      h('legend', {}, 'Opening hours'),
      h('p', { class: 'hint', id: 'facility-hours-hint' }, 'Korea time (KST), the same on every day it is open. Bookings must fit inside them.'),
      h('div', { class: 'form-row' },
        field('opensAt', 'Opens at', h('input', { class: 'input', type: 'time', name: 'opensAt', required: true })),
        field('closesAt', 'Closes at', h('input', { class: 'input', type: 'time', name: 'closesAt', required: true }))),
      h('label', { class: 'checkbox' },
        h('input', { type: 'checkbox', name: 'openWeekends' }),
        h('span', {}, 'Open on Saturdays and Sundays'))),
    editing
      ? h('div', { class: 'field' },
        h('p', { class: 'label' }, 'Status'),
        h('p', {}, statusBadge(facility.status)),
        h('p', { class: 'hint' }, 'Close, deactivate or reopen it from the facilities list.'))
      : field('status', 'Status', h('select', { class: 'select', name: 'status' },
        STATUSES.map((status) => h('option', { value: status }, statusLabel(status)))),
      { hint: 'Only bookable facilities take booking requests.' }),
    field('description', 'Description', h('textarea', { class: 'textarea', name: 'description', rows: 3, maxlength: DESCRIPTION_MAX_LENGTH }),
      { optional: true, hint: 'What the room is like and anything a student should know before requesting it.' }),
    equipmentFieldset(equipment),
    h('div', { class: 'form-actions' },
      submit,
      h('a', { class: 'btn', href: ROUTES.adminFacilities }, 'Cancel')));

  if (editing) fill(form, facility);
  else {
    form.elements.opensAt.value = '09:00';
    form.elements.closesAt.value = '21:00';
    form.elements.openWeekends.checked = false;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    renderAlert(alertBox, {});
    try {
      const fields = read(form, editing);
      if (editing) await withButtonLoading(submit, updateFacility(facility.id, fields));
      else await withButtonLoading(submit, createFacility(fields));
      window.location.assign(`${ROUTES.adminFacilities}?saved=${editing ? 'updated' : 'created'}`);
    } catch (error) {
      const unmatched = error.details ? showFieldErrors(form, error.details) : [error.message];
      if (unmatched.length > 0) {
        renderAlert(alertBox, { type: 'danger', title: editing ? 'Could not save the changes' : 'Could not create the facility', message: unmatched.join(' ') });
        if (!error.details) submit.focus();
      }
    }
  });

  root.replaceChildren(
    h('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' },
      h('ol', { class: 'list-reset' },
        h('li', {}, h('a', { href: ROUTES.adminFacilities }, 'Manage facilities')),
        h('li', { 'aria-current': 'page' }, editing ? 'Edit' : 'New facility'))),
    h('header', { class: 'page-header' },
      h('div', {},
        h('h1', { class: 'page-header__title', id: 'facility-form-title' }, title),
        editing ? h('p', { class: 'page-header__description' }, `${roomLabel(facility)} · ${facility.building.name}`) : null)),
    editing ? usageNote(facility, usage) : null,
    h('div', { class: 'card' }, h('div', { class: 'card__body' }, form)));
}

/** A labelled field. The control's name is also the field name in the API's error details. */
function field(name, label, control, { hint, optional = false } = {}) {
  const id = `facility-${name}`;
  control.id = id;
  if (hint) control.setAttribute('aria-describedby', `${id}-hint`);
  return h('div', { class: 'field' },
    h('label', { class: 'label', for: id }, label, optional ? [' ', h('span', { class: 'label__optional' }, '(optional)')] : null),
    control,
    hint ? h('p', { class: 'hint', id: `${id}-hint` }, hint) : null);
}

/** One row per equipment type: a checkbox, and how many the room has. */
function equipmentFieldset(equipment) {
  return h('fieldset', { class: 'fieldset', id: 'facility-equipment', 'aria-describedby': 'facility-equipment-hint' },
    h('legend', {}, 'Equipment'),
    h('p', { class: 'hint', id: 'facility-equipment-hint' }, 'Tick what the room has, and how many. Students can filter facilities by equipment.'),
    h('ul', { class: 'quantity-list list-reset' }, equipment.map((item) => {
      const quantity = h('input', {
        class: 'input quantity-list__quantity', type: 'number', name: `quantity-${item.id}`, min: 1, max: 1000, step: 1,
        inputmode: 'numeric', value: 1, disabled: true, 'aria-label': `How many: ${item.name}`,
      });
      const box = h('input', { type: 'checkbox', name: 'equipment', value: item.id });
      box.addEventListener('change', () => { quantity.disabled = !box.checked; });
      return h('li', { class: 'quantity-list__item' },
        h('label', { class: 'checkbox' }, box, h('span', {}, item.name)),
        quantity);
    })));
}

function fill(form, facility) {
  const { elements } = form;
  elements.name.value = facility.name;
  elements.buildingId.value = facility.building.id;
  elements.roomNumber.value = facility.roomNumber;
  elements.type.value = facility.type;
  elements.capacity.value = facility.capacity;
  elements.floor.value = facility.floor;
  elements.opensAt.value = facility.openingHours.opensAt;
  elements.closesAt.value = facility.openingHours.closesAt;
  elements.openWeekends.checked = facility.openingHours.openWeekends;
  elements.description.value = facility.description ?? '';
  const quantities = new Map(facility.equipment.map((item) => [String(item.id), item.quantity]));
  for (const box of form.querySelectorAll('input[name="equipment"]')) {
    const quantity = elements[`quantity-${box.value}`];
    box.checked = quantities.has(box.value);
    quantity.disabled = !box.checked;
    if (box.checked) quantity.value = quantities.get(box.value);
  }
}

/** The request body. Numbers left empty are sent as nothing, so the server says "is required". */
function read(form, editing) {
  const { elements } = form;
  const number = (value) => (value.trim() === '' ? undefined : Number(value));
  const fields = {
    name: elements.name.value,
    buildingId: number(elements.buildingId.value),
    roomNumber: elements.roomNumber.value,
    type: elements.type.value,
    capacity: number(elements.capacity.value),
    floor: number(elements.floor.value),
    opensAt: elements.opensAt.value,
    closesAt: elements.closesAt.value,
    openWeekends: elements.openWeekends.checked,
    description: elements.description.value,
    equipment: [...form.querySelectorAll('input[name="equipment"]:checked')]
      .map((box) => ({ id: Number(box.value), quantity: Number(elements[`quantity-${box.value}`].value) })),
  };
  if (!editing) fields.status = elements.status.value;
  return fields;
}

/** Edits never change existing bookings: say so when there are some to think about. */
function usageNote(facility, { upcomingApprovedBookings: approved }) {
  const box = h('div', { class: 'page-alert' });
  if (approved > 0) {
    const params = new URLSearchParams({ facility: facility.id, from: campusToday(), status: 'approved' });
    renderAlert(box, {
      type: 'info',
      title: `This facility has ${pluralize(approved, 'upcoming approved booking')}`,
      message: 'Changing its opening hours or seats does not change bookings that are already approved. Check that they still fit.',
      action: { label: 'Review in Bookings', href: `${ROUTES.adminBookings}?${params}` },
    });
  }
  return box;
}
