import { attachmentUrl, getCourse, listAssignments, ownSubmissionUrl, submitAssignment } from '../api/academic.js';
import { initAppShell, ROUTES } from '../components/app-shell.js';
import { professorBadge, slotList } from '../components/course-parts.js';
import { renderAlert, renderEmpty, renderError, renderLoading, toast, withButtonLoading } from '../components/feedback.js';
import { h } from '../utils/dom.js';
import { momentLabel, pluralize } from '../utils/format.js';

const SITE_NAME = 'Campus Facility Booking';
const MAX_BYTES = 10 * 1024 * 1024; // the same as the server
const ACCEPT = '.pdf,.doc,.docx,.ppt,.pptx,.zip,.jpg,.jpeg,.png,.webp,.txt,.md,.csv,.js,.mjs,.ts,.py,.java,.c,.h,.cpp,.hpp,.cs,.go,.rs,.kt,.swift,.php,.rb,.sql,.html,.css,.json,.xml,.yml,.yaml,.sh,.ipynb';
const root = document.getElementById('course-page');
const idText = new URLSearchParams(window.location.search).get('id');

const user = await initAppShell({ access: 'student' });
if (user) load();

async function load({ focus } = {}) {
  if (!/^[1-9]\d{0,9}$/.test(idText ?? '')) {
    renderEmpty(root, { title: 'Course not found', message: 'This link does not point to a course.', heading: 'h1', action: { label: 'My timetable', href: ROUTES.timetable } });
    return;
  }
  renderLoading(root, 'Loading the course…');
  try {
    const [{ course }, { assignments }] = await Promise.all([getCourse(idText), listAssignments(idText)]);
    render(course, assignments);
    if (focus) document.getElementById(focus)?.focus();
  } catch (error) {
    if (error.status === 404) {
      renderEmpty(root, { title: 'Course not found', message: 'This is not one of your courses.', heading: 'h1', action: { label: 'My timetable', href: ROUTES.timetable } });
    } else {
      renderError(root, error, { title: 'Could not load the course', heading: 'h1', onRetry: load });
    }
  }
}

function render(course, assignments) {
  document.title = `${course.code} ${course.title} | ${SITE_NAME}`;
  root.replaceChildren(
    h('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' },
      h('ol', {}, h('li', {}, h('a', { href: ROUTES.timetable }, 'My timetable')), h('li', { 'aria-current': 'page' }, course.code))),
    h('header', { class: 'page-header' },
      h('div', {},
        h('h1', { class: 'page-header__title' }, `${course.code} ${course.title}`),
        h('p', { class: 'page-header__description' }, `${course.department.name} · ${pluralize(course.credits, 'credit')} · ${course.semester.name}`))),
    h('div', { class: 'stack stack--lg' },
      h('section', { class: 'card', 'aria-label': 'About the course' },
        h('div', { class: 'card__body stack stack--sm' },
          professorBadge(course.professor),
          slotList(course),
          course.description ? h('p', {}, course.description) : null)),
      h('section', { 'aria-labelledby': 'assignments-title' },
        h('h2', { class: 'card__section-title', id: 'assignments-title', tabindex: '-1' }, 'Assignments'),
        assignments.length === 0
          ? h('p', { class: 'card__meta' }, 'No assignments yet.')
          : h('ul', { class: 'stack list-reset' }, assignments.map(assignmentCard)))),
  );
}

function assignmentCard(assignment) {
  const submission = assignment.mySubmission;
  const alertBox = h('div', { class: 'form__alert' });
  const titleId = `assignment-${assignment.id}`;
  let form = null;
  if (assignment.canSubmit) {
    const input = h('input', { class: 'input', type: 'file', name: 'file', id: `${titleId}-file`, accept: ACCEPT, 'aria-describedby': `${titleId}-file-hint` });
    const button = h('button', { type: 'submit', class: 'btn btn--primary' }, submission ? 'Replace my file' : 'Hand in');
    form = h('form', { class: 'form', novalidate: true, 'data-assignment-form': assignment.id },
      alertBox,
      h('div', { class: 'field' },
        h('label', { class: 'label', for: input.id }, submission ? 'Replace with another file' : 'Your file'),
        input,
        h('p', { class: 'hint', id: `${titleId}-file-hint` },
          `One file: PDF, Word, PowerPoint, ZIP, an image or a source/text file, at most 10 MB. `
          + (assignment.isPastDue ? 'The deadline has passed: it will be marked late, and cannot be replaced.' : 'You can replace it until the deadline.'))),
      h('div', { class: 'form-actions' }, button));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      renderAlert(alertBox, {});
      const file = input.files[0];
      if (!file) return renderAlert(alertBox, { type: 'danger', message: 'Choose a file first.' });
      if (file.size > MAX_BYTES) return renderAlert(alertBox, { type: 'danger', message: 'The file must be at most 10 MB.' });
      try {
        const { assignment: saved } = await withButtonLoading(button, submitAssignment(assignment.id, file));
        toast(saved.mySubmission.isLate ? 'Handed in, after the deadline: marked late.' : 'Handed in.');
        await load({ focus: titleId });
      } catch (error) {
        renderAlert(alertBox, { type: 'danger', title: 'Could not hand it in', message: error.details?.file ?? error.message });
      }
      return undefined;
    });
  }

  return h('li', { class: 'card', 'data-assignment-id': assignment.id },
    h('article', { class: 'card__body stack stack--sm', 'aria-labelledby': titleId },
      h('div', { class: 'card__heading' },
        h('h3', { class: 'card__title', id: titleId, tabindex: '-1' }, assignment.title),
        submission?.markedAt ? h('span', { class: 'badge badge--approved' }, 'Marked')
          : submission ? h('span', { class: 'badge badge--completed' }, 'Handed in')
            : assignment.isPastDue ? h('span', { class: 'badge badge--rejected' }, 'Not handed in, past due')
              : h('span', { class: 'badge badge--pending' }, 'To do')),
      h('p', { class: 'card__meta' }, `Due ${momentLabel(assignment.dueAt)} (Korea time) · out of ${assignment.maxPoints}`),
      h('p', { class: 'assignment__instructions' }, assignment.instructions),
      assignment.attachment
        ? h('p', {}, h('a', { href: attachmentUrl(assignment.id), download: assignment.attachment.name }, `Download ${assignment.attachment.name}`))
        : null,
      submission
        ? h('div', { class: 'submission' },
          h('p', {}, 'Your file: ', h('a', { href: ownSubmissionUrl(assignment.id), download: submission.originalName }, submission.originalName),
            ` · handed in ${momentLabel(submission.submittedAt)}`,
            submission.isLate ? [' ', h('span', { class: 'badge badge--warning' }, 'Late')] : null),
          submission.markedAt
            ? h('p', { class: 'submission__mark' }, 'Mark: ', h('strong', {}, `${submission.points} / ${assignment.maxPoints}`),
              submission.feedback ? h('span', { class: 'submission__feedback' }, `Feedback: ${submission.feedback}`) : null)
            : null)
        : null,
      assignment.why ? h('p', { class: 'hint' }, assignment.why) : null,
      form));
}
