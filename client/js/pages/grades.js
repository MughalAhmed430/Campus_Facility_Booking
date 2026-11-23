import { getMyGrades } from '../api/academic.js';
import { barChart } from '../components/bar-chart.js';
import { initAppShell, ROUTES } from '../components/app-shell.js';
import { renderEmpty, renderError, renderLoading } from '../components/feedback.js';
import { gpaLabel, letterBadge, scaleTable, totalLabel } from '../components/grade-parts.js';
import { h } from '../utils/dom.js';
import { pluralize } from '../utils/format.js';

const root = document.getElementById('grades');

const user = await initAppShell({ access: 'student' });
if (user) load();

async function load() {
  root.setAttribute('aria-busy', 'true');
  renderLoading(root, 'Loading your grades…');
  try {
    render(await getMyGrades());
  } catch (error) {
    renderError(root, error, { title: 'Could not load your grades', onRetry: load });
  } finally {
    root.removeAttribute('aria-busy');
  }
}

function stat(label, value, note) {
  return h('div', { class: 'card stat' },
    h('p', { class: 'stat__label' }, label),
    h('p', { class: 'stat__value' }, value),
    note ? h('p', { class: 'stat__note' }, note) : null);
}

function render({ semesters, cgpa, creditsEarned, scale }) {
  if (semesters.length === 0) {
    renderEmpty(root, { title: 'No grades yet', message: 'Grades appear here once you take a course.', action: { label: 'Find courses', href: ROUTES.courses } });
    return;
  }
  root.replaceChildren(h('div', { class: 'stack stack--lg' },
    h('section', { 'aria-label': 'Summary' },
      h('div', { class: 'grid grid--stats' },
        stat('Overall CGPA', gpaLabel(cgpa), 'Out of 4.5, weighted by credits, completed courses only'),
        stat('Credits earned', String(creditsEarned), 'Completed courses with a passing grade'),
        stat('Semesters', String(semesters.length)))),
    semesters.some((item) => item.gpa !== null)
      ? h('section', { class: 'card', 'aria-labelledby': 'trend-title' },
        h('div', { class: 'card__body stack' },
          h('h2', { class: 'card__section-title', id: 'trend-title' }, 'GPA by semester'),
          h('p', { class: 'hint' }, 'Out of 4.5. Semesters with no completed course have none. The figures are in the table of each semester below.'),
          barChart({
            label: 'GPA by semester',
            max: 4.5,
            bars: [...semesters].reverse().map((item) => ({ label: item.semester.name, value: item.gpa ?? 0, display: gpaLabel(item.gpa) })),
          })))
      : null,
    ...semesters.map(semesterSection),
    h('section', { class: 'card', 'aria-labelledby': 'scale-title' },
      h('div', { class: 'card__body stack' },
        h('h2', { class: 'card__section-title', id: 'scale-title' }, 'How grades are calculated'),
        h('p', {}, 'Each assessment counts for its weight: a mark of 42 out of 50 in an assessment weighted 30 adds 25.2 to the course total. '
          + 'The total out of 100 gives the letter below. The GPA is the average of the grade points, weighted by credits.'),
        scaleTable(scale)))));
}

function semesterSection(item, index) {
  const id = `semester-${item.semester.id}`;
  return h('section', { class: 'card', 'aria-labelledby': id, 'data-semester-id': item.semester.id },
    h('div', { class: 'card__body stack' },
      h('div', { class: 'results-bar' },
        h('h2', { class: 'card__section-title', id }, item.semester.name, index === 0 ? h('span', { class: 'visually-hidden' }, ', latest') : null),
        h('p', { class: 'semester-gpa' }, 'Semester GPA ', h('strong', {}, gpaLabel(item.gpa)),
          ` · ${pluralize(item.creditsEarned, 'credit')} earned of ${item.credits}`)),
      h('div', { class: 'table-wrap table-wrap--stack' },
        h('table', { class: 'table table--stack', role: 'table' },
          h('caption', { class: 'visually-hidden' }, `Courses in ${item.semester.name}`),
          h('thead', { role: 'rowgroup' }, h('tr', { role: 'row' },
            ['Course', 'Marks', 'Total', 'Grade'].map((text) => h('th', { scope: 'col', role: 'columnheader' }, text)))),
          h('tbody', { role: 'rowgroup' }, item.courses.map((course) => h('tr', { role: 'row', 'data-course-code': course.course.code },
            h('td', { role: 'cell' },
              h('span', { class: 'course-card__code' }, course.course.code), ' ', course.course.title,
              h('span', { class: 'table__sub' }, pluralize(course.credits, 'credit'))),
            h('td', { role: 'cell' }, h('span', { class: 'table__label', 'aria-hidden': 'true' }, 'Marks'),
              h('ul', { class: 'mark-list list-reset' }, course.assessments.map((a) => h('li', {},
                `${a.name} (${a.weight}%): `,
                a.points === null ? h('span', { class: 'table__muted' }, 'not marked') : h('strong', {}, `${a.points} / ${a.maxPoints}`))))),
            h('td', { role: 'cell', class: 'table__nowrap' }, h('span', { class: 'table__label', 'aria-hidden': 'true' }, 'Total'), totalLabel(course)),
            h('td', { role: 'cell' }, h('span', { class: 'table__label', 'aria-hidden': 'true' }, 'Grade'), letterBadge(course)))))))));
}
