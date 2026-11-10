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

/**
 * action (optional): { label, href } or { label, onClick }
 * heading (optional): 'h1' when the state replaces a whole page ("Facility not found"),
 * so the page still has a main heading. Otherwise the title is a paragraph.
 */
export function renderEmpty(container, { title, message, action, heading } = {}) {
  container.replaceChildren(
    h('div', { class: 'state' },
      h(heading ?? 'p', { class: 'state__title' }, title ?? 'Nothing here yet'),
      message ? h('p', { class: 'state__message' }, message) : null,
      action ? actionButton(action, 'btn btn--secondary') : null),
  );
}

/** Shows an ApiError (or any Error) with an optional retry button. `heading` as above. */
export function renderError(container, error, { title = 'Something went wrong', onRetry, heading } = {}) {
  container.replaceChildren(
    h('div', { class: 'state state--error', role: 'alert' },
      h(heading ?? 'p', { class: 'state__title' }, title),
      h('p', { class: 'state__message' }, error?.message ?? 'Please try again.'),
      onRetry ? actionButton({ label: 'Try again', onClick: onRetry }, 'btn') : null),
  );
}

/**
 * Shows a message box inside `container` (replacing what was there), e.g. a form-level
 * error. type: 'info' | 'success' | 'warning' | 'danger'. Danger alerts are announced
 * immediately (role="alert"); the others politely (role="status").
 * action (optional): { label, href }, a link to what comes next ("View My bookings").
 * renderAlert(container, {}) (no title, no message) removes the alert.
 */
export function renderAlert(container, { type = 'info', title, message, action }) {
  if (!title && !message) {
    container.replaceChildren();
    return;
  }
  container.replaceChildren(
    h('div', { class: `alert alert--${type}`, role: type === 'danger' ? 'alert' : 'status' },
      h('div', { class: 'alert__body' },
        title ? h('p', { class: 'alert__title' }, title) : null,
        message ? h('p', {}, message) : null,
        action ? h('p', { class: 'alert__actions' }, h('a', { href: action.href }, action.label)) : null)),
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

let dialogCount = 0;

/** Resolves true when confirmed, false when cancelled. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return openDialog({ title, message, confirmLabel, cancelLabel, danger });
}

/**
 * A confirmation with a text box: an optional reason ("Cancel this booking?") or a
 * required one ("Reject this request?"). Resolves to the trimmed text ('' when an
 * optional one is left empty) when confirmed, or null when cancelled.
 *   required:  confirming with less than `minLength` characters shows an error in the
 *              dialog and keeps it open
 *   details:   extra content between the message and the text box, e.g. a list
 */
export async function reasonDialog({
  title, message, details = null, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false,
  label = 'Reason', hint, required = false, minLength = 1, maxLength = 500,
}) {
  const id = `dialog-reason-${++dialogCount}`;
  const hintId = hint ? `${id}-hint` : null;
  const errorId = `${id}-error`;
  const textarea = h('textarea', {
    class: 'textarea', id, name: 'reason', rows: 3, maxlength: maxLength, required, 'aria-describedby': hintId,
  });
  const error = h('p', { class: 'field-error', id: errorId });
  const field = h('div', { class: 'field' },
    h('label', { class: 'label', for: id },
      label,
      required ? null : [' ', h('span', { class: 'label__optional' }, '(optional)')]),
    textarea,
    hint ? h('p', { class: 'hint', id: hintId }, hint) : null,
    error);

  /** Shows what is wrong under the text box, or clears it. True when it may be confirmed. */
  function validate() {
    const length = textarea.value.trim().length;
    let problem = null;
    if (required && length === 0) problem = `${label} is required.`;
    else if (required && length < minLength) problem = `${label} must be at least ${minLength} characters.`;
    error.textContent = problem ?? '';
    if (problem) {
      textarea.setAttribute('aria-invalid', 'true');
      textarea.setAttribute('aria-describedby', [hintId, errorId].filter(Boolean).join(' '));
      textarea.focus();
    } else {
      textarea.removeAttribute('aria-invalid');
      if (hintId) textarea.setAttribute('aria-describedby', hintId);
      else textarea.removeAttribute('aria-describedby');
    }
    return problem === null;
  }

  // Focus starts in the text box: typing is the next step, and it cannot confirm by accident.
  const confirmed = await openDialog({
    title, message, confirmLabel, cancelLabel, danger, content: [details, field], focus: textarea, validate,
  });
  return confirmed ? textarea.value.trim() : null;
}

/** validate (optional): called on confirm; returning false keeps the dialog open. */
function openDialog({ title, message, confirmLabel, cancelLabel, danger, content = null, focus = null, validate = null }) {
  return new Promise((resolve) => {
    const number = ++dialogCount;
    const titleId = `dialog-title-${number}`;
    const messageId = message ? `dialog-message-${number}` : null;
    const cancelButton = h('button', { type: 'button', class: 'btn', onClick: () => dialog.close('cancel') }, cancelLabel);
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': titleId, 'aria-describedby': messageId },
      h('div', { class: 'dialog__body' },
        h('h2', { class: 'dialog__title', id: titleId }, title),
        message ? h('p', { id: messageId }, message) : null,
        content),
      h('div', { class: 'dialog__actions' },
        cancelButton,
        h('button', {
          type: 'button',
          class: danger ? 'btn btn--danger' : 'btn btn--primary',
          onClick: () => {
            if (validate && !validate()) return;
            dialog.close('confirm');
          },
        }, confirmLabel)));

    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'confirm');
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    (focus ?? cancelButton).focus(); // otherwise the safe choice gets focus first
  });
}
