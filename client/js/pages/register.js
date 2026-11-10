import { register } from '../api/auth.js';
import { homeFor, initAppShell, ROUTES, safeNextPath } from '../components/app-shell.js';
import { clearFieldErrors, renderAlert, showFieldErrors, withButtonLoading } from '../components/feedback.js';
import { sessionSet, STORAGE_KEYS } from '../utils/storage.js';
import {
  byteLength, isValidEmail, PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH, STUDENT_NUMBER_PATTERN,
} from '../utils/validation.js';

const next = safeNextPath(new URLSearchParams(window.location.search).get('next'));

const user = await initAppShell({ access: 'public' });
if (user) {
  window.location.replace(next ?? homeFor(user)); // already signed in
} else {
  setUpForm();
}

function setUpForm() {
  const form = document.getElementById('register-form');
  const alertBox = document.getElementById('register-alert');
  const submit = form.querySelector('button[type="submit"]');

  const loginUrl = (extra = {}) => {
    const params = new URLSearchParams(extra);
    if (next) params.set('next', next);
    const query = params.toString();
    return query ? `${ROUTES.login}?${query}` : ROUTES.login;
  };
  document.getElementById('login-link').href = loginUrl();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    renderAlert(alertBox, {});

    const values = readForm(form);
    const errors = validate(values);
    if (Object.keys(errors).length > 0) {
      showFieldErrors(form, errors);
      return;
    }
    clearFieldErrors(form);

    try {
      await withButtonLoading(submit, register({
        fullName: values.fullName,
        email: values.email,
        password: values.password,
        studentNumber: values.studentNumber || undefined,
      }));
      // Registration does not sign the user in; the sign-in page confirms the new
      // account and pre-fills the email address.
      sessionSet(STORAGE_KEYS.registeredEmail, values.email);
      window.location.assign(loginUrl({ registered: '1' }));
    } catch (error) {
      // Field problems (including "email already registered") appear under the fields.
      const unmatched = error.details ? showFieldErrors(form, error.details) : [];
      if (!error.details || unmatched.length > 0) {
        renderAlert(alertBox, {
          type: 'danger',
          title: 'Could not create your account',
          message: unmatched.length > 0 ? unmatched.join(' ') : error.message,
        });
      }
    }
  });
}

function readForm(form) {
  const data = new FormData(form);
  const text = (name) => String(data.get(name) ?? '');
  return {
    fullName: text('fullName').trim(),
    email: text('email').trim(),
    studentNumber: text('studentNumber').trim(),
    password: text('password'), // not trimmed: spaces count
    confirmPassword: text('confirmPassword'),
  };
}

/** The same rules as the server, checked first so mistakes show without a round trip. */
function validate(values) {
  const errors = {};
  if (!values.fullName) errors.fullName = 'Full name is required.';

  if (!values.email) errors.email = 'Email is required.';
  else if (!isValidEmail(values.email)) errors.email = 'Enter a valid email address.';

  if (values.studentNumber && !STUDENT_NUMBER_PATTERN.test(values.studentNumber)) {
    errors.studentNumber = 'Student number must be 1 to 6 digits.';
  }

  if (!values.password) errors.password = 'Password is required.';
  else if (values.password.length < PASSWORD_MIN_LENGTH) errors.password = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  else if (byteLength(values.password) > PASSWORD_MAX_BYTES) errors.password = 'Password must be at most 72 bytes (about 72 English characters).';
  else if (values.password.trim() === '') errors.password = 'Password cannot be only spaces.';

  if (!values.confirmPassword) errors.confirmPassword = 'Enter your password again.';
  else if (values.password && values.confirmPassword !== values.password) errors.confirmPassword = 'The passwords do not match.';

  return errors;
}
