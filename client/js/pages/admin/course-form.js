import {
  addLectureSlot, createCourse, deleteCourse, getCourse, listCourseStudents, listDepartments, listProfessors,
  listSemesters, removeLectureSlot, updateCourse,
} from '../../api/academic.js';
import { listFacilities } from '../../api/facilities.js';
import { initAppShell, ROUTES } from '../../components/app-shell.js';
import { seatsLabel, slotLabel, WEEKDAY_NAMES, weekdayName } from '../../components/course-parts.js';
import {
  clearFieldErrors, confirmDialog, renderAlert, renderEmpty, renderError, renderLoading, showFieldErrors, toast,
  withButtonLoading,
} from '../../components/feedback.js';
import { h } from '../../utils/dom.js';
import { momentLabel, pluralize, roomLabel } from '../../utils/format.js';
import { timeSteps } from '../../utils/timeline.js';

const SITE_NAME = 'Campus Facility Booking';
const DESCRIPTION_MAX_LENGTH = 2000; // the same as the server

const root = document.getElementById('course-form-page');
const params = new URLSearchParams(window.location.search);
const idText = params.get('id');

const user = await initAppShell({ access: 'admin' });
if (user) await load();

async function load() {
  if (idText !== null && !/^[1-9]\d{0,9}$/.test(idText)) {
    renderNotFound('This link does not point to a course. It may be incomplete.');
    return;
  }
  renderLoading(root, 'Loading…');
  try {
    const [{ semesters, currentId }, { departments }, { professors }, existing] = await Promise.all([
      listSemesters(), listDepartments(), listProfessors(),
      idText === null ? null : Promise.all([getCourse(idText), listCourseStudents(idText), listFacilities({ status: 'active' })]),
    ]);
    const [course, students, rooms] = existing ? [existing[0].course, existing[1].students, existing[2].facilities] : [null, [], []];
    renderPage({ semesters, currentId, departments, professors, course, students, rooms });
  } catch (error) {
    if (error.status === 404 || error.code === 'VALIDATION_ERROR') renderNotFound(error.message);
    else renderError(root, error, { title: 'Could not load this page', heading: 'h1', onRetry: load });
  }
}

function renderNotFound(message) {
  document.title = `Course not found | ${SITE_NAME}`;
  renderEmpty(root, { title: 'Course not found', message, heading: 'h1', action: { label: 'Back to courses', href: ROUTES.adminCourses } });
}

function field(prefix, name, label, control, { hint, optional = false } = {}) {
  const id = `${prefix}-${name}`;
  control.id = id;
  if (hint) control.setAttribute('aria-describedby', `${id}-hint`);
  return h('div', { class: 'field' },
    h('label', { class: 'label', for: id }, label, optional ? [' ', h('span', { class: 'label__optional' }, '(optional)')] : null),
    control,
    hint ? h('p', { class: 'hint', id: `${id}-hint` }, hint) : null);
}

function renderPage({ semesters, currentId, departments, professors, course, students, rooms }) {
  const editing = course !== null;
  const title = editing ? `${course.code} ${course.title}` : 'New course';
  document.title = `${title} | ${SITE_NAME}`;
  root.replaceChildren(
    h('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' },
      h('ol', {}, h('li', {}, h('a', { href: ROUTES.adminCourses }, 'Courses')), h('li', { 'aria-current': 'page' }, title))),
    h('header', { class: 'page-header' },
      h('div', {},
        h('h1', { class: 'page-header__title' }, title),
        h('p', { class: 'page-header__description' }, editing
          ? `${course.semester.name} · ${seatsLabel(course)}`
          : 'Enter the course; add its weekly lectures after saving it.')),
      editing
        ? h('div', { class: 'page-header__actions' },
          h('a', { class: 'btn', href: `${ROUTES.adminGradebook}?course=${course.id}` }, 'Assessments and marks'))
        : null),
    h('div', { class: 'stack stack--lg' },
      detailsCard({ semesters, currentId, departments, professors, course }),
      editing ? lecturesCard(course, rooms) : null,
      editing ? studentsCard(students) : null,
      editing ? deleteCard(course) : null),
  );
}

// ---- Details --------------------------------------------------------------------------

function detailsCard({ semesters, currentId, departments, professors, course }) {
  const editing = course !== null;
  const alertBox = h('div', { class: 'form__alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, editing ? 'Save changes' : 'Create course');
  const form = h('form', { class: 'form', id: 'course-form', novalidate: true, 'aria-labelledby': 'course-details-title' },
    alertBox,
    editing
      ? h('div', { class: 'field' }, h('p', { class: 'label' }, 'Semester'), h('p', {}, course.semester.name),
        h('p', { class: 'hint' }, 'The semester cannot change: the lectures are dated.'))
      : field('course', 'semesterId', 'Semester', h('select', { class: 'select', name: 'semesterId', required: true },
        semesters.map((semester) => h('option', { value: semester.id }, semester.name)))),
    h('div', { class: 'form-row' },
      field('course', 'code', 'Course code', h('input', { class: 'input', type: 'text', name: 'code', maxlength: 12, required: true, autocomplete: 'off' }),
        { hint: 'Letters then digits, e.g. CSE2010. Unique in the semester.' }),
      field('course', 'credits', 'Credits', h('input', { class: 'input', type: 'number', name: 'credits', min: 1, max: 6, step: 1, inputmode: 'numeric', required: true }),
        { hint: 'From 1 to 6.' })),
    field('course', 'title', 'Title', h('input', { class: 'input', type: 'text', name: 'title', maxlength: 150, required: true })),
    h('div', { class: 'form-row' },
      field('course', 'departmentId', 'Department', h('select', { class: 'select', name: 'departmentId', required: true },
        h('option', { value: '' }, 'Choose a department'),
        departments.map((department) => h('option', { value: department.id }, department.name)))),
      field('course', 'professorId', 'Professor', h('select', { class: 'select', name: 'professorId', required: true },
        h('option', { value: '' }, 'Choose a professor'),
        professors.map((professor) => h('option', { value: professor.id }, `${professor.fullName} (${professor.department.code})`))),
      { hint: h('span', {}, 'Missing? Add them on ', h('a', { href: ROUTES.adminProfessors }, 'Professors'), '.') })),
    field('course', 'seatLimit', 'Seat limit', h('input', { class: 'input', type: 'number', name: 'seatLimit', min: 1, max: 1000, step: 1, inputmode: 'numeric', required: true }),
      { hint: 'Registration stops when every seat is taken. It cannot go below the students already registered.' }),
    field('course', 'description', 'Description', h('textarea', { class: 'textarea', name: 'description', rows: 3, maxlength: DESCRIPTION_MAX_LENGTH }),
      { optional: true }),
    h('div', { class: 'form-actions' }, submit, h('a', { class: 'btn', href: ROUTES.adminCourses }, editing ? 'Back to courses' : 'Cancel')));

  const { elements } = form;
  if (editing) {
    elements.code.value = course.code;
    elements.credits.value = course.credits;
    elements.title.value = course.title;
    elements.departmentId.value = course.department.id;
    elements.professorId.value = course.professor.id;
    elements.seatLimit.value = course.seatLimit;
    elements.description.value = course.description ?? '';
  } else {
    const wanted = params.get('semester');
    elements.semesterId.value = semesters.some((semester) => String(semester.id) === wanted) ? wanted : String(currentId ?? '');
    elements.credits.value = 3;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    renderAlert(alertBox, {});
    const number = (value) => (value.trim() === '' ? undefined : Number(value));
    const fields = {
      code: elements.code.value,
      title: elements.title.value,
      credits: number(elements.credits.value),
      departmentId: number(elements.departmentId.value),
      professorId: number(elements.professorId.value),
      seatLimit: number(elements.seatLimit.value),
      description: elements.description.value,
    };
    try {
      if (editing) {
        await withButtonLoading(submit, updateCourse(course.id, fields));
        toast('Course saved.');
        await load();
      } else {
        const created = await withButtonLoading(submit, createCourse({ ...fields, semesterId: number(elements.semesterId.value) }));
        window.location.assign(`${ROUTES.adminCourseForm}?id=${created.course.id}&saved=created`);
      }
    } catch (error) {
      const unmatched = error.details ? showFieldErrors(form, error.details) : [error.message];
      if (unmatched.length > 0) {
        renderAlert(alertBox, { type: 'danger', title: editing ? 'Could not save the changes' : 'Could not create the course', message: unmatched.join(' ') });
      }
    }
  });

  return h('section', { class: 'card', 'aria-labelledby': 'course-details-title' },
    h('div', { class: 'card__body stack' },
      h('h2', { class: 'card__section-title', id: 'course-details-title' }, 'Details'),
      form));
}

// ---- Lecture times ---------------------------------------------------------------------

function lecturesCard(course, rooms) {
  if (params.get('saved') === 'created') {
    toast('Course created. Now add its weekly lectures.');
    window.history.replaceState(null, '', `${window.location.pathname}?id=${course.id}`);
  }
  const alertBox = h('div', { class: 'page-alert', id: 'slots-alert' });
  const rows = course.slots.map((slot) => {
    const remove = h('button', { type: 'button', class: 'btn btn--sm' },
      'Remove', h('span', { class: 'visually-hidden' }, `: ${slotLabel(slot)}`));
    remove.addEventListener('click', () => removeSlot(course, slot, remove, alertBox));
    return h('tr', { 'data-slot-id': slot.id },
      h('td', {}, weekdayName(slot.weekday)),
      h('td', { class: 'table__nowrap' }, `${slot.startTime}–${slot.endTime}`),
      h('td', {}, `${slot.facility.name} (${slot.facility.building.code} ${slot.facility.roomNumber})`),
      h('td', {}, remove));
  });

  const starts = timeSteps(7 * 60, 22 * 60);
  const addForm = h('form', { class: 'form', id: 'slot-form', novalidate: true, 'aria-labelledby': 'slot-form-title' },
    h('h3', { class: 'card__section-title', id: 'slot-form-title' }, 'Add a weekly lecture'),
    h('div', { class: 'form-row' },
      field('slot', 'weekday', 'Day', h('select', { class: 'select', name: 'weekday' },
        WEEKDAY_NAMES.map((name, index) => h('option', { value: index + 1 }, name)))),
      field('slot', 'startTime', 'Starts', h('select', { class: 'select', name: 'startTime' }, starts.map((time) => h('option', { value: time }, time)))),
      field('slot', 'endTime', 'Ends', h('select', { class: 'select', name: 'endTime' }, starts.map((time) => h('option', { value: time }, time))))),
    field('slot', 'facilityId', 'Room', h('select', { class: 'select', name: 'facilityId' },
      h('option', { value: '' }, 'Choose a room'),
      rooms.map((room) => h('option', { value: room.id }, `${room.name} (${roomLabel(room)}), ${pluralize(room.capacity, 'seat')}`))),
    { hint: 'Only rooms taking bookings. The room must be free every week: an approved reservation or another lecture then is refused. Pending requests for those times are rejected, and their students told.' }),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn--primary' }, 'Add lecture')));
  addForm.elements.startTime.value = '09:00';
  addForm.elements.endTime.value = '10:30';
  addForm.elements.startTime.addEventListener('change', () => {
    const index = starts.indexOf(addForm.elements.startTime.value);
    addForm.elements.endTime.value = starts[Math.min(index + 3, starts.length - 1)]; // 90 minutes later
  });
  addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    addSlot(course, addForm, alertBox);
  });

  return h('section', { class: 'card', 'aria-labelledby': 'slots-title' },
    h('div', { class: 'card__body stack' },
      h('h2', { class: 'card__section-title', id: 'slots-title' }, 'Weekly lectures'),
      h('p', { class: 'hint' }, `Korea time (KST). Each lecture holds its room every week until ${course.semester.endsOn}, on the facility schedules too.`),
      alertBox,
      course.slots.length > 0
        ? h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Table of weekly lectures' }, h('table', { class: 'table slot-table' },
          h('caption', { class: 'visually-hidden' }, 'Weekly lectures'),
          h('thead', {}, h('tr', {}, ['Day', 'Time', 'Room'].map((text) => h('th', { scope: 'col' }, text)),
            h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Actions')))),
          h('tbody', {}, rows)))
        : h('p', { class: 'card__meta' }, 'No lectures yet.'),
      addForm));
}

async function addSlot(course, form, alertBox) {
  clearFieldErrors(form);
  renderAlert(alertBox, {});
  const { elements } = form;
  const button = form.querySelector('button[type=submit]');
  const fields = {
    weekday: Number(elements.weekday.value),
    startTime: elements.startTime.value,
    endTime: elements.endTime.value,
    facilityId: elements.facilityId.value === '' ? undefined : Number(elements.facilityId.value),
  };
  try {
    const result = await withButtonLoading(button, addLectureSlot(course.id, fields));
    toast(`Lecture added: ${pluralize(result.sessionsCreated, 'week')}`
      + `${result.autoRejected.length > 0 ? `; ${pluralize(result.autoRejected.length, 'pending request')} rejected` : ''}.`);
    await load();
    document.getElementById('slots-title')?.setAttribute('tabindex', '-1');
    document.getElementById('slots-title')?.focus();
  } catch (error) {
    const { clashes, ...fieldDetails } = error.details ?? {};
    // A room clash is explained above the form, with the weeks it affects.
    if (error.code === 'LECTURE_CONFLICT') {
      renderAlert(alertBox, { type: 'danger', title: 'The room is not free every week', message: error.message });
      elements.facilityId.focus();
      return;
    }
    const unmatched = error.details ? showFieldErrors(form, fieldDetails) : [error.message];
    if (unmatched.length > 0 || clashes) renderAlert(alertBox, { type: 'danger', title: 'Could not add the lecture', message: unmatched.join(' ') || error.message });
  }
}

async function removeSlot(course, slot, button, alertBox) {
  const confirmed = await confirmDialog({
    title: 'Remove this lecture?',
    message: `${course.code}, ${slotLabel(slot)}. Its lectures from now on are deleted and the room is free again then. Past lectures stay in the record.`,
    confirmLabel: 'Remove lecture',
    danger: true,
  });
  if (!confirmed) {
    button.focus();
    return;
  }
  try {
    const { sessionsRemoved } = await removeLectureSlot(course.id, slot.id);
    toast(`Lecture removed: ${pluralize(sessionsRemoved, 'week')} freed.`);
    await load();
    document.getElementById('slots-title')?.setAttribute('tabindex', '-1');
    document.getElementById('slots-title')?.focus();
  } catch (error) {
    renderAlert(alertBox, { type: 'danger', title: 'Could not remove the lecture', message: error.message });
  }
}

// ---- Class list and deleting ---------------------------------------------------------------

function studentsCard(students) {
  return h('section', { class: 'card', 'aria-labelledby': 'students-title' },
    h('div', { class: 'card__body stack' },
      h('h2', { class: 'card__section-title', id: 'students-title' }, `Registered students (${students.length})`),
      students.length === 0
        ? h('p', { class: 'card__meta' }, 'Nobody has registered yet.')
        : h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Table of registered students' }, h('table', { class: 'table' },
          h('caption', { class: 'visually-hidden' }, 'Registered students'),
          h('thead', {}, h('tr', {}, ['Name', 'Student number', 'Email', 'Registered'].map((text) => h('th', { scope: 'col' }, text)))),
          h('tbody', {}, students.map((student) => h('tr', {},
            h('td', {}, student.fullName),
            h('td', {}, student.studentNumber ?? '–'),
            h('td', {}, student.email),
            h('td', { class: 'table__nowrap' }, momentLabel(student.registeredAt)))))))));
}

function deleteCard(course) {
  const alertBox = h('div', { class: 'page-alert' });
  const button = h('button', { type: 'button', class: 'btn btn--danger' }, 'Delete course');
  button.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: `Delete ${course.code}?`,
      message: 'The course and all its lectures are deleted, which frees their rooms. This cannot be undone. A course students have registered for cannot be deleted.',
      confirmLabel: 'Delete course',
      danger: true,
    });
    if (!confirmed) {
      button.focus();
      return;
    }
    try {
      await withButtonLoading(button, deleteCourse(course.id));
      window.location.assign(`${ROUTES.adminCourses}?saved=deleted`);
    } catch (error) {
      renderAlert(alertBox, { type: 'danger', title: 'Could not delete the course', message: error.message });
      button.focus();
    }
  });
  return h('section', { class: 'card', 'aria-labelledby': 'delete-title' },
    h('div', { class: 'card__body stack' },
      h('h2', { class: 'card__section-title', id: 'delete-title' }, 'Delete'),
      alertBox,
      h('p', {}, course.seatsTaken > 0
        ? `${pluralize(course.seatsTaken, 'student is', 'students are')} registered, so this course cannot be deleted.`
        : 'Nobody has registered, so the course can be deleted.'),
      course.seatsTaken > 0 ? null : h('div', {}, button)));
}
