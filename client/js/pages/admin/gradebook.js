import {
  createAssessment, deleteAssessment, getGradebook, saveMarks, updateAssessment,
} from '../../api/academic.js';
import { initAppShell, ROUTES } from '../../components/app-shell.js';
import {
  clearFieldErrors, confirmDialog, renderAlert, renderEmpty, renderError, renderLoading, showFieldErrors, toast,
  withButtonLoading,
} from '../../components/feedback.js';
import { letterBadge, scaleTable, totalLabel } from '../../components/grade-parts.js';
import { h } from '../../utils/dom.js';

const SITE_NAME = 'Campus Facility Booking';
const root = document.getElementById('gradebook-page');
const courseText = new URLSearchParams(window.location.search).get('course');

const user = await initAppShell({ access: 'admin' });
if (user) load();

async function load({ focus } = {}) {
  if (!/^[1-9]\d{0,9}$/.test(courseText ?? '')) {
    renderEmpty(root, { title: 'Course not found', message: 'This link does not point to a course.', heading: 'h1', action: { label: 'Back to courses', href: ROUTES.adminCourses } });
    return;
  }
  renderLoading(root, 'Loading the gradebook…');
  try {
    render(await getGradebook(courseText));
    if (focus) document.getElementById(focus)?.focus();
  } catch (error) {
    if (error.status === 404) {
      renderEmpty(root, { title: 'Course not found', message: error.message, heading: 'h1', action: { label: 'Back to courses', href: ROUTES.adminCourses } });
    } else {
      renderError(root, error, { title: 'Could not load the gradebook', heading: 'h1', onRetry: load });
    }
  }
}

function render(book) {
  const { course } = book;
  document.title = `Gradebook: ${course.code} | ${SITE_NAME}`;
  const courseHref = `${ROUTES.adminCourseForm}?id=${course.id}`;
  root.replaceChildren(
    h('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' },
      h('ol', {},
        h('li', {}, h('a', { href: ROUTES.adminCourses }, 'Courses')),
        h('li', {}, h('a', { href: courseHref }, course.code)),
        h('li', { 'aria-current': 'page' }, 'Gradebook'))),
    h('header', { class: 'page-header' },
      h('div', {},
        h('h1', { class: 'page-header__title', id: 'gradebook-title', tabindex: '-1' }, `Gradebook: ${course.code} ${course.title}`),
        h('p', { class: 'page-header__description' },
          'Set the weighted assessments, then enter each registered student\'s marks. The total and the letter grade are '
          + 'calculated by the server; a letter appears once every assessment is marked and the weights add up to 100.'))),
    h('div', { class: 'stack stack--lg' },
      assessmentsCard(book),
      marksCard(book),
      h('details', { class: 'card' },
        h('summary', { class: 'card__body' }, 'Grade scale'),
        h('div', { class: 'card__body' }, scaleTable(book.scale)))),
  );
}

// ---- Assessments --------------------------------------------------------------------------

function assessmentsCard(book) {
  const { course, assessments, weightTotal } = book;
  const alertBox = h('div', { class: 'page-alert', id: 'assessments-alert' });
  const rows = assessments.map((assessment) => {
    const which = () => h('span', { class: 'visually-hidden' }, `: ${assessment.name}`);
    const edit = h('button', { type: 'button', class: 'btn btn--sm' }, 'Edit', which());
    edit.addEventListener('click', () => fillForEdit(assessment));
    const remove = h('button', { type: 'button', class: 'btn btn--sm' }, 'Delete', which());
    remove.addEventListener('click', () => removeAssessment(course, assessment, remove, alertBox));
    return h('tr', { 'data-assessment-id': assessment.id },
      h('th', { scope: 'row' }, assessment.name),
      h('td', {}, `${assessment.weight}%`),
      h('td', {}, String(assessment.maxPoints)),
      h('td', {}, h('div', { class: 'table__actions' }, edit, remove)));
  });

  const form = h('form', { class: 'form', id: 'assessment-form', novalidate: true },
    h('input', { type: 'hidden', name: 'assessmentId', value: '' }),
    h('h3', { class: 'card__section-title', id: 'assessment-form-title' }, 'Add an assessment'),
    h('div', { class: 'form-row' },
      labelled('name', 'Name', h('input', { class: 'input', type: 'text', name: 'name', maxlength: 60, required: true, placeholder: 'Midterm exam' })),
      labelled('weight', 'Weight (%)', h('input', { class: 'input', type: 'number', name: 'weight', min: 0.01, max: 100, step: 0.01, inputmode: 'decimal', required: true })),
      labelled('maxPoints', 'Out of', h('input', { class: 'input', type: 'number', name: 'maxPoints', min: 0.01, max: 1000, step: 0.01, inputmode: 'decimal', required: true, value: '100' }))),
    h('div', { class: 'form-actions' },
      h('button', { type: 'submit', class: 'btn btn--primary' }, 'Add assessment'),
      h('button', { type: 'button', class: 'btn', hidden: true, onClick: () => resetForm() }, 'Cancel editing')));

  function fillForEdit(assessment) {
    const { elements } = form;
    elements.assessmentId.value = assessment.id;
    elements.name.value = assessment.name;
    elements.weight.value = assessment.weight;
    elements.maxPoints.value = assessment.maxPoints;
    document.getElementById('assessment-form-title').textContent = `Edit ${assessment.name}`;
    form.querySelector('button[type=submit]').textContent = 'Save assessment';
    form.querySelector('.form-actions .btn:not(.btn--primary)').hidden = false;
    elements.name.focus();
  }
  function resetForm() {
    form.reset();
    form.elements.assessmentId.value = '';
    document.getElementById('assessment-form-title').textContent = 'Add an assessment';
    form.querySelector('button[type=submit]').textContent = 'Add assessment';
    form.querySelector('.form-actions .btn:not(.btn--primary)').hidden = true;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    renderAlert(alertBox, {});
    const { elements } = form;
    const number = (value) => (value.trim() === '' ? undefined : Number(value));
    const fields = { name: elements.name.value, weight: number(elements.weight.value), maxPoints: number(elements.maxPoints.value) };
    const id = elements.assessmentId.value;
    try {
      await withButtonLoading(form.querySelector('button[type=submit]'), id ? updateAssessment(course.id, id, fields) : createAssessment(course.id, fields));
      toast(id ? 'Assessment saved.' : 'Assessment added.');
      await load({ focus: 'assessments-title' });
    } catch (error) {
      const unmatched = error.details ? showFieldErrors(form, error.details) : [error.message];
      if (unmatched.length > 0) renderAlert(alertBox, { type: 'danger', title: 'Could not save the assessment', message: unmatched.join(' ') });
    }
  });

  const status = weightTotal === 100
    ? h('p', { class: 'alert alert--success' }, 'The weights add up to 100.')
    : h('p', { class: 'alert alert--warning' }, `The weights add up to ${weightTotal}, not 100: no letter grades until they do.`);

  return h('section', { class: 'card', 'aria-labelledby': 'assessments-title' },
    h('div', { class: 'card__body stack' },
      h('h2', { class: 'card__section-title', id: 'assessments-title', tabindex: '-1' }, 'Assessments'),
      alertBox,
      assessments.length > 0
        ? h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Table of assessments' },
          h('table', { class: 'table' },
            h('caption', { class: 'visually-hidden' }, 'Assessments'),
            h('thead', {}, h('tr', {}, ['Assessment', 'Weight', 'Out of'].map((text) => h('th', { scope: 'col' }, text)),
              h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Actions')))),
            h('tbody', {}, rows)))
        : h('p', { class: 'card__meta' }, 'No assessments yet.'),
      status,
      form));
}

function labelled(name, label, control) {
  control.id = `assessment-${name}`;
  return h('div', { class: 'field' }, h('label', { class: 'label', for: control.id }, label), control);
}

async function removeAssessment(course, assessment, button, alertBox) {
  const confirmed = await confirmDialog({
    title: `Delete ${assessment.name}?`,
    message: 'Only an assessment with no marks can be deleted.',
    confirmLabel: 'Delete assessment',
    danger: true,
  });
  if (!confirmed) {
    button.focus();
    return;
  }
  try {
    await deleteAssessment(course.id, assessment.id);
    toast('Assessment deleted.');
    await load({ focus: 'assessments-title' });
  } catch (error) {
    renderAlert(alertBox, { type: 'danger', title: 'Could not delete the assessment', message: error.message });
    button.focus();
  }
}

// ---- Marks ------------------------------------------------------------------------------

function marksCard(book) {
  const { course, assessments, students } = book;
  const alertBox = h('div', { class: 'page-alert', id: 'marks-alert' });
  if (students.length === 0 || assessments.length === 0) {
    return h('section', { class: 'card', 'aria-labelledby': 'marks-title' },
      h('div', { class: 'card__body stack' },
        h('h2', { class: 'card__section-title', id: 'marks-title' }, 'Marks'),
        h('p', { class: 'card__meta' }, students.length === 0 ? 'Nobody is registered for this course.' : 'Add an assessment first.')));
  }

  const inputName = (assessmentId, studentId) => `mark-${assessmentId}-${studentId}`;
  const form = h('form', { class: 'form', id: 'marks-form', novalidate: true },
    h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Table of marks' },
      h('table', { class: 'table gradebook' },
        h('caption', { class: 'visually-hidden' }, `Marks for ${course.code}`),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Student'),
          assessments.map((a) => h('th', { scope: 'col' }, a.name, h('span', { class: 'table__sub' }, `${a.weight}%, out of ${a.maxPoints}`))),
          h('th', { scope: 'col' }, 'Total'),
          h('th', { scope: 'col' }, 'Grade'))),
        h('tbody', {}, students.map((student) => h('tr', { 'data-student-id': student.id },
          h('th', { scope: 'row' }, student.fullName, h('span', { class: 'table__sub' }, student.studentNumber ? `No. ${student.studentNumber}` : '')),
          assessments.map((a) => {
            const value = student.marks[a.id];
            const input = h('input', {
              class: 'input input--mark', type: 'number', name: inputName(a.id, student.id), min: 0, max: a.maxPoints, step: 0.01,
              inputmode: 'decimal', 'aria-label': `${a.name}, ${student.fullName}, out of ${a.maxPoints}`,
              value: value === undefined ? '' : String(value), 'data-original': value === undefined ? '' : String(value),
            });
            return h('td', {}, h('div', { class: 'field' }, input));
          }),
          h('td', { class: 'table__nowrap' }, totalLabel(student.result)),
          h('td', {}, letterBadge(student.result))))))),
    h('div', { class: 'form-actions' },
      h('button', { type: 'submit', class: 'btn btn--primary' }, 'Save marks'),
      h('p', { class: 'hint' }, 'Leave a box empty for "not marked". Only changed marks are sent.')));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    renderAlert(alertBox, {});
    const button = form.querySelector('button[type=submit]');
    const changes = assessments.map((a) => ({
      assessment: a,
      marks: students.map((student) => ({ student, input: form.elements[inputName(a.id, student.id)] }))
        .filter(({ input }) => input.value.trim() !== input.dataset.original)
        .map(({ student, input }) => ({ studentId: student.id, points: input.value.trim() === '' ? null : Number(input.value) })),
    })).filter((change) => change.marks.length > 0);
    if (changes.length === 0) {
      renderAlert(alertBox, { type: 'info', message: 'No marks were changed.' });
      return;
    }
    button.disabled = true;
    try {
      for (const change of changes) {
        try {
          await saveMarks(course.id, change.assessment.id, change.marks);
        } catch (error) {
          // details: { "marks.<studentId>": message } -> the matching boxes of this assessment
          const details = Object.fromEntries(Object.entries(error.details ?? {})
            .map(([key, message]) => [inputName(change.assessment.id, key.replace('marks.', '')), message]));
          const unmatched = error.details ? showFieldErrors(form, details) : [error.message];
          renderAlert(alertBox, { type: 'danger', title: `Could not save the ${change.assessment.name} marks`, message: unmatched.join(' ') || 'Check the marked boxes.' });
          return;
        }
      }
      toast('Marks saved.');
      await load({ focus: 'marks-title' });
    } finally {
      button.disabled = false;
    }
  });

  return h('section', { class: 'card', 'aria-labelledby': 'marks-title' },
    h('div', { class: 'card__body stack' },
      h('h2', { class: 'card__section-title', id: 'marks-title', tabindex: '-1' }, `Marks (${students.length} students)`),
      alertBox,
      form));
}
