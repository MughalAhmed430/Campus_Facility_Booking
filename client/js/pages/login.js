import { login } from '../api/auth.js';
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

  const registeredEmail = sessionTake(STORAGE_KEYS.registeredEmail);
  if (params.get('registered') === '1') {
    renderAlert(alertBox, {
      type: 'success',
      title: 'Your account has been created',
      message: 'Sign in with your email address and password to continue.',
    });
    if (registeredEmail) email.value = registeredEmail;
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
