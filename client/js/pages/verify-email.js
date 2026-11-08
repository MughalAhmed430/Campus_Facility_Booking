// The page opened from the link in the verification email:
//   /pages/verify-email.html?token=…
// It sends the token to the API once and shows the result. Expired and invalid links
// offer a form to email a new one.
import { resendVerification, verifyEmail } from '../api/auth.js';
import { initAppShell, ROUTES } from '../components/app-shell.js';
import { clearFieldErrors, renderAlert, renderError, showFieldErrors, withButtonLoading } from '../components/feedback.js';
import { h } from '../utils/dom.js';
import { sessionSet, STORAGE_KEYS } from '../utils/storage.js';
import { isValidEmail } from '../utils/validation.js';

const SITE_NAME = 'Campus Facility Booking';
// The API issues 32 random bytes as base64url: 43 characters.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// What the page says for each failure the API reports.
const FAILURES = {
  VERIFICATION_TOKEN_EXPIRED: {
    title: 'This link has expired',
    lead: 'Confirmation links work for 24 hours. Enter your email address below to get a new one.',
    offerNewLink: true,
  },
  VERIFICATION_TOKEN_INVALID: {
    title: 'This link is not valid',
    lead: 'It may be incomplete, or a newer link may have replaced it. Use the newest email, or get a new link below.',
    offerNewLink: true,
  },
  VERIFICATION_TOKEN_USED: {
    title: 'This link has already been used',
    lead: 'If you confirmed your email address with it, you can sign in now.',
    offerNewLink: false,
  },
};

// Anyone may open this page, signed in or not: the token alone identifies the account.
await initAppShell({ access: 'public' });
const root = document.getElementById('verify');
await confirmEmail();

async function confirmEmail() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  if (!TOKEN_PATTERN.test(token)) {
    showFailure('VERIFICATION_TOKEN_INVALID',
      'This link is incomplete. Open the link in the email again, or get a new one below.');
    return;
  }

  showResult('Confirming your email address', 'One moment…', [], { focus: false });
  try {
    const { email } = await verifyEmail(token);
    showConfirmed(email);
  } catch (error) {
    if (FAILURES[error.code]) {
      showFailure(error.code);
      return;
    }
    // Network problem or server error: the link may still be fine, so offer a retry.
    document.title = `Could not confirm your email address | ${SITE_NAME}`;
    renderError(root, error, { title: 'Could not confirm your email address', heading: 'h1', onRetry: confirmEmail });
  }
}

/**
 * Replaces the card with a heading, a lead paragraph and more content. The heading gets
 * focus so screen readers announce the result, which arrives after the page has loaded.
 */
function showResult(title, lead, content, { focus = true } = {}) {
  const heading = h('h1', { class: 'auth-card__title', id: 'verify-title', tabindex: '-1' }, title);
  root.replaceChildren(
    h('div', {}, heading, h('p', { class: 'auth-card__lead', id: 'verify-lead' }, lead)),
    ...content,
  );
  if (focus) heading.focus();
}

function showConfirmed(email) {
  document.title = `Email address confirmed | ${SITE_NAME}`;
  sessionSet(STORAGE_KEYS.signInEmail, email); // the sign-in page fills it in
  showResult('Email address confirmed', 'Your account is ready to use.', [
    h('p', {}, 'Sign in to browse campus facilities and request bookings.'),
    h('a', { class: 'btn btn--primary btn--block', href: `${ROUTES.login}?verified=1` }, 'Sign in'),
  ]);
}

/** lead: replaces the usual explanation (used when the link is visibly incomplete). */
function showFailure(code, lead) {
  const { title, offerNewLink } = FAILURES[code];
  document.title = `${title} | ${SITE_NAME}`;
  showResult(title, lead ?? FAILURES[code].lead, offerNewLink
    ? [...newLinkForm(), h('p', { class: 'auth-card__switch' }, 'Already confirmed? ', h('a', { href: ROUTES.login }, 'Sign in'))]
    : [h('a', { class: 'btn btn--primary btn--block', href: ROUTES.login }, 'Sign in')]);
}

/** "Get a new link": asks the API to email a fresh verification link. */
function newLinkForm() {
  const alertBox = h('div', { id: 'resend-alert' });
  const submit = h('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Send a new link');
  const form = h('form', {
    class: 'form',
    id: 'resend-form',
    novalidate: true,
    'aria-labelledby': 'resend-title',
    onSubmit: async (event) => {
      event.preventDefault();
      renderAlert(alertBox, {});
      const email = form.elements.email.value.trim();
      const problem = !email ? 'Email is required.' : !isValidEmail(email) ? 'Enter a valid email address.' : null;
      if (problem) {
        showFieldErrors(form, { email: problem });
        return;
      }
      clearFieldErrors(form);
      try {
        const { message } = await withButtonLoading(submit, resendVerification(email));
        renderAlert(alertBox, { type: 'success', title: 'Check your email', message });
      } catch (error) {
        const unmatched = error.details ? showFieldErrors(form, error.details) : [];
        if (!error.details || unmatched.length > 0) {
          renderAlert(alertBox, { type: 'danger', title: 'Could not send a new link', message: error.message });
        }
      }
    },
  },
  h('div', { class: 'field' },
    h('label', { class: 'label', for: 'resend-email' }, 'Email'),
    h('input', {
      class: 'input', type: 'email', id: 'resend-email', name: 'email', autocomplete: 'email',
      inputmode: 'email', maxlength: '254', required: true, 'aria-describedby': 'resend-email-hint',
    }),
    h('p', { class: 'hint', id: 'resend-email-hint' }, 'The address you registered with. The new link works for 24 hours.')),
  submit);

  return [h('h2', { class: 'card__section-title', id: 'resend-title' }, 'Get a new link'), alertBox, form];
}
