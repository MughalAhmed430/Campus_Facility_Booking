import { changePassword, getProfile, removePhoto, updateProfile, uploadPhoto } from '../api/profile.js';
import { avatar, initAppShell, refreshHeaderUser } from '../components/app-shell.js';
import {
  clearFieldErrors, confirmDialog, renderAlert, renderError, renderLoading, showFieldErrors, toast, withButtonLoading,
} from '../components/feedback.js';
import { h } from '../utils/dom.js';
import { momentLabel } from '../utils/format.js';
import { byteLength, PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH, PHOTO_MAX_BYTES, PHOTO_TYPES } from '../utils/validation.js';

const container = document.getElementById('profile');
const ROLE_LABELS = { student: 'Student', admin: 'Administrator' };

const user = await initAppShell({ access: 'signed-in' });
if (user) load();

async function load() {
  renderLoading(container, 'Loading your profile…');
  try {
    const { user: profile } = await getProfile();
    render(profile);
  } catch (error) {
    renderError(container, error, { title: 'Could not load your profile', onRetry: load, heading: 'h2' });
  }
}

function render(profile) {
  container.replaceChildren(photoCard(profile), detailsCard(profile), passwordCard());
}

function card(titleId, title, ...content) {
  return h('section', { class: 'card', 'aria-labelledby': titleId },
    h('div', { class: 'card__body stack' },
      h('h2', { class: 'card__section-title', id: titleId }, title),
      ...content));
}

function field({ id, label, hint, ...attrs }) {
  const hintId = hint ? `${id}-hint` : null;
  return h('div', { class: 'field' },
    h('label', { class: 'label', for: id }, label),
    h('input', { class: 'input', id, 'aria-describedby': hintId, ...attrs }),
    hint ? h('p', { class: 'hint', id: hintId }, hint) : null);
}

/* ---- Photo ------------------------------------------------------------------------ */

function photoCard(profile) {
  let current = profile;
  const alertBox = h('div', { 'aria-live': 'polite' });
  const picture = h('div', {}, avatar(current, { size: 'lg' }));
  const input = h('input', {
    type: 'file', id: 'photo-file', name: 'photo', accept: PHOTO_TYPES.join(','), 'aria-describedby': 'photo-hint',
  });
  const chooseLabel = h('label', { class: 'btn btn--secondary file-button', for: 'photo-file' },
    current.hasPhoto ? 'Change photo' : 'Upload photo', input);
  const remove = h('button', { type: 'button', class: 'btn', hidden: !current.hasPhoto }, 'Remove photo');

  function show(next, version) {
    current = next;
    picture.replaceChildren(avatar(current, { size: 'lg', version }));
    chooseLabel.firstChild.textContent = current.hasPhoto ? 'Change photo' : 'Upload photo';
    remove.hidden = !current.hasPhoto;
    refreshHeaderUser(current, { version });
  }

  input.addEventListener('change', async () => {
    const [file] = input.files;
    input.value = ''; // choosing the same file again still fires "change"
    if (!file) return;
    renderAlert(alertBox, {});
    // Quick checks first; the server checks the file's content as well.
    if (!PHOTO_TYPES.includes(file.type)) {
      renderAlert(alertBox, { type: 'danger', title: 'This file cannot be used', message: 'Choose a JPEG, PNG or WebP image.' });
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      renderAlert(alertBox, { type: 'danger', title: 'This file is too large', message: 'The photo must be at most 2 MB.' });
      return;
    }
    chooseLabel.classList.add('is-loading');
    try {
      const { user: next } = await uploadPhoto(file);
      show(next, Date.now());
      toast('Photo updated.');
    } catch (error) {
      renderAlert(alertBox, { type: 'danger', title: 'Could not upload the photo', message: error.details?.photo ?? error.message });
    } finally {
      chooseLabel.classList.remove('is-loading');
    }
  });

  remove.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'Remove your photo?',
      message: 'Your initials are shown instead. You can upload a photo again at any time.',
      confirmLabel: 'Remove photo',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (!confirmed) {
      remove.focus();
      return;
    }
    renderAlert(alertBox, {});
    try {
      const { user: next } = await withButtonLoading(remove, removePhoto());
      show(next, Date.now());
      chooseLabel.querySelector('input').focus();
      toast('Photo removed.');
    } catch (error) {
      renderAlert(alertBox, { type: 'danger', title: 'Could not remove the photo', message: error.message });
    }
  });

  return card('photo-title', 'Profile photo',
    h('div', { class: 'profile-photo' },
      picture,
      h('div', { class: 'stack' },
        h('div', { class: 'profile-photo__actions' }, chooseLabel, remove),
        h('p', { class: 'hint', id: 'photo-hint' },
          'JPEG, PNG or WebP, up to 2 MB. Only you and the administrators can see it.'))),
    alertBox);
}

/* ---- Details ---------------------------------------------------------------------- */

function detailsCard(profile) {
  const alertBox = h('div');
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Save name');
  const form = h('form', { class: 'form', id: 'details-form', novalidate: true },
    field({ id: 'profile-name', label: 'Full name', name: 'fullName', autocomplete: 'name', maxlength: 100, required: true, value: profile.fullName }),
    alertBox,
    h('div', {}, submit));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    renderAlert(alertBox, {});
    const fullName = form.elements.fullName.value.trim().replace(/\s+/g, ' ');
    if (!fullName) {
      showFieldErrors(form, { fullName: 'Full name is required.' });
      return;
    }
    clearFieldErrors(form);
    try {
      const { user: next } = await withButtonLoading(submit, updateProfile({ fullName }));
      form.elements.fullName.value = next.fullName;
      refreshHeaderUser(next);
      renderAlert(alertBox, { type: 'success', title: 'Name saved' });
    } catch (error) {
      const unmatched = error.details ? showFieldErrors(form, error.details) : [];
      if (!error.details || unmatched.length > 0) {
        renderAlert(alertBox, { type: 'danger', title: 'Could not save your name', message: unmatched.join(' ') || error.message });
      }
    }
  });

  return card('details-title', 'Account details',
    h('dl', { class: 'details-list' },
      h('div', {}, h('dt', {}, 'Email'), h('dd', {}, profile.email, h('p', { class: 'hint' }, 'You sign in with it, so it cannot be changed here.'))),
      profile.role === 'student'
        ? h('div', {}, h('dt', {}, 'Student number'), h('dd', {}, profile.studentNumber ?? 'Not given',
          h('p', { class: 'hint' }, 'Ask an administrator if it needs correcting.')))
        : null,
      h('div', {}, h('dt', {}, 'Account type'), h('dd', {}, ROLE_LABELS[profile.role] ?? profile.role)),
      h('div', {}, h('dt', {}, 'Member since'), h('dd', {}, momentLabel(profile.createdAt)))),
    form);
}

/* ---- Password --------------------------------------------------------------------- */

function passwordCard() {
  const alertBox = h('div');
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Change password');
  const form = h('form', { class: 'form', id: 'password-form', novalidate: true },
    field({ id: 'password-current', label: 'Current password', name: 'currentPassword', type: 'password', autocomplete: 'current-password', required: true }),
    field({
      id: 'password-new', label: 'New password', name: 'newPassword', type: 'password', autocomplete: 'new-password', required: true,
      hint: `At least ${PASSWORD_MIN_LENGTH} characters, different from your current one.`,
    }),
    field({ id: 'password-confirm', label: 'Confirm new password', name: 'confirmPassword', type: 'password', autocomplete: 'new-password', required: true }),
    alertBox,
    h('div', {}, submit));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    renderAlert(alertBox, {});
    const currentPassword = form.elements.currentPassword.value;
    const newPassword = form.elements.newPassword.value;
    const confirm = form.elements.confirmPassword.value;
    const errors = {};
    if (!currentPassword) errors.currentPassword = 'Current password is required.';
    if (!newPassword) errors.newPassword = 'New password is required.';
    else if (newPassword.length < PASSWORD_MIN_LENGTH) errors.newPassword = `New password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
    else if (byteLength(newPassword) > PASSWORD_MAX_BYTES) errors.newPassword = 'New password is too long (at most 72 bytes).';
    else if (newPassword.trim() === '') errors.newPassword = 'New password cannot be only spaces.';
    if (newPassword && confirm !== newPassword) errors.confirmPassword = 'The two new passwords do not match.';
    if (Object.keys(errors).length > 0) {
      showFieldErrors(form, errors);
      return;
    }
    clearFieldErrors(form);
    try {
      const { otherSessionsEnded } = await withButtonLoading(submit, changePassword({ currentPassword, newPassword }));
      form.reset();
      renderAlert(alertBox, {
        type: 'success',
        title: 'Password changed',
        message: otherSessionsEnded > 0
          ? 'You stay signed in here. Your other sign-ins (other browsers or devices) have been signed out.'
          : 'You stay signed in here. Use the new password next time you sign in.',
      });
    } catch (error) {
      const unmatched = error.details ? showFieldErrors(form, error.details) : [];
      if (!error.details || unmatched.length > 0) {
        renderAlert(alertBox, { type: 'danger', title: 'Could not change your password', message: unmatched.join(' ') || error.message });
      }
    }
  });

  return card('password-title', 'Password', form);
}
