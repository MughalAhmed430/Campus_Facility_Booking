import {
  addOfficeHours, approveMeeting, declineMeeting, listAdvisors, listMeetings, removeOfficeHours,
} from '../../api/academic.js';
import { initAppShell } from '../../components/app-shell.js';
import { WEEKDAY_NAMES, weekdayName } from '../../components/course-parts.js';
import {
  clearFieldErrors, confirmDialog, reasonDialog, renderAlert, renderEmpty, renderError, renderLoading, showFieldErrors,
  toast,
} from '../../components/feedback.js';
import { statusBadge } from '../../components/status-badge.js';
import { h } from '../../utils/dom.js';
import { dateLabel, pluralize } from '../../utils/format.js';
import { timeSteps } from '../../utils/timeline.js';

const pendingBox = document.getElementById('pending');
const pendingAlert = document.getElementById('pending-alert');
const pendingTitle = document.getElementById('pending-title');
const allBox = document.getElementById('all-meetings');
const statusSelect = document.getElementById('meeting-status');
const hoursBox = document.getElementById('office-hours');

const user = await initAppShell({ access: 'admin' });
if (user) {
  statusSelect.addEventListener('change', loadAll);
  loadPending();
  loadAll();
  loadHours();
}

// ---- Pending requests ------------------------------------------------------------------

async function loadPending() {
  pendingBox.setAttribute('aria-busy', 'true');
  renderLoading(pendingBox, 'Loading requests…');
  try {
    const { meetings } = await listMeetings({ status: 'pending' });
    renderPending(meetings);
  } catch (error) {
    renderError(pendingBox, error, { title: 'Could not load the requests', onRetry: loadPending, heading: 'h3' });
  } finally {
    pendingBox.removeAttribute('aria-busy');
  }
}

function who(meeting) {
  return `${meeting.student.fullName} with ${meeting.professor.fullName}, ${dateLabel(meeting.date)} ${meeting.startTime}–${meeting.endTime}`;
}

function renderPending(meetings) {
  if (meetings.length === 0) {
    renderEmpty(pendingBox, { title: 'No requests waiting', message: 'New meeting requests appear here.', heading: 'h3' });
    return;
  }
  const byId = new Map(meetings.map((meeting) => [meeting.id, meeting]));
  pendingBox.replaceChildren(h('ul', { class: 'stack stack--sm list-reset' }, meetings.map((meeting) => {
    const overlapping = (meeting.overlappingRequests ?? []).map((id) => byId.get(id)).filter(Boolean);
    const which = () => h('span', { class: 'visually-hidden' }, `: ${who(meeting)}`);
    const approve = h('button', { type: 'button', class: 'btn btn--primary btn--sm', disabled: !meeting.canDecide }, 'Approve', which());
    const decline = h('button', { type: 'button', class: 'btn btn--sm' }, 'Decline', which());
    approve.addEventListener('click', () => decide(meeting, overlapping, 'approve', approve));
    decline.addEventListener('click', () => decide(meeting, overlapping, 'decline', decline));
    return h('li', { class: 'card', 'data-meeting-id': meeting.id },
      h('div', { class: 'card__body stack stack--sm' },
        h('div', { class: 'card__heading' },
          h('h3', { class: 'card__title' }, `${meeting.student.fullName} → ${meeting.professor.fullName}`),
          h('span', { class: 'badge' }, meeting.categoryLabel)),
        h('p', { class: 'card__meta' }, `${dateLabel(meeting.date)}, ${meeting.startTime}–${meeting.endTime}`
          + `${meeting.location ? ` · ${meeting.location}` : ''} · ${meeting.student.studentNumber ? `No. ${meeting.student.studentNumber}` : meeting.student.email}`),
        h('p', {}, meeting.description),
        overlapping.length > 0
          ? h('p', { class: 'hint' }, `Overlaps ${pluralize(overlapping.length, 'other request')}: ${overlapping.map((other) => `${other.student.fullName} ${other.startTime}–${other.endTime}`).join(', ')}.`)
          : null,
        meeting.canDecide ? null : h('p', { class: 'hint' }, 'Its time has passed: it can only be declined.'),
        h('div', { class: 'cluster' }, decline, approve)));
  })));
}

async function decide(meeting, overlapping, action, button) {
  const approving = action === 'approve';
  const text = await reasonDialog(approving
    ? {
      title: 'Approve this meeting?',
      message: `${who(meeting)}.`,
      details: overlapping.length > 0 ? h('p', {}, `This also declines: ${overlapping.map((other) => other.student.fullName).join(', ')}.`) : null,
      label: 'Note for the student',
      hint: 'Optional. Up to 500 characters.',
      confirmLabel: 'Approve meeting',
      cancelLabel: 'Go back',
    }
    : {
      title: 'Decline this request?',
      message: `${who(meeting)}. The student sees your reason.`,
      label: 'Reason',
      required: true,
      minLength: 5,
      hint: '5 to 500 characters.',
      confirmLabel: 'Decline request',
      cancelLabel: 'Go back',
      danger: true,
    });
  if (text === null) {
    button.focus();
    return;
  }
  renderAlert(pendingAlert, {});
  try {
    if (approving) {
      const { autoDeclined } = await approveMeeting(meeting.id, { note: text || undefined });
      toast(autoDeclined.length > 0 ? `Meeting approved. ${pluralize(autoDeclined.length, 'overlapping request')} declined.` : 'Meeting approved.');
    } else {
      await declineMeeting(meeting.id, { reason: text });
      toast('Request declined.');
    }
  } catch (error) {
    renderAlert(pendingAlert, { type: 'danger', title: 'Could not save the decision', message: error.message });
  }
  await Promise.all([loadPending(), loadAll()]);
  pendingTitle.focus();
}

// ---- All meetings -------------------------------------------------------------------------

async function loadAll() {
  allBox.setAttribute('aria-busy', 'true');
  renderLoading(allBox, 'Loading meetings…');
  try {
    const status = statusSelect.value;
    const { meetings } = await listMeetings({ status: status || 'approved,completed,rejected,cancelled' });
    if (meetings.length === 0) {
      renderEmpty(allBox, { title: 'No meetings', message: 'None with this status.', heading: 'h3' });
      return;
    }
    allBox.replaceChildren(h('div', { class: 'table-wrap table-wrap--stack' },
      h('table', { class: 'table table--stack', role: 'table', id: 'meetings-table' },
        h('caption', { class: 'visually-hidden' }, 'Meetings, latest first'),
        h('thead', { role: 'rowgroup' }, h('tr', { role: 'row' },
          ['When', 'Student', 'Advisor', 'Category', 'Status'].map((text) => h('th', { scope: 'col', role: 'columnheader' }, text)))),
        h('tbody', { role: 'rowgroup' }, meetings.map((meeting) => h('tr', { role: 'row' },
          h('td', { role: 'cell', class: 'table__nowrap' }, dateLabel(meeting.date), h('span', { class: 'table__sub' }, `${meeting.startTime}–${meeting.endTime}`)),
          h('td', { role: 'cell' }, h('span', { class: 'table__label', 'aria-hidden': 'true' }, 'Student'), meeting.student.fullName),
          h('td', { role: 'cell' }, h('span', { class: 'table__label', 'aria-hidden': 'true' }, 'Advisor'), meeting.professor.fullName),
          h('td', { role: 'cell' }, h('span', { class: 'table__label', 'aria-hidden': 'true' }, 'Category'), meeting.categoryLabel),
          h('td', { role: 'cell' }, h('span', { class: 'table__label', 'aria-hidden': 'true' }, 'Status'), statusBadge(meeting.status),
            meeting.decision?.note ? h('span', { class: 'table__sub' }, meeting.decision.note) : null)))))));
  } catch (error) {
    renderError(allBox, error, { title: 'Could not load the meetings', onRetry: loadAll, heading: 'h3' });
  } finally {
    allBox.removeAttribute('aria-busy');
  }
}

// ---- Office hours ---------------------------------------------------------------------------

async function loadHours({ advisorId } = {}) {
  renderLoading(hoursBox, 'Loading office hours…');
  try {
    const { advisors } = await listAdvisors({ all: true });
    renderHours(advisors, advisorId ?? advisors[0]?.id);
  } catch (error) {
    renderError(hoursBox, error, { title: 'Could not load the office hours', onRetry: loadHours, heading: 'h3' });
  }
}

function renderHours(advisors, advisorId) {
  if (advisors.length === 0) {
    renderEmpty(hoursBox, { title: 'No professors yet', message: 'Add professors first, on the Professors page.', heading: 'h3' });
    return;
  }
  const advisor = advisors.find((item) => item.id === Number(advisorId)) ?? advisors[0];
  const picker = h('select', { class: 'select', id: 'hours-advisor' },
    advisors.map((item) => h('option', { value: item.id }, `${item.fullName} (${pluralize(item.officeHours.length, 'block')})`)));
  picker.value = String(advisor.id);
  picker.addEventListener('change', () => renderHours(advisors, picker.value));

  const alertBox = h('div', { class: 'form__alert' });
  const list = advisor.officeHours.length === 0
    ? h('p', { class: 'card__meta' }, 'No office hours: students cannot ask this professor for a meeting.')
    : h('ul', { class: 'stack stack--sm list-reset', id: 'hours-list' }, advisor.officeHours.map((hours) => {
      const label = `${weekdayName(hours.weekday)} ${hours.startTime}–${hours.endTime}, ${hours.location}`;
      const remove = h('button', { type: 'button', class: 'btn btn--sm' }, 'Remove', h('span', { class: 'visually-hidden' }, `: ${label}`));
      remove.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Remove these office hours?', message: `${advisor.fullName}: ${label}. Meetings already requested stay as they are.`, confirmLabel: 'Remove', danger: true });
        if (!ok) {
          remove.focus();
          return;
        }
        try {
          await removeOfficeHours(advisor.id, hours.id);
          toast('Office hours removed.');
          await loadHours({ advisorId: advisor.id });
          document.getElementById('hours-title').focus();
        } catch (error) {
          renderAlert(alertBox, { type: 'danger', title: 'Could not remove them', message: error.message });
        }
      });
      return h('li', { class: 'cluster' }, h('span', {}, label), remove);
    }));

  const times = timeSteps(7 * 60, 22 * 60);
  const select = (name, label, options, value) => {
    const control = h('select', { class: 'select', name, id: `hours-${name}` }, options.map(([v, text]) => h('option', { value: v }, text)));
    control.value = value;
    return h('div', { class: 'field' }, h('label', { class: 'label', for: control.id }, label), control);
  };
  const form = h('form', { class: 'form', id: 'hours-form', novalidate: true },
    alertBox,
    h('h3', { class: 'card__section-title' }, `Add office hours for ${advisor.fullName}`),
    h('div', { class: 'form-row' },
      select('weekday', 'Day', WEEKDAY_NAMES.map((name, index) => [index + 1, name]), '1'),
      select('startTime', 'From', times.map((time) => [time, time]), '13:00'),
      select('endTime', 'To', times.map((time) => [time, time]), '15:00'),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'hours-location' }, 'Where'),
        h('input', { class: 'input', type: 'text', id: 'hours-location', name: 'location', maxlength: 100, required: true, placeholder: 'ENG 405 (professor\'s office)' }))),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn--primary' }, 'Add office hours')));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    renderAlert(alertBox, {});
    const { elements } = form;
    try {
      await addOfficeHours(advisor.id, {
        weekday: Number(elements.weekday.value), startTime: elements.startTime.value, endTime: elements.endTime.value, location: elements.location.value,
      });
      toast('Office hours added.');
      await loadHours({ advisorId: advisor.id });
      document.getElementById('hours-title').focus();
    } catch (error) {
      const unmatched = error.details ? showFieldErrors(form, error.details) : [error.message];
      if (unmatched.length > 0) renderAlert(alertBox, { type: 'danger', title: 'Could not add the office hours', message: unmatched.join(' ') });
    }
  });

  hoursBox.replaceChildren(
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'hours-advisor' }, 'Professor'), picker),
    list,
    form);
}
