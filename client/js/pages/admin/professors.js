import {
  createProfessor, deleteProfessor, listDepartments, listProfessors, removeProfessorPhoto, updateProfessor,
  uploadProfessorPhoto,
} from '../../api/academic.js';
import { initAppShell } from '../../components/app-shell.js';
import { professorBadge } from '../../components/course-parts.js';
import {
  clearFieldErrors, confirmDialog, renderAlert, renderEmpty, renderError, renderLoading, showFieldErrors, toast,
} from '../../components/feedback.js';
import { h } from '../../utils/dom.js';
import { pluralize } from '../../utils/format.js';
import { PHOTO_MAX_BYTES, PHOTO_TYPES } from '../../utils/validation.js';

const list = document.getElementById('professors');
const alertBox = document.getElementById('professors-alert');
let departments = [];
let photoVersion = String(Date.now()); // changes after an upload, so the new photo shows

const user = await initAppShell({ access: 'admin' });
if (user) init();

async function init() {
  document.getElementById('new-professor').addEventListener('click', (event) => editDialog(null, event.currentTarget));
  load();
}

async function load() {
  list.setAttribute('aria-busy', 'true');
  renderLoading(list, 'Loading professors…');
  try {
    const [{ professors }, lookup] = await Promise.all([listProfessors(), listDepartments()]);
    departments = lookup.departments;
    render(professors);
  } catch (error) {
    renderError(list, error, { title: 'Could not load the professors', onRetry: load });
  } finally {
    list.removeAttribute('aria-busy');
  }
}

function render(professors) {
  if (professors.length === 0) {
    renderEmpty(list, { title: 'No professors yet', message: 'Add one with "New professor".' });
    return;
  }
  list.replaceChildren(h('div', { class: 'table-wrap table-wrap--stack' },
    h('table', { class: 'table table--stack', role: 'table' },
      h('caption', { class: 'visually-hidden' }, `Professors: ${professors.length}`),
      h('thead', { role: 'rowgroup' }, h('tr', { role: 'row' },
        ['Professor', 'Department', 'Courses'].map((text) => h('th', { scope: 'col', role: 'columnheader' }, text)),
        h('th', { scope: 'col', role: 'columnheader' }, h('span', { class: 'visually-hidden' }, 'Actions')))),
      h('tbody', { role: 'rowgroup' }, professors.map((professor) => {
        const which = () => h('span', { class: 'visually-hidden' }, `: ${professor.fullName}`);
        const edit = h('button', { type: 'button', class: 'btn btn--sm' }, 'Edit', which());
        edit.addEventListener('click', () => editDialog(professor, edit));
        const photo = h('button', { type: 'button', class: 'btn btn--sm' }, professor.hasPhoto ? 'Change photo' : 'Add photo', which());
        photo.addEventListener('click', () => photoDialog(professor, photo));
        const remove = h('button', { type: 'button', class: 'btn btn--sm' }, 'Delete', which());
        remove.addEventListener('click', () => removeProfessor(professor, remove));
        return h('tr', { role: 'row', 'data-professor-id': professor.id },
          h('td', { role: 'cell' }, professorBadge(professor, { version: photoVersion })),
          h('td', { role: 'cell' }, h('span', { class: 'table__label', 'aria-hidden': 'true' }, 'Department'), professor.department.name),
          h('td', { role: 'cell' }, h('span', { class: 'table__label', 'aria-hidden': 'true' }, 'Courses'), pluralize(professor.courseCount, 'course')),
          h('td', { role: 'cell' }, h('div', { class: 'table__actions' }, edit, photo, professor.courseCount === 0 ? remove : null)));
      })))));
}

/** A form in a dialog. onSubmit(form) saves and returns a message; throwing shows the error in the dialog. */
function formDialog({ title, intro, fields, submitLabel, opener, onSubmit, extra = null }) {
  const formAlert = h('div', { class: 'form__alert' });
  const id = `dialog-form-${Date.now()}`;
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, submitLabel);
  const form = h('form', { class: 'form', id, novalidate: true },
    h('div', { class: 'dialog__body' },
      h('h2', { class: 'dialog__title', id: `${id}-title` }, title),
      intro ? h('p', {}, intro) : null,
      formAlert, ...fields),
    h('div', { class: 'dialog__actions' },
      h('button', { type: 'button', class: 'btn', onClick: () => dialog.close() }, 'Cancel'),
      extra,
      submit));
  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': `${id}-title` }, form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    renderAlert(formAlert, {});
    submit.disabled = true;
    try {
      const message = await onSubmit(form);
      dialog.close();
      toast(message);
      await load();
    } catch (error) {
      const unmatched = error.details ? showFieldErrors(form, error.details) : [error.message];
      if (unmatched.length > 0) renderAlert(formAlert, { type: 'danger', title: 'Could not save', message: unmatched.join(' ') });
    } finally {
      submit.disabled = false;
    }
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (opener.isConnected) opener.focus();
    else document.querySelector('#professors table')?.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  form.querySelector('input, select')?.focus();
  return { dialog, form };
}

function labelled(name, label, control, hint) {
  control.id = `professor-${name}`;
  if (hint) control.setAttribute('aria-describedby', `${control.id}-hint`);
  return h('div', { class: 'field' },
    h('label', { class: 'label', for: control.id }, label),
    control,
    hint ? h('p', { class: 'hint', id: `${control.id}-hint` }, hint) : null);
}

function editDialog(professor, opener) {
  const { form } = formDialog({
    title: professor ? `Edit ${professor.fullName}` : 'New professor',
    submitLabel: professor ? 'Save changes' : 'Add professor',
    opener,
    fields: [
      labelled('fullName', 'Name', h('input', { class: 'input', type: 'text', name: 'fullName', maxlength: 100, required: true }),
        'As the university publishes it, e.g. "Dr. Han Ji-won".'),
      labelled('departmentId', 'Department', h('select', { class: 'select', name: 'departmentId', required: true },
        h('option', { value: '' }, 'Choose a department'),
        departments.map((department) => h('option', { value: department.id }, department.name)))),
    ],
    onSubmit: async ({ elements }) => {
      const fields = { fullName: elements.fullName.value, departmentId: elements.departmentId.value === '' ? undefined : Number(elements.departmentId.value) };
      if (professor) {
        await updateProfessor(professor.id, fields);
        return 'Professor saved.';
      }
      await createProfessor(fields);
      return 'Professor added.';
    },
  });
  if (professor) {
    form.elements.fullName.value = professor.fullName;
    form.elements.departmentId.value = professor.department.id;
  }
}

function photoDialog(professor, opener) {
  const removeButton = professor.hasPhoto
    ? h('button', { type: 'button', class: 'btn btn--danger' }, 'Remove photo')
    : null;
  const { dialog } = formDialog({
    title: `Photo of ${professor.fullName}`,
    intro: 'Use only a publicly available photo the university has permitted. The credit is shown under it wherever it appears.',
    submitLabel: 'Upload photo',
    opener,
    extra: removeButton,
    fields: [
      labelled('photo', 'Photo', h('input', { class: 'input', type: 'file', name: 'photo', accept: PHOTO_TYPES.join(','), required: true }),
        `JPEG, PNG or WebP, at most ${PHOTO_MAX_BYTES / 1024 / 1024} MB.`),
      labelled('credit', 'Photo credit', h('input', { class: 'input', type: 'text', name: 'credit', maxlength: 200, required: true, value: professor.photoCredit ?? '' }),
        'Where it was published, e.g. "Kyungdong University website, used with permission".'),
    ],
    onSubmit: async ({ elements }) => {
      const file = elements.photo.files[0];
      const problems = {};
      if (!file) problems.photo = 'Choose a photo to upload.';
      else if (!PHOTO_TYPES.includes(file.type)) problems.photo = 'Choose a JPEG, PNG or WebP image.';
      else if (file.size > PHOTO_MAX_BYTES) problems.photo = `The photo must be at most ${PHOTO_MAX_BYTES / 1024 / 1024} MB.`;
      if (elements.credit.value.trim().length < 3) problems.credit = 'Say where the photo comes from.';
      if (Object.keys(problems).length > 0) throw Object.assign(new Error('Some fields are missing or invalid.'), { details: problems });
      await uploadProfessorPhoto(professor.id, file, elements.credit.value.trim());
      photoVersion = String(Date.now());
      return 'Photo saved.';
    },
  });
  removeButton?.addEventListener('click', async () => {
    dialog.close();
    const confirmed = await confirmDialog({ title: 'Remove this photo?', message: `${professor.fullName} will be shown with initials.`, confirmLabel: 'Remove photo', danger: true });
    if (!confirmed) return;
    try {
      await removeProfessorPhoto(professor.id);
      toast('Photo removed.');
      await load();
    } catch (error) {
      renderAlert(alertBox, { type: 'danger', title: 'Could not remove the photo', message: error.message });
    }
  });
}

async function removeProfessor(professor, button) {
  const confirmed = await confirmDialog({
    title: `Delete ${professor.fullName}?`,
    message: 'They teach no course, so they can be deleted. Their photo is deleted too.',
    confirmLabel: 'Delete professor',
    danger: true,
  });
  if (!confirmed) {
    button.focus();
    return;
  }
  renderAlert(alertBox, {});
  try {
    await deleteProfessor(professor.id);
    toast('Professor deleted.');
    await load();
    document.getElementById('new-professor').focus();
  } catch (error) {
    renderAlert(alertBox, { type: 'danger', title: 'Could not delete the professor', message: error.message });
  }
}
