import { listBuildings, listEquipment, listFacilities } from '../api/facilities.js';
import { initAppShell } from '../components/app-shell.js';
import { facilityCard } from '../components/facility-card.js';
import { clearFieldErrors, renderEmpty, renderError, renderLoading, showFieldErrors } from '../components/feedback.js';
import { h } from '../utils/dom.js';
import { campusTimeNow, campusToday } from '../utils/campus-time.js';
import { dateLabel, FACILITY_TYPES, facilityTypeLabel, pluralize } from '../utils/format.js';
import { sessionSet, STORAGE_KEYS } from '../utils/storage.js';

// Typing in a text, number, date or time box waits this long before searching, so one
// request is sent per pause rather than per key press.
const TYPING_DELAY_MS = 300;
const TYPED_INPUTS = new Set(['search', 'number', 'date', 'time']);
const FILTER_NAMES = ['q', 'type', 'building', 'minCapacity', 'equipment', 'status', 'date', 'startTime', 'endTime'];
// "Free at" is one filter made of three fields; it applies once all three are filled in.
const FREE_AT_NAMES = ['date', 'startTime', 'endTime'];

const user = await initAppShell({ access: 'signed-in' });
if (user) await init();

async function init() {
  const form = document.getElementById('filter-form');
  const filtersBox = document.getElementById('filters');
  const toggle = document.getElementById('filter-toggle');
  const filterCount = document.getElementById('filter-count');
  const results = document.getElementById('results');
  const resultCount = document.getElementById('result-count');

  let typingTimer;
  let activeRequest;

  // ---- Filter options --------------------------------------------------------------
  renderLoading(results, 'Loading facilities…');
  let buildings;
  let equipment;
  try {
    [{ buildings }, { equipment }] = await Promise.all([listBuildings(), listEquipment()]);
  } catch (error) {
    renderError(results, error, { title: 'Could not load facilities', onRetry: () => window.location.reload() });
    return;
  }

  form.elements.type.append(...FACILITY_TYPES.map((type) => h('option', { value: type }, facilityTypeLabel(type))));
  form.elements.building.append(...buildings.map((b) => h('option', { value: b.id }, `${b.name} (${b.code})`)));
  document.getElementById('filter-equipment-options').append(...equipment.map((item) =>
    h('label', { class: 'checkbox' },
      h('input', { type: 'checkbox', name: 'equipment', value: item.id, 'aria-describedby': 'filter-equipment-hint' }),
      h('span', {}, item.name))));

  form.elements.date.min = campusToday();
  applyToForm(new URLSearchParams(window.location.search));

  // ---- Events --------------------------------------------------------------------------
  form.addEventListener('input', (event) => {
    clearTimeout(typingTimer);
    const typing = TYPED_INPUTS.has(event.target.type);
    if (typing) typingTimer = setTimeout(load, TYPING_DELAY_MS);
    else load();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault(); // Enter in the search box searches at once
    clearTimeout(typingTimer);
    load();
  });

  const clearFilters = () => {
    form.reset();
    clearTimeout(typingTimer);
    load();
  };
  document.getElementById('filter-clear').addEventListener('click', clearFilters);

  toggle.addEventListener('click', () => {
    const open = !filtersBox.classList.contains('is-open');
    filtersBox.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });

  await load();

  // ---- Loading results --------------------------------------------------------------
  async function load() {
    const filters = readForm();
    clearFieldErrors(form);
    const problems = validate(filters);
    if (problems) {
      showFieldErrors(form, problems);
      return;
    }

    rememberSearch(filters);
    showActiveFilterCount(filters);

    // A newer search replaces an older one that is still waiting for the server.
    activeRequest?.abort();
    const request = new AbortController();
    activeRequest = request;

    renderSkeleton();
    try {
      const { facilities, total } = await listFacilities(applied(filters), { signal: request.signal });
      renderResults(facilities, total, filters);
    } catch (error) {
      if (request.signal.aborted) return;
      resultCount.textContent = '';
      results.removeAttribute('aria-busy');
      const unmatched = error.details ? showFieldErrors(form, error.details) : [];
      if (error.details && unmatched.length === 0) {
        results.replaceChildren(); // the messages are shown next to the filters
        return;
      }
      renderError(results, error, { title: 'Could not load facilities', onRetry: load });
    }
  }

  function renderResults(facilities, total, filters) {
    results.removeAttribute('aria-busy');
    const filtered = countActive(filters) > 0;
    const free = freeAt(filters);
    if (total === 0) {
      resultCount.textContent = filtered ? 'No facilities match your filters' : 'No facilities yet';
      renderEmpty(results, filtered
        ? {
          title: free ? 'No facilities are free then' : 'No facilities match these filters',
          message: free
            ? 'Try another time or day, a lower number of seats or fewer equipment items.'
            : 'Try a lower number of seats, fewer equipment items or a different building.',
          action: { label: 'Clear filters', onClick: clearFilters },
        }
        : { title: 'No facilities have been added yet', message: 'Please check back later.' });
      return;
    }
    resultCount.textContent = countText(total, filters);
    // With a time chosen, each card opens the facility with that time in its booking form.
    const linkQuery = free ? new URLSearchParams(free).toString() : '';
    results.replaceChildren(
      h('ul', { class: 'grid grid--cards list-reset' }, facilities.map((facility) => h('li', {}, facilityCard(facility, { linkQuery })))),
    );
  }

  /** "3 facilities match your filters", or with a time: "3 facilities are free on Thu, 12 Nov 2026, 10:00–12:00" */
  function countText(total, filters) {
    const count = pluralize(total, 'facility', 'facilities');
    const verb = (one, many) => (total === 1 ? one : many);
    const free = freeAt(filters);
    if (!free) return countActive(filters) > 0 ? `${count} ${verb('matches', 'match')} your filters` : count;
    const when = `free on ${dateLabel(free.date)}, ${free.startTime}–${free.endTime}`;
    return countActive(filters) > 1
      ? `${count} ${verb('matches', 'match')} your filters and ${verb('is', 'are')} ${when}`
      : `${count} ${verb('is', 'are')} ${when}`;
  }

  function renderSkeleton() {
    results.setAttribute('aria-busy', 'true');
    // On the first load there is no previous count yet: say what is happening.
    if (!resultCount.textContent) resultCount.textContent = 'Loading facilities…';
    const placeholder = () => h('div', { class: 'card card__body stack stack--sm' },
      h('span', { class: 'skeleton skeleton--title' }),
      h('span', { class: 'skeleton skeleton--text' }),
      h('span', { class: 'skeleton skeleton--short' }));
    results.replaceChildren(h('div', { class: 'grid grid--cards', 'aria-hidden': 'true' },
      Array.from({ length: 6 }, placeholder)));
  }

  // ---- Form <-> filters <-> URL ---------------------------------------------------------
  function readForm() {
    const data = new FormData(form);
    const text = (name) => String(data.get(name) ?? '').trim();
    return {
      q: text('q'),
      type: text('type'),
      building: text('building'),
      minCapacity: text('minCapacity'),
      equipment: data.getAll('equipment').map(String),
      status: text('status'),
      date: text('date'),
      startTime: text('startTime'),
      endTime: text('endTime'),
    };
  }

  /** The "Free at" time when all three fields are filled in, otherwise null. */
  function freeAt(filters) {
    return FREE_AT_NAMES.every((name) => filters[name])
      ? { date: filters.date, startTime: filters.startTime, endTime: filters.endTime }
      : null;
  }

  /** The filters sent to the server and kept in the address bar: "Free at" only once it is complete. */
  function applied(filters) {
    if (freeAt(filters)) return filters;
    const rest = { ...filters };
    for (const name of FREE_AT_NAMES) delete rest[name];
    return rest;
  }

  /** The same rules as the server, checked first. Returns { field: message }, or null. */
  function validate(filters) {
    const problems = {};
    const seats = filters.minCapacity;
    // Text such as "e" in a number box reads as an empty value, so ask the browser too.
    const unreadable = form.elements.minCapacity.validity.badInput;
    if (unreadable || (seats && !(/^\d+$/.test(seats) && Number(seats) >= 1 && Number(seats) <= 1000))) {
      problems.minCapacity = 'Enter a whole number from 1 to 1000.';
    }
    const free = freeAt(filters);
    if (free) {
      const today = campusToday();
      if (free.date < today) problems.date = 'Choose today or a later date.';
      else if (free.date === today && free.startTime < campusTimeNow()) problems.startTime = 'This start time has already passed. Choose a later time.';
      if (free.endTime <= free.startTime) problems.endTime = 'End time must be after the start time.';
    }
    return Object.keys(problems).length > 0 ? problems : null;
  }

  /** Fills the form from ?q=&type=… Values that match no option are ignored. */
  function applyToForm(params) {
    form.elements.q.value = params.get('q') ?? '';
    form.elements.type.value = params.get('type') ?? '';
    form.elements.building.value = params.get('building') ?? '';
    form.elements.minCapacity.value = params.get('minCapacity') ?? '';
    const selected = new Set((params.get('equipment') ?? '').split(','));
    for (const box of form.querySelectorAll('input[name="equipment"]')) box.checked = selected.has(box.value);
    form.elements.status.checked = params.get('status') === 'active';
    for (const name of FREE_AT_NAMES) form.elements[name].value = params.get(name) ?? '';
  }

  /** Keeps the filters in the address bar (reload, back button, sharing a link). */
  function rememberSearch(filters) {
    const params = new URLSearchParams();
    const kept = applied(filters);
    for (const name of FILTER_NAMES) {
      const value = Array.isArray(kept[name]) ? kept[name].join(',') : kept[name];
      if (value) params.set(name, value);
    }
    const query = params.toString() ? `?${params}` : '';
    window.history.replaceState(null, '', `${window.location.pathname}${query}`);
    sessionSet(STORAGE_KEYS.lastFacilitySearch, query);
  }

  function countActive(filters) {
    const others = FILTER_NAMES.filter((name) => !FREE_AT_NAMES.includes(name));
    const active = others.filter((name) => (Array.isArray(filters[name]) ? filters[name].length > 0 : Boolean(filters[name]))).length;
    return active + (freeAt(filters) ? 1 : 0);
  }

  function showActiveFilterCount(filters) {
    const active = countActive(filters);
    filterCount.textContent = active > 0 ? `(${active} active)` : '';
  }
}
