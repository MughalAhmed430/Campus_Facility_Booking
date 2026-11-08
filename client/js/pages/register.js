import { register, resendVerification } from '../api/auth.js';
import { homeFor, initAppShell, ROUTES, safeNextPath } from '../components/app-shell.js';
import { clearFieldErrors, renderAlert, showFieldErrors, withButtonLoading } from '../components/feedback.js';
import { h } from '../utils/dom.js';
import {
  byteLength, isValidEmail, PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH, STUDENT_NUMBER_PATTERN,
} from '../utils/validation.js';

const SITE_NAME = 'Campus Facility Booking';
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

  // Keep the destination when the user switches to sign-in.
  const loginUrl = () => (next ? `${ROUTES.login}?${new URLSearchParams({ next })}` : ROUTES.login);
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
      // The new account cannot sign in until its email address is confirmed.
      showCheckYourEmail(values.email, loginUrl());
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

/**
 * Replaces the form with "Check your email": the link in that email confirms the address,
 * then the user signs in. Focus moves to the new heading so screen readers announce it.
 */
function showCheckYourEmail(email, signInHref) {
  document.title = `Check your email | ${SITE_NAME}`;
  const alertBox = h('div', { id: 'register-alert' });
  const heading = h('h1', { class: 'auth-card__title', tabindex: '-1' }, 'Check your email');

  const resendButton = h('button', {
    type: 'button',
    class: 'btn btn--secondary btn--block',
    id: 'register-resend',
    onClick: async () => {
      renderAlert(alertBox, {});
      try {
        const { message } = await withButtonLoading(resendButton, resendVerification(email));
        renderAlert(alertBox, { type: 'success', message });
      } catch (error) {
        renderAlert(alertBox, { type: 'danger', title: 'Could not send a new link', message: error.message });
      }
    },
  }, 'Send a new link');

  document.querySelector('.auth-card__body').replaceChildren(
    h('div', {},
      heading,
      h('p', { class: 'auth-card__lead' }, 'Your account has been created. Confirm your email address to start using it.')),
    h('p', {},
      'We sent a confirmation link to ', h('strong', { class: 'auth-card__email' }, email),
      '. Open it to finish, then sign in. The link works for 24 hours.'),
    h('p', { class: 'hint' }, 'Can’t find the email? Check your spam folder, or send a new link.'),
    alertBox,
    resendButton,
    h('p', { class: 'auth-card__switch' }, 'Already confirmed? ', h('a', { href: signInHref }, 'Sign in')),
  );
  heading.focus();
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
    errors.studentNumber = 'Student number must be 4-20 letters or digits.';
  }

  if (!values.password) errors.password = 'Password is required.';
  else if (values.password.length < PASSWORD_MIN_LENGTH) errors.password = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  else if (byteLength(values.password) > PASSWORD_MAX_BYTES) errors.password = 'Password must be at most 72 bytes (about 72 English characters).';
  else if (values.password.trim() === '') errors.password = 'Password cannot be only spaces.';

  if (!values.confirmPassword) errors.confirmPassword = 'Enter your password again.';
  else if (values.password && values.confirmPassword !== values.password) errors.confirmPassword = 'The passwords do not match.';

  return errors;
}
