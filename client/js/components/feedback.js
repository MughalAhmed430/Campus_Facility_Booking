import { h } from '../utils/dom.js';

/* ---------------------------------------------------------------------------
   Page states: loading, empty, error. Each replaces the container's content.
   --------------------------------------------------------------------------- */

export function renderLoading(container, label = 'Loading…') {
  container.replaceChildren(
    h('div', { class: 'state', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      h('p', { class: 'state__message' }, label)),
  );
}

/** action (optional): { label, href } or { label, onClick } */
export function renderEmpty(container, { title, message, action } = {}) {
  container.replaceChildren(
    h('div', { class: 'state' },
      h('p', { class: 'state__title' }, title ?? 'Nothing here yet'),
      message ? h('p', { class: 'state__message' }, message) : null,
      action ? actionButton(action, 'btn btn--secondary') : null),
  );
}

/** Shows an ApiError (or any Error) with an optional retry button. */
export function renderError(container, error, { title = 'Something went wrong', onRetry } = {}) {
  container.replaceChildren(
    h('div', { class: 'state state--error', role: 'alert' },
      h('p', { class: 'state__title' }, title),
      h('p', { class: 'state__message' }, error?.message ?? 'Please try again.'),
      onRetry ? actionButton({ label: 'Try again', onClick: onRetry }, 'btn') : null),
  );
}

function actionButton({ label, href, onClick }, className) {
  return href
    ? h('a', { class: className, href }, label)
    : h('button', { type: 'button', class: className, onClick }, label);
}

/* ---------------------------------------------------------------------------
   Form validation errors from the API: error.details = { fieldName: message }.
   Each input needs a name attribute and sits inside a .field element.
   --------------------------------------------------------------------------- */

/**
 * Marks the named fields invalid and shows their messages. Returns the messages
 * that matched no field, so the caller can show them in a form-level alert.
 */
export function showFieldErrors(form, details = {}) {
  clearFieldErrors(form);
  const unmatched = [];
  let first = null;

  for (const [name, message] of Object.entries(details)) {
    const input = form.elements.namedItem(name);
    const field = input?.closest?.('.field');
    if (!input || !field) {
      unmatched.push(message);
      continue;
    }
    const errorId = `${form.id || 'form'}-${name}-error`;
    let errorEl = field.querySelector('.field-error');
    if (!errorEl) {
      errorEl = h('p', { class: 'field-error' });
      field.append(errorEl);
    }
    errorEl.id = errorId;
    errorEl.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    const describedBy = new Set((input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean));
    describedBy.add(errorId);
    input.setAttribute('aria-describedby', [...describedBy].join(' '));
    first ??= input;
  }

  first?.focus();
  return unmatched;
}

export function clearFieldErrors(form) {
  for (const input of form.querySelectorAll('[aria-invalid="true"]')) {
    const errorId = input.closest('.field')?.querySelector('.field-error')?.id;
    input.removeAttribute('aria-invalid');
    if (errorId) {
      const rest = (input.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id && id !== errorId);
      if (rest.length) input.setAttribute('aria-describedby', rest.join(' '));
      else input.removeAttribute('aria-describedby');
    }
  }
  for (const errorEl of form.querySelectorAll('.field-error')) errorEl.textContent = '';
}

/** Puts a button into its loading state (spinner, disabled) until `promise` settles. */
export async function withButtonLoading(button, promise) {
  button.classList.add('is-loading');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    return await promise;
  } finally {
    button.classList.remove('is-loading');
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

/* ---------------------------------------------------------------------------
   Toasts: short confirmations ("Booking request sent"). Announced politely.
   --------------------------------------------------------------------------- */

let toastRegion = null;

export function toast(message, { type = 'success', durationMs = 4000 } = {}) {
  if (!toastRegion) {
    toastRegion = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRegion);
  }
  const item = h('div', { class: `toast toast--${type}` }, message);
  toastRegion.append(item);
  setTimeout(() => item.remove(), durationMs);
}

/* ---------------------------------------------------------------------------
   Confirmation dialog for consequential actions (cancel, reject, deactivate).
   Uses native <dialog>: focus is trapped, Escape cancels.
   --------------------------------------------------------------------------- */

/** Resolves true when confirmed, false when cancelled. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const titleId = `dialog-title-${Date.now()}`;
    const cancelButton = h('button', { type: 'button', class: 'btn', onClick: () => dialog.close('cancel') }, cancelLabel);
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': titleId },
      h('div', { class: 'dialog__body' },
        h('h2', { class: 'dialog__title', id: titleId }, title),
        message ? h('p', {}, message) : null),
      h('div', { class: 'dialog__actions' },
        cancelButton,
        h('button', { type: 'button', class: danger ? 'btn btn--danger' : 'btn btn--primary', onClick: () => dialog.close('confirm') }, confirmLabel)));

    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'confirm');
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    cancelButton.focus(); // the safe choice gets focus first
  });
}
