import { dropCourse, listCourses, listDepartments, registerForCourse } from '../api/academic.js';
import { initAppShell } from '../components/app-shell.js';
import { professorBadge, seatsLabel, slotList } from '../components/course-parts.js';
import {
  confirmDialog, renderAlert, renderEmpty, renderError, renderLoading, toast, withButtonLoading,
} from '../components/feedback.js';
import { h } from '../utils/dom.js';
import { dateLabel, pluralize } from '../utils/format.js';

const form = document.getElementById('course-filters');
const list = document.getElementById('courses');
const countLine = document.getElementById('courses-count');
const alertBox = document.getElementById('courses-alert');
const semesterLine = document.getElementById('courses-semester');
let request = null;
let searchTimer = null;

const user = await initAppShell({ access: 'student' });
if (user) init();

async function init() {
  const params = new URLSearchParams(window.location.search);
  form.elements.q.value = params.get('q') ?? '';
  try {
    const { departments } = await listDepartments();
    form.elements.department.append(...departments.map((department) => h('option', { value: department.id }, department.name)));
    form.elements.department.value = params.get('department') ?? '';
  } catch {
    // The filter is a convenience: without the list, all departments are shown.
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    load();
  });
  form.elements.department.addEventListener('change', load);
  form.elements.q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 300);
  });
  load();
}

function filters() {
  return { q: form.elements.q.value.trim(), department: form.elements.department.value };
}

async function load() {
  const current = filters();
  const params = new URLSearchParams(Object.entries(current).filter(([, value]) => value));
  window.history.replaceState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);

  request?.abort();
  const controller = new AbortController();
  request = controller;
  list.setAttribute('aria-busy', 'true');
  renderLoading(list, 'Loading courses…');
  countLine.textContent = '';
  try {
    render(await listCourses(current, { signal: controller.signal }));
  } catch (error) {
    if (controller.signal.aborted) return;
    renderError(list, error, { title: 'Could not load the courses', onRetry: load });
  } finally {
    if (request === controller) list.removeAttribute('aria-busy');
  }
}

function render({ semester, courses }) {
  if (!semester) {
    renderEmpty(list, { title: 'No semester yet', message: 'The academic office has not set up a semester.' });
    return;
  }
  semesterLine.textContent = `${semester.name}: lectures from ${dateLabel(semester.startsOn)} to ${dateLabel(semester.endsOn)}. `
    + 'Register for a course while it has seats; drop it at any time until the semester ends. Times are Korea time (KST).';
  countLine.textContent = pluralize(courses.length, 'course');
  if (courses.length === 0) {
    renderEmpty(list, { title: 'No courses found', message: 'Try another search or department.' });
    return;
  }
  list.replaceChildren(h('ul', { class: 'grid grid--cards list-reset' }, courses.map((course) => h('li', {}, courseCard(course)))));
}

function courseCard(course) {
  return h('article', { class: 'card course-card', 'data-course-id': course.id, 'aria-labelledby': `course-${course.id}-title` },
    h('div', { class: 'card__header' },
      h('div', { class: 'card__heading' },
        h('h2', { class: 'card__title', id: `course-${course.id}-title` },
          h('span', { class: 'course-card__code' }, course.code), ' ', course.title),
        course.isRegistered ? h('span', { class: 'badge badge--approved' }, 'Registered') : null),
      h('p', { class: 'card__meta' }, `${course.department.name} · ${pluralize(course.credits, 'credit')}`)),
    h('div', { class: 'card__body stack stack--sm' },
      professorBadge(course.professor),
      slotList(course),
      course.description ? h('p', { class: 'course-card__description' }, course.description) : null,
      h('p', { class: `course-card__seats${course.seatsLeft === 0 ? ' is-full' : ''}` }, seatsLabel(course)),
      actions(course)));
}

function actions(course) {
  const which = h('span', { class: 'visually-hidden' }, `: ${course.code} ${course.title}`);
  if (course.canDrop) {
    const button = h('button', { type: 'button', class: 'btn btn--sm' }, 'Drop', which);
    button.addEventListener('click', () => drop(course, button));
    return h('div', { class: 'cluster' }, button);
  }
  if (course.canRegister) {
    const button = h('button', { type: 'button', class: 'btn btn--primary btn--sm' }, 'Register', which);
    button.addEventListener('click', () => register(course, button));
    return h('div', { class: 'cluster' }, button);
  }
  const why = !course.registrationOpen ? 'Registration has closed for this semester.' : 'No seats left.';
  return h('p', { class: 'hint' }, why);
}

async function register(course, button) {
  renderAlert(alertBox, {});
  try {
    await withButtonLoading(button, registerForCourse(course.id));
    toast(`Registered for ${course.code} ${course.title}.`);
  } catch (error) {
    renderAlert(alertBox, { type: 'danger', title: `Could not register for ${course.code}`, message: error.message });
  }
  await reloadAndFocus(course);
}

async function drop(course, button) {
  const confirmed = await confirmDialog({
    title: `Drop ${course.code}?`,
    message: `You leave ${course.code} ${course.title}, and your seat goes to whoever registers next. You can register again while it has seats.`,
    confirmLabel: 'Drop course',
    cancelLabel: 'Keep it',
    danger: true,
  });
  if (!confirmed) {
    button.focus();
    return;
  }
  renderAlert(alertBox, {});
  try {
    await dropCourse(course.id);
    toast(`Dropped ${course.code}.`);
  } catch (error) {
    renderAlert(alertBox, { type: 'danger', title: `Could not drop ${course.code}`, message: error.message });
  }
  await reloadAndFocus(course);
}

/** Reloads the list (seats change), then puts focus back on that course's card. */
async function reloadAndFocus(course) {
  await load();
  const card = list.querySelector(`[data-course-id="${course.id}"]`);
  const target = card?.querySelector('button') ?? card?.querySelector('h2');
  if (target) {
    if (target.tagName === 'H2') target.setAttribute('tabindex', '-1');
    target.focus();
  }
}
