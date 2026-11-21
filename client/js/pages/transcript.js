import { getMyGrades } from '../api/academic.js';
import { initAppShell, ROUTES } from '../components/app-shell.js';
import { renderError, renderLoading } from '../components/feedback.js';
import { gpaLabel } from '../components/grade-parts.js';
import { h } from '../utils/dom.js';
import { momentLabel } from '../utils/format.js';

// The student's own transcript, to print. Completed courses show their grade; courses
// still in progress are listed as such and never with a provisional mark.

const container = document.getElementById('transcript');

const user = await initAppShell({ access: 'student' });
if (user) load();

async function load() {
  renderLoading(container, 'Loading your transcript…');
  try {
    render(await getMyGrades());
  } catch (error) {
    renderError(container, error, { title: 'Could not load your transcript', heading: 'h1', onRetry: load });
  }
}

function render({ semesters, cgpa, creditsEarned }) {
  const sample = semesters.some((item) => /\(sample\)/.test(item.semester.name));
  container.replaceChildren(
    h('div', { class: 'print-actions no-print' },
      h('a', { class: 'btn', href: ROUTES.grades }, 'Back to My grades'),
      h('button', { type: 'button', class: 'btn btn--primary', onClick: () => window.print() }, 'Print')),
    h('article', { class: 'card print-record transcript', 'aria-labelledby': 'transcript-title' },
      h('div', { class: 'card__body stack' },
        h('header', { class: 'print-record__header' },
          h('div', {},
            h('p', { class: 'print-record__issuer' }, 'Campus Facility Booking · Kyungdong University'),
            h('h1', { class: 'print-record__title', id: 'transcript-title' }, 'Academic transcript')),
          h('div', { class: 'print-record__reference' },
            h('span', { class: 'print-record__reference-label' }, 'CGPA'),
            h('span', { class: 'print-record__reference-value' }, `${gpaLabel(cgpa)} / 4.5`))),
        h('dl', { class: 'details-list' },
          h('div', {}, h('dt', {}, 'Student'), h('dd', {}, user.fullName)),
          user.studentNumber ? h('div', {}, h('dt', {}, 'Student number'), h('dd', {}, user.studentNumber)) : null,
          h('div', {}, h('dt', {}, 'Credits earned'), h('dd', {}, String(creditsEarned)))),
        sample ? h('p', { class: 'alert alert--warning print-record__notice' }, 'SAMPLE DATA: these courses and grades were entered for a demonstration.') : null,
        semesters.length === 0 ? h('p', {}, 'No courses yet.') : null,
        ...semesters.map((item) => h('section', { class: 'transcript__semester', 'aria-labelledby': `t-${item.semester.id}` },
          h('h2', { class: 'card__section-title', id: `t-${item.semester.id}` }, item.semester.name),
          h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': `Table of courses in ${item.semester.name}` }, h('table', { class: 'table table--compact' },
            h('caption', { class: 'visually-hidden' }, `Courses in ${item.semester.name}`),
            h('thead', {}, h('tr', {}, ['Code', 'Course', 'Credits', 'Grade', 'Points'].map((text) => h('th', { scope: 'col' }, text)))),
            h('tbody', {}, item.courses.map((course) => h('tr', {},
              h('td', {}, course.course.code),
              h('td', {}, course.course.title),
              h('td', {}, String(course.credits)),
              h('td', {}, course.complete ? course.letter : 'In progress'),
              h('td', {}, course.complete ? course.gradePoints.toFixed(1) : '–')))),
            h('tfoot', {}, h('tr', {},
              h('th', { scope: 'row', colspan: 4 }, 'Semester GPA'),
              h('td', {}, gpaLabel(item.gpa)))))))),
        h('p', { class: 'print-record__footer' },
          `Printed ${momentLabel(new Date().toISOString())} (Korea time). Student course project: not an official Kyungdong University transcript.`))),
  );
}
