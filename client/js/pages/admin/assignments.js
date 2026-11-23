import {
  attachmentUrl, createAssignment, deleteAssignment, getCourse, listAssignments, listSubmissions, markSubmission,
  studentSubmissionUrl,
} from '../../api/academic.js';
import { initAppShell, ROUTES } from '../../components/app-shell.js';
import {
  clearFieldErrors, confirmDialog, renderAlert, renderEmpty, renderError, renderLoading, showFieldErrors, toast,
  withButtonLoading,
} from '../../components/feedback.js';
import { campusToday, addDays } from '../../utils/campus-time.js';
import { h } from '../../utils/dom.js';
import { momentLabel } from '../../utils/format.js';

const SITE_NAME = 'Campus Facility Booking';
const root = document.getElementById('assignments-page');
const params = new URLSearchParams(window.location.search);
const courseText = params.get('course');

const user = await initAppShell({ access: 'admin' });
if (user) load();

async function load({ assignmentId = params.get('assignment'), focus } = {}) {
  if (!/^[1-9]\d{0,9}$/.test(courseText ?? '')) {
    renderEmpty(root, { title: 'Course not found', message: 'This link does not point to a course.', heading: 'h1', action: { label: 'Back to courses', href: ROUTES.adminCourses } });
    return;
  }
  renderLoading(root, 'Loading assignments…');
  try {
    const [{ course }, { assignments }] = await Promise.all([getCourse(courseText), listAssignments(courseText)]);
    const chosen = assignments.find((a) => String(a.id) === String(assignmentId)) ?? null;
    const submissions = chosen ? await listSubmissions(chosen.id) : null;
    render(course, assignments, submissions);
    if (focus) document.getElementById(focus)?.focus();
  } catch (error) {
    if (error.status === 404) renderEmpty(root, { title: 'Course not found', message: error.message, heading: 'h1', action: { label: 'Back to courses', href: ROUTES.adminCourses } });
    else renderError(root, error, { title: 'Could not load the assignments', heading: 'h1', onRetry: load });
  }
}

function render(course, assignments, submissions) {
  document.title = `Assignments: ${course.code} | ${SITE_NAME}`;
  root.replaceChildren(
    h('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' },
      h('ol', {},
        h('li', {}, h('a', { href: ROUTES.adminCourses }, 'Courses')),
        h('li', {}, h('a', { href: `${ROUTES.adminCourseForm}?id=${course.id}` }, course.code)),
        h('li', { 'aria-current': 'page' }, 'Assignments'))),
    h('header', { class: 'page-header' },
      h('div', {},
        h('h1', { class: 'page-header__title' }, `Assignments: ${course.code} ${course.title}`),
        h('p', { class: 'page-header__description' },
          'Set assignments, then download and mark what students hand in. Students can replace their file until the deadline; '
          + 'a first file after it is accepted and marked late. Marked assignments feed an assessment set to take its marks from assignments.'))),
    h('div', { class: 'stack stack--lg' },
      listCard(course, assignments),
      submissions ? submissionsCard(submissions) : null,
      newAssignmentCard(course)),
  );
}

function listCard(course, assignments) {
  const alertBox = h('div', { class: 'page-alert' });
  return h('section', { class: 'card', 'aria-labelledby': 'list-title' },
    h('div', { class: 'card__body stack' },
      h('h2', { class: 'card__section-title', id: 'list-title', tabindex: '-1' }, 'Assignments'),
      alertBox,
      assignments.length === 0 ? h('p', { class: 'card__meta' }, 'No assignments yet.')
        : h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Table of assignments' },
          h('table', { class: 'table', id: 'assignments-table' },
            h('caption', { class: 'visually-hidden' }, 'Assignments, soonest due first'),
            h('thead', {}, h('tr', {}, ['Assignment', 'Due', 'Handed in', 'Marked'].map((text) => h('th', { scope: 'col' }, text)),
              h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Actions')))),
            h('tbody', {}, assignments.map((assignment) => {
              const open = h('a', { class: 'btn btn--sm', href: `?course=${course.id}&assignment=${assignment.id}` }, 'Submissions', h('span', { class: 'visually-hidden' }, `: ${assignment.title}`));
              const remove = assignment.submitted === 0 ? h('button', { type: 'button', class: 'btn btn--sm' }, 'Delete', h('span', { class: 'visually-hidden' }, `: ${assignment.title}`)) : null;
              remove?.addEventListener('click', async () => {
                if (!await confirmDialog({ title: `Delete "${assignment.title}"?`, message: 'Nobody has handed it in. Its attached file is deleted too.', confirmLabel: 'Delete assignment', danger: true })) {
                  remove.focus();
                  return;
                }
                try {
                  await deleteAssignment(course.id, assignment.id);
                  toast('Assignment deleted.');
                  await load({ focus: 'list-title' });
                } catch (error) {
                  renderAlert(alertBox, { type: 'danger', title: 'Could not delete it', message: error.message });
                }
              });
              return h('tr', { 'data-assignment-id': assignment.id },
                h('th', { scope: 'row' }, assignment.title, h('span', { class: 'table__sub' }, `Out of ${assignment.maxPoints}`),
                  assignment.attachment ? h('a', { class: 'table__sub', href: attachmentUrl(assignment.id), download: assignment.attachment.name }, assignment.attachment.name) : null),
                h('td', { class: 'table__nowrap' }, momentLabel(assignment.dueAt), assignment.isPastDue ? h('span', { class: 'table__sub' }, 'Past due') : null),
                h('td', {}, String(assignment.submitted)),
                h('td', {}, String(assignment.marked)),
                h('td', {}, h('div', { class: 'table__actions' }, open, remove)));
            }))))));
}

function submissionsCard({ assignment, students }) {
  const handedIn = students.filter((student) => student.submission).length;
  return h('section', { class: 'card', 'aria-labelledby': 'submissions-title' },
    h('div', { class: 'card__body stack' },
      h('h2', { class: 'card__section-title', id: 'submissions-title', tabindex: '-1' }, `Submissions: ${assignment.title}`),
      h('p', {}, `${handedIn} of ${students.length} students handed it in. Due ${momentLabel(assignment.dueAt)}.`),
      students.length === 0 ? h('p', { class: 'card__meta' }, 'Nobody is registered for this course.')
        : h('ul', { class: 'stack stack--sm list-reset' }, students.map((student) => submissionRow(assignment, student)))));
}

function submissionRow(assignment, student) {
  const { submission } = student;
  const head = h('div', { class: 'card__heading' },
    h('h3', { class: 'card__title' }, student.fullName, student.studentNumber ? h('span', { class: 'table__sub' }, ` No. ${student.studentNumber}`) : null),
    submission?.isLate ? h('span', { class: 'badge badge--warning' }, 'Late') : null,
    !submission ? h('span', { class: 'badge' }, 'Not handed in') : null);
  if (!submission) return h('li', { class: 'card', 'data-student-id': student.id }, h('div', { class: 'card__body' }, head));

  const alertBox = h('div', { class: 'form__alert' });
  const id = `mark-${student.id}`;
  const form = h('form', { class: 'form', id, novalidate: true },
    alertBox,
    h('div', { class: 'form-row' },
      h('div', { class: 'field' },
        h('label', { class: 'label', for: `${id}-points` }, `Mark (out of ${assignment.maxPoints})`),
        h('input', { class: 'input input--mark', type: 'number', id: `${id}-points`, name: 'points', min: 0, max: assignment.maxPoints, step: 0.01, inputmode: 'decimal', value: submission.points ?? '' })),
      h('div', { class: 'field' },
        h('label', { class: 'label', for: `${id}-feedback` }, 'Feedback ', h('span', { class: 'label__optional' }, '(optional)')),
        h('textarea', { class: 'textarea', id: `${id}-feedback`, name: 'feedback', rows: 2, maxlength: 2000 }, submission.feedback ?? ''))),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn--primary btn--sm' }, submission.markedAt ? 'Update mark' : 'Save mark')));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    renderAlert(alertBox, {});
    const value = form.elements.points.value.trim();
    try {
      await withButtonLoading(form.querySelector('button[type=submit]'),
        markSubmission(assignment.id, student.id, { points: value === '' ? undefined : Number(value), feedback: form.elements.feedback.value.trim() || undefined }));
      toast(`Mark saved for ${student.fullName}. They are notified.`);
      await load({ assignmentId: assignment.id, focus: 'submissions-title' });
    } catch (error) {
      const unmatched = error.details ? showFieldErrors(form, error.details) : [error.message];
      if (unmatched.length > 0) renderAlert(alertBox, { type: 'danger', title: 'Could not save the mark', message: unmatched.join(' ') });
    }
  });
  return h('li', { class: 'card', 'data-student-id': student.id },
    h('div', { class: 'card__body stack stack--sm' },
      head,
      h('p', {}, h('a', { href: studentSubmissionUrl(assignment.id, student.id), download: submission.originalName }, `Download ${submission.originalName}`),
        ` · ${Math.max(1, Math.round(submission.sizeBytes / 1024))} KB · handed in ${momentLabel(submission.submittedAt)}`),
      form));
}

function newAssignmentCard(course) {
  const alertBox = h('div', { class: 'form__alert' });
  const field = (name, label, control, hint) => {
    control.id = `new-${name}`;
    control.name = name;
    return h('div', { class: 'field' }, h('label', { class: 'label', for: control.id }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
  };
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Set assignment');
  const form = h('form', { class: 'form', id: 'assignment-form', novalidate: true },
    alertBox,
    field('title', 'Title', h('input', { class: 'input', type: 'text', maxlength: 150, required: true })),
    field('instructions', 'Instructions', h('textarea', { class: 'textarea', rows: 4, maxlength: 5000, required: true }), 'What to do and what to hand in. At least 10 characters.'),
    h('div', { class: 'form-row' },
      field('dueDate', 'Due date', h('input', { class: 'input', type: 'date', required: true, value: addDays(campusToday(), 7) })),
      field('dueTime', 'Due time (KST)', h('input', { class: 'input', type: 'time', required: true, value: '23:59' })),
      field('maxPoints', 'Out of', h('input', { class: 'input', type: 'number', min: 1, max: 1000, step: 1, required: true, value: '100' }))),
    field('attachment', 'Attachment', h('input', { class: 'input', type: 'file' }), 'Optional: a handout, checked like submissions (PDF, Word, PowerPoint, ZIP, images, text), at most 10 MB.'),
    h('div', { class: 'form-actions' }, submit));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    renderAlert(alertBox, {});
    const body = new FormData();
    for (const name of ['title', 'instructions', 'dueDate', 'dueTime', 'maxPoints']) body.append(name, form.elements[name].value);
    const file = form.elements.attachment.files[0];
    if (file) body.append('attachment', file);
    try {
      await withButtonLoading(submit, createAssignment(course.id, body));
      toast('Assignment set. Students of the course see it now.');
      await load({ focus: 'list-title' });
    } catch (error) {
      const unmatched = error.details ? showFieldErrors(form, error.details) : [error.message];
      if (unmatched.length > 0) renderAlert(alertBox, { type: 'danger', title: 'Could not set the assignment', message: unmatched.join(' ') });
    }
  });
  return h('section', { class: 'card', 'aria-labelledby': 'new-assignment-title' },
    h('div', { class: 'card__body stack' },
      h('h2', { class: 'card__section-title', id: 'new-assignment-title' }, 'New assignment'),
      form));
}
