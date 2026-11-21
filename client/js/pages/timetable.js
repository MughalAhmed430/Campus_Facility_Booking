import { getTimetable } from '../api/academic.js';
import { initAppShell, ROUTES } from '../components/app-shell.js';
import { professorBadge, slotList, weekdayName } from '../components/course-parts.js';
import { renderEmpty, renderError, renderLoading } from '../components/feedback.js';
import { h } from '../utils/dom.js';
import { dateLabel, pluralize } from '../utils/format.js';
import { assignLanes, minutesOf, setVars, timeOf } from '../utils/timeline.js';

const root = document.getElementById('timetable');
const semesterLine = document.getElementById('timetable-semester');

const user = await initAppShell({ access: 'student' });
if (user) load();

async function load() {
  root.setAttribute('aria-busy', 'true');
  renderLoading(root, 'Loading your timetable…');
  try {
    render(await getTimetable());
  } catch (error) {
    renderError(root, error, { title: 'Could not load your timetable', onRetry: load });
  } finally {
    root.removeAttribute('aria-busy');
  }
}

function render({ semester, courses, totalCredits }) {
  if (!semester) {
    renderEmpty(root, { title: 'No semester yet', message: 'The academic office has not set up a semester.' });
    return;
  }
  semesterLine.textContent = `${semester.name}, ${dateLabel(semester.startsOn)} to ${dateLabel(semester.endsOn)}. `
    + 'Your weekly lectures, Korea time (KST).';
  if (courses.length === 0) {
    renderEmpty(root, {
      title: 'No courses yet',
      message: 'You are not registered for any course this semester.',
      action: { label: 'Find courses', href: ROUTES.courses },
    });
    return;
  }
  root.replaceChildren(h('div', { class: 'stack stack--lg' },
    h('section', { class: 'card', 'aria-labelledby': 'week-title' },
      h('div', { class: 'card__body stack' },
        h('h2', { class: 'card__section-title', id: 'week-title' }, 'Week'),
        week(courses))),
    h('section', { 'aria-labelledby': 'courses-title' },
      h('div', { class: 'results-bar' },
        h('h2', { class: 'card__section-title', id: 'courses-title' }, 'My courses'),
        h('p', { class: 'timetable-total' }, `${pluralize(totalCredits, 'credit')} in ${pluralize(courses.length, 'course')}`)),
      h('ul', { class: 'grid grid--cards list-reset' }, courses.map((course) => h('li', {},
        h('article', { class: 'card course-card' },
          h('div', { class: 'card__header' },
            h('h3', { class: 'card__title' }, h('span', { class: 'course-card__code' }, course.code), ' ', course.title),
            h('p', { class: 'card__meta' }, `${course.department.name} · ${pluralize(course.credits, 'credit')}`)),
          h('div', { class: 'card__body stack stack--sm' },
            professorBadge(course.professor),
            slotList(course)))))))));
}

/** Monday to Friday (and Saturday or Sunday only when a lecture is on one), as the facility week is drawn. */
function week(courses) {
  const lectures = courses.flatMap((course) => course.slots.map((slot) => ({ course, slot })));
  const lastDay = Math.max(5, ...lectures.map(({ slot }) => slot.weekday));
  const days = Array.from({ length: lastDay }, (_, index) => index + 1);
  const rangeStart = Math.floor(Math.min(9 * 60, ...lectures.map(({ slot }) => minutesOf(slot.startTime))) / 60) * 60;
  const rangeEnd = Math.ceil(Math.max(18 * 60, ...lectures.map(({ slot }) => minutesOf(slot.endTime))) / 60) * 60;
  const hours = [];
  for (let minute = rangeStart; minute < rangeEnd; minute += 60) hours.push(minute);

  return setVars(h('div', { class: `week week--${days.length}` },
    h('div', { class: 'week__hours', 'aria-hidden': 'true' }, hours.map((minute) => h('span', {}, timeOf(minute)))),
    h('ol', { class: 'week__days list-reset' }, days.map((weekday) => {
      const blocks = lectures.filter(({ slot }) => slot.weekday === weekday)
        .map((lecture) => ({ ...lecture, start: minutesOf(lecture.slot.startTime), end: minutesOf(lecture.slot.endTime) }))
        .sort((a, b) => a.start - b.start);
      const { lanes, laneOf } = assignLanes(blocks);
      return h('li', { class: 'week__day', 'data-weekday': weekday },
        h('h3', { class: 'week__date' }, weekdayName(weekday)),
        h('div', { class: 'week__body' },
          blocks.length > 0
            ? h('ol', { class: 'week__items list-reset' }, blocks.map((block) => setVars(
              h('li', { class: 'slot slot--lecture' },
                h('span', { class: 'slot__time' }, `${block.slot.startTime}–${block.slot.endTime}`),
                ' ',
                h('span', { class: 'slot__label' }, block.course.code),
                h('span', { class: 'visually-hidden' }, `, ${block.course.title}, `),
                ' ',
                h('span', { class: 'slot__purpose' }, `${block.slot.facility.building.code} ${block.slot.facility.roomNumber}`)),
              { '--start': block.start, '--end': block.end, '--lane': laneOf.get(block), '--lanes': lanes })))
            : h('p', { class: 'week__note week__note--empty' }, 'No lectures')));
    }))),
  { '--range-start': rangeStart, '--range-span': rangeEnd - rangeStart, '--hours': hours.length });
}
