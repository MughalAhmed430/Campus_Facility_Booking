import { api, ApiError } from '../api/client.js';
import { initAppShell } from '../components/app-shell.js';
import {
  clearFieldErrors, confirmDialog, renderEmpty, renderError, renderLoading,
  showFieldErrors, toast, withButtonLoading,
} from '../components/feedback.js';
import { statusBadge } from '../components/status-badge.js';
import { h } from '../utils/dom.js';

const user = await initAppShell({ access: 'public' });

/* ---- Live API checks through the real client --------------------------------- */
const checks = [
  {
    title: 'GET /api/health',
    expect: 'Success: returns data',
    run: () => api.get('/health'),
  },
  {
    title: 'GET /api/auth/me',
    expect: user ? 'Signed in: returns your user' : 'Signed out: 401 becomes an ApiError',
    run: () => api.get('/auth/me'),
  },
  {
    title: 'GET /api/does-not-exist',
    expect: 'Error: 404 becomes an ApiError',
    run: () => api.get('/does-not-exist'),
  },
];

const checkGrid = document.getElementById('api-checks');
for (const check of checks) {
  const result = h('div', { class: 'sg-api-result' });
  checkGrid.append(h('div', { class: 'card card__body', 'data-check': check.title },
    h('h3', { class: 'card__title' }, h('code', {}, check.title)),
    h('p', { class: 'card__meta' }, check.expect),
    result));
  renderLoading(result, 'Calling the API…');
  check.run().then(
    (data) => result.replaceChildren(
      h('span', { class: 'badge badge--approved' }, 'Resolved'),
      h('pre', {}, JSON.stringify(data, null, 2))),
    (error) => result.replaceChildren(
      h('span', { class: 'badge badge--rejected' }, error instanceof ApiError ? 'ApiError' : error.name),
      h('pre', {}, JSON.stringify({ status: error.status, code: error.code, message: error.message }, null, 2))),
  );
}

/* ---- Badges -------------------------------------------------------------------- */
document.getElementById('booking-badges')
  .append(...['pending', 'approved', 'rejected', 'cancelled', 'completed'].map(statusBadge));
document.getElementById('facility-badges')
  .append(...['active', 'maintenance', 'inactive'].map(statusBadge));

/* ---- Buttons ------------------------------------------------------------------- */
const loadingButton = document.getElementById('demo-loading-button');
loadingButton.addEventListener('click', () => {
  withButtonLoading(loadingButton, new Promise((resolve) => setTimeout(resolve, 1500)));
});

/* ---- Form errors (example of the API's VALIDATION_ERROR format) ----------------- */
const form = document.getElementById('demo-form');
const exampleError = new ApiError({
  status: 400,
  code: 'VALIDATION_ERROR',
  message: 'Some fields are missing or invalid.',
  details: {
    facilityId: 'Choose a facility.',
    endTime: 'End time must be after the start time.',
    attendees: 'Attendees cannot exceed the room capacity (30).',
  },
});
document.getElementById('demo-show-errors').addEventListener('click', () => showFieldErrors(form, exampleError.details));
document.getElementById('demo-clear-errors').addEventListener('click', () => clearFieldErrors(form));

/* ---- States ---------------------------------------------------------------------- */
renderLoading(document.getElementById('demo-loading'), 'Loading facilities…');
renderEmpty(document.getElementById('demo-empty'), {
  title: 'No facilities match these filters',
  message: 'Try a different date or remove the equipment filter.',
  action: { label: 'Clear filters', onClick: () => toast('Filters cleared (demo)') },
});
renderError(document.getElementById('demo-error'), new ApiError({
  status: 0, code: 'NETWORK_ERROR', message: 'Cannot reach the server. Check your connection and try again.',
}), { title: 'Could not load bookings', onRetry: () => toast('Retrying (demo)') });

/* ---- Dialog and toast --------------------------------------------------------------- */
document.getElementById('demo-confirm').addEventListener('click', async () => {
  const confirmed = await confirmDialog({
    title: 'Reject this request?',
    message: 'The student will be notified with your reason. This cannot be undone.',
    confirmLabel: 'Reject request',
    danger: true,
  });
  toast(confirmed ? 'Request rejected (demo, nothing was changed)' : 'Kept the request', { type: confirmed ? 'success' : 'error' });
});

for (const button of document.querySelectorAll('[data-demo-cancel]')) {
  button.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'Cancel this booking?',
      message: 'The room will become available to others.',
      confirmLabel: 'Cancel booking',
      cancelLabel: 'Keep booking',
      danger: true,
    });
    if (confirmed) toast('Booking cancelled (demo, nothing was changed)');
  });
}

document.getElementById('demo-toast').addEventListener('click', () => toast('Booking request sent'));
