import { login, resendVerification } from '../api/auth.js';
import { homeFor, initAppShell, ROUTES, safeNextPath } from '../components/app-shell.js';
import { clearFieldErrors, renderAlert, showFieldErrors, withButtonLoading } from '../components/feedback.js';
import { sessionTake, STORAGE_KEYS } from '../utils/storage.js';
import { isValidEmail } from '../utils/validation.js';

const params = new URLSearchParams(window.location.search);
// Where to go after signing in: the page that sent the user here (only if it is on
// this site), otherwise their start page.
const next = safeNextPath(params.get('next'));

const user = await initAppShell({ access: 'public' });
if (user) {
  window.location.replace(next ?? homeFor(user)); // already signed in
} else {
  setUpForm();
}

function setUpForm() {
  const form = document.getElementById('login-form');
  const alertBox = document.getElementById('login-alert');
  const submit = form.querySelector('button[type="submit"]');
  const { email, password } = form.elements;

  // Keep the destination when the user switches to registration.
  if (next) document.getElementById('register-link').href = `${ROUTES.register}?${new URLSearchParams({ next })}`;

  // Arriving from verify-email.html after confirming the address.
  const confirmedEmail = sessionTake(STORAGE_KEYS.signInEmail);
  if (params.get('verified') === '1') {
    renderAlert(alertBox, {
      type: 'success',
      title: 'Your email address is confirmed',
      message: 'Sign in with your email address and password to continue.',
    });
    if (confirmedEmail) email.value = confirmedEmail;
  } else if (params.get('reason') === 'expired') {
    renderAlert(alertBox, {
      type: 'info',
      title: 'Your session has ended',
      message: 'Please sign in again to continue where you left off.',
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    renderAlert(alertBox, {});

    const values = { email: email.value.trim(), password: password.value };
    const errors = {};
    if (!values.email) errors.email = 'Email is required.';
    else if (!isValidEmail(values.email)) errors.email = 'Enter a valid email address.';
    if (!values.password) errors.password = 'Password is required.';
    if (Object.keys(errors).length > 0) {
      showFieldErrors(form, errors);
      return;
    }
    clearFieldErrors(form);

    try {
      const { user: signedIn } = await withButtonLoading(submit, login(values.email, values.password));
      window.location.assign(next ?? homeFor(signedIn));
    } catch (error) {
      if (error.code === 'EMAIL_NOT_VERIFIED') {
        showNotVerified(alertBox, values.email, error.message);
        return;
      }
      const unmatched = error.details ? showFieldErrors(form, error.details) : [];
      if (!error.details || unmatched.length > 0) {
        renderAlert(alertBox, {
          type: 'danger',
          title: error.code === 'INVALID_CREDENTIALS' ? 'Sign-in failed' : 'Could not sign in',
          message: unmatched.length > 0 ? unmatched.join(' ') : error.message,
        });
      }
      if (error.code === 'INVALID_CREDENTIALS') {
        password.value = '';
        password.focus();
      }
    }
  });
}

/**
 * The password was right, but the email address is not confirmed yet. Its own state,
 * not "sign-in failed": the user did nothing wrong and needs the link in their email.
 */
function showNotVerified(alertBox, address, message) {
  renderAlert(alertBox, {
    type: 'warning',
    title: 'Confirm your email address first',
    message,
    action: {
      label: 'Send a new confirmation email',
      onClick: async (button) => {
        try {
          const result = await withButtonLoading(button, resendVerification(address));
          renderAlert(alertBox, { type: 'success', title: 'Check your email', message: result.message });
        } catch (error) {
          renderAlert(alertBox, { type: 'danger', title: 'Could not send a new link', message: error.message });
        }
        // The button that had focus is gone; keep keyboard users on the new message.
        const shown = alertBox.firstElementChild;
        shown.setAttribute('tabindex', '-1');
        shown.focus();
      },
    },
  });
}
