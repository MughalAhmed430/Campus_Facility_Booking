import {
  getAttendanceReport, getSessionAttendance, listCourseSessions, saveSessionAttendance,
} from '../../api/academic.js';
import { initAppShell, ROUTES } from '../../components/app-shell.js';
import { renderAlert, renderEmpty, renderError, renderLoading, toast, withButtonLoading } from '../../components/feedback.js';
import { h } from '../../utils/dom.js';
import { dateLabel } from '../../utils/format.js';

const SITE_NAME = 'Campus Facility Booking';
const STATUSES = [['present', 'Present'], ['absent', 'Absent'], ['excused', 'Excused']];
const root = document.getElementById('attendance-page');
const params = new URLSearchParams(window.location.search);
const courseText = params.get('course');

const user = await initAppShell({ access: 'admin' });
if (user) load();

async function load({ sessionId = params.get('session'), focus } = {}) {
  if (!/^[1-9]\d{0,9}$/.test(courseText ?? '')) {
    renderEmpty(root, { title: 'Course not found', message: 'This link does not point to a course.', heading: 'h1', action: { label: 'Back to courses', href: ROUTES.adminCourses } });
    return;
  }
  renderLoading(root, 'Loading attendance…');
  try {
    const [{ course, sessions }, report] = await Promise.all([listCourseSessions(courseText), getAttendanceReport(courseText)]);
    const chosen = sessions.find((session) => String(session.id) === String(sessionId)) ?? sessions[0] ?? null;
    const roster = chosen ? await getSessionAttendance(chosen.id) : null;
    render({ course, sessions, report, roster });
    if (focus) document.getElementById(focus)?.focus();
  } catch (error) {
    if (error.status === 404) renderEmpty(root, { title: 'Course not found', message: error.message, heading: 'h1', action: { label: 'Back to courses', href: ROUTES.adminCourses } });
    else renderError(root, error, { title: 'Could not load attendance', heading: 'h1', onRetry: load });
  }
}

function render({ course, sessions, report, roster }) {
  document.title = `Attendance: ${course.code} | ${SITE_NAME}`;
  root.replaceChildren(
    h('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' },
      h('ol', {},
        h('li', {}, h('a', { href: ROUTES.adminCourses }, 'Courses')),
        h('li', {}, h('a', { href: `${ROUTES.adminCourseForm}?id=${course.id}` }, course.code)),
        h('li', { 'aria-current': 'page' }, 'Attendance'))),
    h('header', { class: 'page-header' },
      h('div', {},
        h('h1', { class: 'page-header__title' }, `Attendance: ${course.code} ${course.title}`),
        h('p', { class: 'page-header__description' },
          `Mark each registered student for a lecture that has started, and change it later if needed. The rate is present ÷ (present + absent); `
          + `excused lectures are left out. Below ${report.warningBelowPercent}% the student sees a warning.`))),
    h('div', { class: 'stack stack--lg' },
      sessionCard(course, sessions, roster),
      reportCard(report)),
  );
}

function sessionCard(course, sessions, roster) {
  if (sessions.length === 0) {
    return h('section', { class: 'card', 'aria-labelledby': 'session-title' },
      h('div', { class: 'card__body stack' },
        h('h2', { class: 'card__section-title', id: 'session-title' }, 'Take attendance'),
        h('p', { class: 'card__meta' }, 'No lecture of this course has started yet.')));
  }
  const picker = h('select', { class: 'select', id: 'session-picker', name: 'session' },
    sessions.map((session) => h('option', { value: session.id },
      `${dateLabel(session.date)}, ${session.startTime}–${session.endTime}, ${session.room} (${session.marked} of ${course.registered} marked)`)));
  picker.value = String(roster.session.id);
  picker.addEventListener('change', () => {
    window.history.replaceState(null, '', `${window.location.pathname}?course=${course.id}&session=${picker.value}`);
    load({ sessionId: picker.value, focus: 'session-picker' });
  });

  const alertBox = h('div', { class: 'page-alert', id: 'attendance-alert' });
  const form = h('form', { class: 'form', id: 'attendance-form', novalidate: true });
  if (roster.students.length === 0) {
    form.append(h('p', { class: 'card__meta' }, 'Nobody is registered for this course.'));
  } else {
    const allPresent = h('button', { type: 'button', class: 'btn btn--sm' }, 'Mark everyone not marked as present');
    allPresent.addEventListener('click', () => {
      for (const student of roster.students) {
        const group = form.querySelectorAll(`input[name="status-${student.id}"]`);
        if (![...group].some((input) => input.checked && input.value !== '')) form.querySelector(`input[name="status-${student.id}"][value="present"]`).checked = true;
      }
    });
    form.append(
      h('div', {}, allPresent),
      h('ul', { class: 'stack stack--sm list-reset' }, roster.students.map((student) => h('li', { 'data-student-id': student.id },
        h('fieldset', { class: 'fieldset' },
          h('legend', {}, student.fullName, student.studentNumber ? h('span', { class: 'table__sub' }, ` No. ${student.studentNumber}`) : null),
          h('div', { class: 'status-choice' },
            [...STATUSES, ['', 'Not marked']].map(([value, label]) => {
              const input = h('input', { type: 'radio', name: `status-${student.id}`, value, 'data-original': student.status ?? '' });
              input.checked = (student.status ?? '') === value;
              return h('label', {}, input, label);
            })))))),
      h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn--primary' }, 'Save attendance')));
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    renderAlert(alertBox, {});
    const records = roster.students.map((student) => {
      const value = form.querySelector(`input[name="status-${student.id}"]:checked`)?.value ?? '';
      return { studentId: student.id, status: value === '' ? null : value, changed: value !== (student.status ?? '') };
    }).filter((record) => record.changed).map(({ studentId, status }) => ({ studentId, status }));
    if (records.length === 0) {
      renderAlert(alertBox, { type: 'info', message: 'Nothing was changed.' });
      return;
    }
    try {
      await withButtonLoading(form.querySelector('button[type=submit]'), saveSessionAttendance(roster.session.id, records));
      toast('Attendance saved.');
      await load({ sessionId: roster.session.id, focus: 'session-picker' });
    } catch (error) {
      renderAlert(alertBox, { type: 'danger', title: 'Could not save attendance', message: error.message });
    }
  });

  return h('section', { class: 'card', 'aria-labelledby': 'session-title' },
    h('div', { class: 'card__body stack' },
      h('h2', { class: 'card__section-title', id: 'session-title' }, 'Take attendance'),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'session-picker' }, 'Lecture'), picker,
        h('p', { class: 'hint' }, 'Latest first. Only lectures that have started.')),
      alertBox,
      form));
}

function reportCard(report) {
  return h('section', { class: 'card', 'aria-labelledby': 'report-title' },
    h('div', { class: 'card__body stack' },
      h('h2', { class: 'card__section-title', id: 'report-title' }, 'Attendance report'),
      h('p', {}, report.warnings === 0
        ? `Every student is at ${report.warningBelowPercent}% or above.`
        : `${report.warnings} of ${report.students.length} students are below ${report.warningBelowPercent}%.`),
      report.students.length === 0 ? h('p', { class: 'card__meta' }, 'Nobody is registered.') : h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Table of attendance by student' },
        h('table', { class: 'table', id: 'attendance-report' },
          h('caption', { class: 'visually-hidden' }, 'Attendance by student, lowest rate first'),
          h('thead', {}, h('tr', {}, ['Student', 'Present', 'Absent', 'Excused', 'Rate'].map((text) => h('th', { scope: 'col' }, text)))),
          h('tbody', {}, report.students.map((student) => h('tr', { 'data-student-id': student.id },
            h('th', { scope: 'row' }, student.fullName),
            h('td', {}, String(student.present)),
            h('td', {}, String(student.absent)),
            h('td', {}, String(student.excused)),
            h('td', { class: 'table__nowrap' }, student.ratePercent === null ? '–' : `${student.ratePercent}%`,
              student.warning ? [' ', h('span', { class: 'badge badge--warning' }, `Below ${report.warningBelowPercent}%`)] : null))))))));
}
