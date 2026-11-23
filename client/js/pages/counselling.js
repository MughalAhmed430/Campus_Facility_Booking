import {
  cancelMeeting, getAdvisorAvailability, listAdvisors, listMyMeetings, requestMeeting,
} from '../api/academic.js';
import { initAppShell } from '../components/app-shell.js';
import { professorBadge, weekdayName } from '../components/course-parts.js';
import {
  clearFieldErrors, reasonDialog, renderAlert, renderEmpty, renderError, renderLoading, showFieldErrors, toast,
  withButtonLoading,
} from '../components/feedback.js';
import { statusBadge } from '../components/status-badge.js';
import { addDays, campusToday } from '../utils/campus-time.js';
import { h } from '../utils/dom.js';
import { dateLabel, momentLabel } from '../utils/format.js';

const BOOK_AHEAD_DAYS = 60; // the same as the server
const requestBox = document.getElementById('request');
const meetingsBox = document.getElementById('meetings');
const alertBox = document.getElementById('meetings-alert');
const heading = document.getElementById('meetings-title');
let availabilityRequest = null;

const user = await initAppShell({ access: 'student' });
if (user) {
  loadForm();
  loadMeetings();
}

async function loadForm() {
  renderLoading(requestBox, 'Loading advisors…');
  try {
    renderForm(await listAdvisors());
  } catch (error) {
    renderError(requestBox, error, { title: 'Could not load the advisors', onRetry: loadForm, heading: 'h3' });
  }
}

function field(name, label, control, hint) {
  control.id = `meeting-${name}`;
  if (hint) control.setAttribute('aria-describedby', `${control.id}-hint`);
  return h('div', { class: 'field' },
    h('label', { class: 'label', for: control.id }, label),
    control,
    hint ? h('p', { class: 'hint', id: `${control.id}-hint` }, hint) : null);
}

function hoursText(advisor) {
  return advisor.officeHours.map((o) => `${weekdayName(o.weekday, { short: true })} ${o.startTime}–${o.endTime}`).join(', ');
}

function renderForm({ advisors, categories, lengths }) {
  if (advisors.length === 0) {
    renderEmpty(requestBox, { title: 'No office hours yet', message: 'No professor has office hours at the moment.', heading: 'h3' });
    return;
  }
  const formAlert = h('div', { class: 'form__alert' });
  const advisorInfo = h('div', { class: 'advisor-info', 'aria-live': 'polite' });
  const slotsBox = h('div', { class: 'field', id: 'meeting-slots' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Send request');
  const form = h('form', { class: 'form', id: 'meeting-form', novalidate: true },
    formAlert,
    h('div', { class: 'form-row' },
      field('professorId', 'Advisor', h('select', { class: 'select', name: 'professorId', required: true },
        h('option', { value: '' }, 'Choose an advisor'),
        advisors.map((advisor) => h('option', { value: advisor.id }, `${advisor.fullName}, ${advisor.department.name} (${hoursText(advisor)})`)))),
      field('date', 'Date', h('input', { class: 'input', type: 'date', name: 'date', required: true, min: campusToday(), max: addDays(campusToday(), BOOK_AHEAD_DAYS) }),
        `A day with office hours, up to ${BOOK_AHEAD_DAYS} days ahead.`)),
    advisorInfo,
    slotsBox,
    field('minutes', 'Length', h('select', { class: 'select', name: 'minutes' }, lengths.map((minutes) => h('option', { value: minutes }, `${minutes} minutes`)))),
    field('category', 'Category', h('select', { class: 'select', name: 'category', required: true },
      h('option', { value: '' }, 'Choose a category'),
      Object.entries(categories).map(([value, label]) => h('option', { value }, label)))),
    field('description', 'What would you like to talk about?', h('textarea', { class: 'textarea', name: 'description', rows: 3, maxlength: 500, required: true }),
      '10 to 500 characters. Only the academic office and the advisor see it.'),
    h('div', { class: 'form-actions' }, submit));

  const { elements } = form;
  function showSlots(message, slots = []) {
    slotsBox.replaceChildren(
      h('p', { class: 'label', id: 'meeting-slots-label' }, 'Start time'),
      slots.length === 0
        ? h('p', { class: 'hint' }, message)
        : h('div', { class: 'slot-choice', role: 'radiogroup', 'aria-labelledby': 'meeting-slots-label' },
          slots.map((slot) => h('label', { class: `slot-choice__item${slot.free ? '' : ' is-taken'}` },
            h('input', { type: 'radio', name: 'startTime', value: slot.startTime, disabled: !slot.free }),
            slot.startTime, slot.free ? null : h('span', { class: 'visually-hidden' }, ' (taken)')))),
    );
  }
  async function refreshSlots() {
    const advisor = advisors.find((item) => String(item.id) === elements.professorId.value);
    advisorInfo.replaceChildren(advisor ? h('div', { class: 'stack stack--sm' },
      professorBadge(advisor),
      h('p', { class: 'hint' }, 'Office hours: ', advisor.officeHours.map((o) => `${weekdayName(o.weekday)} ${o.startTime}–${o.endTime}, ${o.location}`).join('; '))) : '');
    if (!advisor || !elements.date.value) {
      showSlots('Choose an advisor and a date to see the free times.');
      return;
    }
    availabilityRequest?.abort();
    const controller = new AbortController();
    availabilityRequest = controller;
    showSlots('Loading free times…');
    try {
      const { slots } = await getAdvisorAvailability(advisor.id, elements.date.value, { signal: controller.signal });
      if (slots.length === 0) showSlots(`${advisor.fullName} has no office hours on ${dateLabel(elements.date.value)}. Their days: ${hoursText(advisor)}.`);
      else if (!slots.some((slot) => slot.free)) showSlots('Every time that day is taken or has passed. Choose another day.');
      else showSlots('', slots);
    } catch (error) {
      if (!controller.signal.aborted) showSlots(error.message);
    }
  }
  elements.professorId.addEventListener('change', refreshSlots);
  elements.date.addEventListener('change', refreshSlots);
  showSlots('Choose an advisor and a date to see the free times.');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    renderAlert(formAlert, {});
    const startTime = form.querySelector('input[name=startTime]:checked')?.value;
    const fields = {
      professorId: elements.professorId.value === '' ? undefined : Number(elements.professorId.value),
      date: elements.date.value || undefined,
      startTime,
      minutes: Number(elements.minutes.value),
      category: elements.category.value || undefined,
      description: elements.description.value,
    };
    try {
      await withButtonLoading(submit, requestMeeting(fields));
      toast('Meeting requested. You are told when it is decided.');
      form.reset();
      showSlots('Choose an advisor and a date to see the free times.');
      advisorInfo.replaceChildren();
      await loadMeetings();
      heading.focus();
    } catch (error) {
      // A start time problem is shown at the times (there is no single box called startTime).
      const { startTime: timeProblem, ...rest } = error.details ?? {};
      const unmatched = error.details ? showFieldErrors(form, rest) : [error.message];
      if (timeProblem) unmatched.unshift(timeProblem);
      if (unmatched.length > 0) renderAlert(formAlert, { type: 'danger', title: 'Could not send the request', message: unmatched.join(' ') });
      if (error.code === 'MEETING_CONFLICT') refreshSlots();
    }
  });

  requestBox.replaceChildren(form);
}

async function loadMeetings() {
  meetingsBox.setAttribute('aria-busy', 'true');
  renderLoading(meetingsBox, 'Loading your meetings…');
  try {
    const { meetings } = await listMyMeetings();
    renderMeetings(meetings);
  } catch (error) {
    renderError(meetingsBox, error, { title: 'Could not load your meetings', onRetry: loadMeetings, heading: 'h3' });
  } finally {
    meetingsBox.removeAttribute('aria-busy');
  }
}

const STATUS_NOTE = {
  pending: 'Waiting for the academic office.',
  approved: 'Confirmed.',
  rejected: 'Declined.',
  cancelled: 'Cancelled.',
  completed: 'Took place.',
};

function renderMeetings(meetings) {
  if (meetings.length === 0) {
    renderEmpty(meetingsBox, { title: 'No meetings yet', message: 'Requests you send appear here.', heading: 'h3' });
    return;
  }
  meetingsBox.replaceChildren(h('ul', { class: 'stack stack--sm list-reset' }, meetings.map((meeting) => {
    const cancel = meeting.canCancel ? h('button', { type: 'button', class: 'btn btn--sm' }, 'Cancel',
      h('span', { class: 'visually-hidden' }, `: meeting with ${meeting.professor.fullName}, ${dateLabel(meeting.date)} ${meeting.startTime}`)) : null;
    cancel?.addEventListener('click', () => cancelOne(meeting, cancel));
    return h('li', { class: 'card', 'data-meeting-id': meeting.id },
      h('div', { class: 'card__body stack stack--sm' },
        h('div', { class: 'card__heading' },
          h('h3', { class: 'card__title' }, `${meeting.professor.fullName}: ${meeting.categoryLabel}`),
          statusBadge(meeting.status)),
        h('p', { class: 'card__meta' }, `${dateLabel(meeting.date)}, ${meeting.startTime}–${meeting.endTime}${meeting.location ? ` · ${meeting.location}` : ''}`),
        h('p', {}, meeting.description),
        h('p', { class: 'hint' }, STATUS_NOTE[meeting.status],
          meeting.decision?.note ? ` ${meeting.status === 'rejected' ? 'Reason' : 'Note'}: ${meeting.decision.note}` : '',
          meeting.cancellation ? ` ${meeting.cancellation.byStudent ? 'By you' : 'By the academic office'}, ${momentLabel(meeting.cancellation.cancelledAt)}.` : ''),
        cancel ? h('div', {}, cancel) : null));
  })));
}

async function cancelOne(meeting, button) {
  const reason = await reasonDialog({
    title: 'Cancel this meeting?',
    message: `${meeting.professor.fullName}, ${dateLabel(meeting.date)} ${meeting.startTime}–${meeting.endTime}.`,
    label: 'Reason',
    hint: 'Optional. Up to 500 characters.',
    confirmLabel: 'Cancel meeting',
    cancelLabel: 'Keep it',
    danger: true,
  });
  if (reason === null) {
    button.focus();
    return;
  }
  renderAlert(alertBox, {});
  try {
    await cancelMeeting(meeting.id, { reason: reason || undefined });
    toast('Meeting cancelled.');
  } catch (error) {
    renderAlert(alertBox, { type: 'danger', title: 'Could not cancel the meeting', message: error.message });
  }
  await loadMeetings();
  heading.focus();
}
