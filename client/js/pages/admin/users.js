import { listUsers, setUserActive } from '../../api/users.js';
import { initAppShell, ROUTES } from '../../components/app-shell.js';
import { confirmDialog, renderAlert, renderEmpty, renderError, renderLoading, toast, withButtonLoading } from '../../components/feedback.js';
import { pagination } from '../../components/pagination.js';
import { campusDateOf } from '../../utils/campus-time.js';
import { h } from '../../utils/dom.js';
import { dateLabel, pluralize } from '../../utils/format.js';

const ROLE_LABELS = { student: 'Student', admin: 'Administrator' };
const FILTER_NAMES = ['q', 'role', 'status'];
// Typing in the search box waits this long, so one request is sent per pause.
const TYPING_DELAY_MS = 300;

const form = document.getElementById('filter-form');
const filtersBox = document.getElementById('filters');
const toggle = document.getElementById('filter-toggle');
const filterCount = document.getElementById('filter-count');
const resultCount = document.getElementById('result-count');
const resultsTitle = document.getElementById('results-title');
const alertBox = document.getElementById('users-alert');
const list = document.getElementById('users');
const pages = document.getElementById('users-pages');

let page = 1;
let typingTimer;
let activeRequest;

const user = await initAppShell({ access: 'admin' });
if (user) init();

function init() {
  const params = new URLSearchParams(window.location.search);
  for (const name of FILTER_NAMES) form.elements[name].value = params.get(name) ?? ''; // a value matching no option is ignored
  const wanted = Number(params.get('page'));
  page = Number.isSafeInteger(wanted) && wanted >= 1 && wanted <= 1_000_000 ? wanted : 1;

  // Any change to the filters starts again from the first page.
  form.addEventListener('input', (event) => {
    clearTimeout(typingTimer);
    page = 1;
    if (event.target.type === 'search') typingTimer = setTimeout(load, TYPING_DELAY_MS);
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
  load();
}

function clearFilters() {
  form.reset();
  clearTimeout(typingTimer);
  page = 1;
  load();
}

/** Loads the current page of the current filters. Resolves once it is shown (or failed). */
async function load() {
  const filters = Object.fromEntries(FILTER_NAMES.map((name) => [name, form.elements[name].value.trim()]));
  const active = Object.values(filters).filter(Boolean).length;
  filterCount.textContent = active > 0 ? `(${active} active)` : '';
  remember(filters);

  // A newer search replaces an older one that is still waiting for the server.
  activeRequest?.abort();
  const request = new AbortController();
  activeRequest = request;

  list.setAttribute('aria-busy', 'true');
  if (!list.querySelector('table')) renderLoading(list, 'Loading users…'); // otherwise the old rows stay until the new ones arrive
  try {
    const result = await listUsers({ ...filters, page }, { signal: request.signal });
    // The address named a page past the last one.
    if (result.users.length === 0 && result.total > 0 && page > result.totalPages) {
      page = result.totalPages;
      await load();
      return;
    }
    render(result, active > 0);
  } catch (error) {
    if (request.signal.aborted) return;
    resultCount.textContent = '';
    pages.replaceChildren();
    renderError(list, error, { title: 'Could not load the users', onRetry: load });
  } finally {
    if (activeRequest === request) list.removeAttribute('aria-busy');
  }
}

function render({ users, total, pageSize, totalPages }, filtered) {
  if (total === 0) {
    resultCount.textContent = 'No users match your filters';
    pages.replaceChildren();
    renderEmpty(list, { title: 'No users match these filters', message: 'Try a shorter search, or another role or account status.', action: { label: 'Clear filters', onClick: clearFilters } });
    return;
  }
  // "45 users match your filters, showing 21–40"
  const first = (page - 1) * pageSize + 1;
  const matching = filtered ? ` ${total === 1 ? 'matches' : 'match'} your filters` : '';
  const shown = totalPages > 1 ? `, showing ${first}–${first + users.length - 1}` : '';
  resultCount.textContent = `${pluralize(total, 'user')}${matching}${shown}`;

  const headers = ['Name', 'Student number', 'Role', 'Account', 'Bookings', 'Joined'];
  list.replaceChildren(h('div', { class: 'table-wrap table-wrap--stack' },
    h('table', { class: 'table table--stack', role: 'table' },
      h('caption', { class: 'visually-hidden' }, `Users: ${users.length} of ${total}, by name`),
      h('thead', { role: 'rowgroup' },
        h('tr', { role: 'row' },
          headers.map((text) => h('th', { scope: 'col', role: 'columnheader' }, text)),
          h('th', { scope: 'col', role: 'columnheader' }, h('span', { class: 'visually-hidden' }, 'Actions')))),
      h('tbody', { role: 'rowgroup' }, users.map(userRow)))));
  pages.replaceChildren(totalPages > 1 ? pagination({ page, totalPages, label: 'Pages of users', onChange: goToPage }) : '');
}

/** A cell that shows its column name when the table turns into cards on a phone. */
function cell(label, attrs, ...content) {
  return h('td', { role: 'cell', ...attrs },
    label ? h('span', { class: 'table__label', 'aria-hidden': 'true' }, label) : null,
    ...content);
}

function userRow(account) {
  return h('tr', { role: 'row', 'data-user-id': account.id },
    cell(null, {}, account.fullName, h('span', { class: 'table__sub' }, account.email)),
    cell('Student number', {}, account.studentNumber ?? h('span', { class: 'table__muted' }, 'None')),
    cell('Role', {}, ROLE_LABELS[account.role] ?? account.role),
    cell('Account', {}, h('span', { class: `badge badge--${account.isActive ? 'active' : 'inactive'}` }, account.isActive ? 'Active' : 'Deactivated')),
    cell('Bookings', {}, bookingsLeft(account) ?? h('span', { class: 'table__muted' }, 'None upcoming')),
    cell('Joined', { class: 'table__nowrap' }, dateLabel(campusDateOf(account.createdAt))),
    h('td', { role: 'cell' }, action(account)));
}

/** "2 approved, 1 pending", or null when nothing upcoming depends on the account. */
function bookingsLeft({ upcomingApprovedBookings: approved, pendingRequests: pending }) {
  const parts = [approved > 0 ? `${approved} approved` : null, pending > 0 ? `${pending} pending` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

function action(account) {
  if (account.id === user.id) return h('span', { class: 'table__muted' }, 'Your account');
  const button = h('button', { type: 'button', class: 'btn btn--sm' },
    account.isActive ? 'Deactivate' : 'Activate',
    h('span', { class: 'visually-hidden' }, `: ${account.fullName}, ${account.email}`));
  button.addEventListener('click', () => (account.isActive ? deactivate(account, button) : activate(account, button)));
  return button;
}

/** The Bookings page, showing this person's approved bookings and pending requests. */
function bookingsUrl(account) {
  return `${ROUTES.adminBookings}?${new URLSearchParams({ q: account.email, status: 'pending,approved' })}`;
}

async function deactivate(account, button) {
  const left = bookingsLeft(account);
  const confirmed = await confirmDialog({
    title: 'Deactivate this account?',
    message: `${account.fullName} (${account.email}) will be signed out everywhere and will not be able to sign in. You can activate the account again later.`,
    details: left
      ? h('p', {},
        h('strong', {}, `Upcoming bookings: ${left}. `),
        'They are not cancelled automatically: cancel or reject each one, with a reason. ',
        h('a', { href: bookingsUrl(account) }, 'View these bookings'))
      : h('p', {}, 'This account has no upcoming bookings or pending requests.'),
    confirmLabel: 'Deactivate account',
    cancelLabel: 'Go back',
    danger: true,
  });
  if (!confirmed) {
    button.focus();
    return;
  }
  const done = await change(account, false, button);
  if (!done) return;
  toast(`${account.fullName} is deactivated.`);
  if (left) {
    renderAlert(alertBox, {
      type: 'warning',
      title: `${account.fullName} still has upcoming bookings: ${left}`,
      message: 'They were left in place. Cancel or reject each one, with a reason.',
      action: { label: 'Review in Bookings', href: bookingsUrl(account) },
    });
  }
}

async function activate(account, button) {
  const confirmed = await confirmDialog({
    title: 'Activate this account?',
    message: `${account.fullName} (${account.email}) will be able to sign in again.`,
    confirmLabel: 'Activate account',
    cancelLabel: 'Go back',
  });
  if (!confirmed) {
    button.focus();
    return;
  }
  if (await change(account, true, button)) toast(`${account.fullName} is active again.`);
}

/** Saves the change and reloads the list. True when it was saved. */
async function change(account, active, button) {
  renderAlert(alertBox, {});
  try {
    await withButtonLoading(button, setUserActive(account.id, active));
  } catch (error) {
    renderAlert(alertBox, { type: 'danger', title: 'Could not change the account', message: error.message });
    if (error.status === 404) await load();
    resultsTitle.focus();
    return false;
  }
  // Reloaded from the server: with an account filter on, the person may leave the list.
  await load();
  (list.querySelector(`tr[data-user-id="${account.id}"] button`) ?? resultsTitle).focus();
  return true;
}

async function goToPage(target) {
  page = target;
  await load();
  // The button pressed may be gone or disabled now: start again at the top of the results.
  resultsTitle.focus();
  resultsTitle.scrollIntoView({ block: 'start' });
}

/** Keeps the filters and the page in the address bar (reload, back button, sharing a link). */
function remember(filters) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) if (value) params.set(name, value);
  if (page > 1) params.set('page', page);
  window.history.replaceState(null, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`);
}
