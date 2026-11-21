import { createSemester, listCourses, listSemesters } from '../../api/academic.js';
import { initAppShell, ROUTES } from '../../components/app-shell.js';
import { seatsLabel, slotLabel } from '../../components/course-parts.js';
import {
  clearFieldErrors, renderAlert, renderEmpty, renderError, renderLoading, showFieldErrors, toast,
} from '../../components/feedback.js';
import { h } from '../../utils/dom.js';
import { dateLabel, pluralize } from '../../utils/format.js';

const form = document.getElementById('course-filters');
const semesterSelect = form.elements.semester;
const list = document.getElementById('courses');
const countLine = document.getElementById('courses-count');
const alertBox = document.getElementById('courses-alert');
const newCourse = document.getElementById('new-course');
let request = null;
let searchTimer = null;

const user = await initAppShell({ access: 'admin' });
if (user) init();

async function init() {
  announceSaved();
  document.getElementById('new-semester').addEventListener('click', addSemester);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    load();
  });
  semesterSelect.addEventListener('change', load);
  form.elements.q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 300);
  });
  await loadSemesters(new URLSearchParams(window.location.search).get('semester'));
  load();
}

function announceSaved() {
  const saved = new URLSearchParams(window.location.search).get('saved');
  if (saved === 'deleted') toast('Course deleted.');
  if (saved) window.history.replaceState(null, '', window.location.pathname);
}

async function loadSemesters(wanted) {
  try {
    const { semesters, currentId } = await listSemesters();
    semesterSelect.replaceChildren(...semesters.map((semester) => h('option', { value: semester.id },
      `${semester.name} (${dateLabel(semester.startsOn)} – ${dateLabel(semester.endsOn)})${semester.id === currentId ? ', current' : ''}`)));
    semesterSelect.value = semesters.some((semester) => String(semester.id) === wanted) ? wanted : String(currentId ?? '');
  } catch (error) {
    renderAlert(alertBox, { type: 'danger', title: 'Could not load the semesters', message: error.message });
  }
}

async function load() {
  const semester = semesterSelect.value;
  newCourse.href = semester ? `${ROUTES.adminCourseForm}?semester=${semester}` : ROUTES.adminCourseForm;
  request?.abort();
  const controller = new AbortController();
  request = controller;
  list.setAttribute('aria-busy', 'true');
  renderLoading(list, 'Loading courses…');
  countLine.textContent = '';
  try {
    render(await listCourses({ semester, q: form.elements.q.value.trim() }, { signal: controller.signal }));
  } catch (error) {
    if (controller.signal.aborted) return;
    renderError(list, error, { title: 'Could not load the courses', onRetry: load });
  } finally {
    if (request === controller) list.removeAttribute('aria-busy');
  }
}

function cell(label, attrs, ...content) {
  return h('td', { role: 'cell', ...attrs },
    label ? h('span', { class: 'table__label', 'aria-hidden': 'true' }, label) : null,
    ...content);
}

function render({ semester, courses }) {
  if (!semester) {
    renderEmpty(list, { title: 'No semester yet', message: 'Add one with "New semester" first.' });
    return;
  }
  countLine.textContent = `${pluralize(courses.length, 'course')} in ${semester.name}`;
  if (courses.length === 0) {
    renderEmpty(list, { title: 'No courses found', message: 'Add one with "New course", or change the search.' });
    return;
  }
  const headers = ['Course', 'Professor', 'Lectures', 'Seats'];
  list.replaceChildren(h('div', { class: 'table-wrap table-wrap--stack' },
    h('table', { class: 'table table--stack', role: 'table' },
      h('caption', { class: 'visually-hidden' }, `Courses in ${semester.name}`),
      h('thead', { role: 'rowgroup' },
        h('tr', { role: 'row' },
          headers.map((text) => h('th', { scope: 'col', role: 'columnheader' }, text)),
          h('th', { scope: 'col', role: 'columnheader' }, h('span', { class: 'visually-hidden' }, 'Actions')))),
      h('tbody', { role: 'rowgroup' }, courses.map((course) => h('tr', { role: 'row', 'data-course-id': course.id },
        cell(null, {},
          h('span', { class: 'course-card__code' }, course.code), ' ', course.title,
          h('span', { class: 'table__sub' }, `${course.department.name} · ${pluralize(course.credits, 'credit')}`)),
        cell('Professor', {}, course.professor.fullName),
        cell('Lectures', {}, course.slots.length > 0
          ? course.slots.map((slot) => h('span', { class: 'table__line' }, slotLabel(slot)))
          : h('span', { class: 'table__muted' }, 'None yet')),
        cell('Seats', { class: 'table__nowrap' }, `${course.seatsTaken} / ${course.seatLimit}`,
          h('span', { class: 'table__sub' }, seatsLabel(course))),
        h('td', { role: 'cell' },
          h('a', { class: 'btn btn--sm', href: `${ROUTES.adminCourseForm}?id=${course.id}` },
            'Manage', h('span', { class: 'visually-hidden' }, `: ${course.code} ${course.title}`)))))))));
}

/** A small form in a dialog: name, first and last day of lectures. */
function addSemester() {
  const opener = document.getElementById('new-semester');
  const alert = h('div', { class: 'form__alert' });
  const fields = [
    ['name', 'Name', h('input', { class: 'input', type: 'text', name: 'name', maxlength: 40, required: true, placeholder: '2027 Spring' })],
    ['startsOn', 'First day of lectures', h('input', { class: 'input', type: 'date', name: 'startsOn', required: true })],
    ['endsOn', 'Last day of lectures', h('input', { class: 'input', type: 'date', name: 'endsOn', required: true })],
  ].map(([name, label, control]) => {
    control.id = `semester-${name}`;
    return h('div', { class: 'field' }, h('label', { class: 'label', for: control.id }, label), control);
  });
  const save = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Add semester');
  const cancel = h('button', { type: 'button', class: 'btn', onClick: () => dialog.close() }, 'Cancel');
  const semesterForm = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'dialog__body' },
      h('h2', { class: 'dialog__title', id: 'semester-dialog-title' }, 'New semester'),
      h('p', {}, 'Semesters cannot overlap. Courses are added to a semester afterwards.'),
      alert, ...fields),
    h('div', { class: 'dialog__actions' }, cancel, save));
  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'semester-dialog-title' }, semesterForm);

  semesterForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(semesterForm);
    renderAlert(alert, {});
    const { elements } = semesterForm;
    try {
      const { semester } = await createSemester({ name: elements.name.value, startsOn: elements.startsOn.value, endsOn: elements.endsOn.value });
      dialog.close();
      toast(`${semester.name} added.`);
      await loadSemesters(String(semester.id));
      load();
    } catch (error) {
      const unmatched = error.details ? showFieldErrors(semesterForm, error.details) : [error.message];
      if (unmatched.length > 0) renderAlert(alert, { type: 'danger', title: 'Could not add the semester', message: unmatched.join(' ') });
    }
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    opener.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  semesterForm.elements.name.focus();
}
