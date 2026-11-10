import { createBooking, listApprovedTimes } from '../api/bookings.js';
import { campusTimeNow, campusToday, isWeekend } from '../utils/campus-time.js';
import { h } from '../utils/dom.js';
import { dateLabel, hoursLabel } from '../utils/format.js';
import {
  BOOKING_MAX_MINUTES, BOOKING_MIN_MINUTES, BOOKING_PURPOSE_MIN_LENGTH, BOOKING_TEXT_MAX_LENGTH,
} from '../utils/validation.js';
import { ROUTES } from './app-shell.js';
import { clearFieldErrors, renderAlert, showFieldErrors, withButtonLoading } from './feedback.js';

/** The form for requesting one facility. The facility must be bookable. */
export function bookingForm(facility) {
  const { capacity, openingHours } = facility;
  const alertBox = h('div', { class: 'form__alert' });
  const taken = h('p', { class: 'hint', id: 'booking-taken', 'aria-live': 'polite' });
  const submit = h('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Submit request');

  const dateField = field({
    id: 'booking-date', label: 'Date', name: 'date', type: 'date', min: campusToday(), required: true,
    hint: openingHours.openWeekends ? 'Korea time (KST).' : 'Monday to Friday, Korea time (KST).',
  });
  dateField.append(taken);

  const form = h('form', { class: 'form', id: 'booking-form', novalidate: true },
    dateField,
    h('div', { class: 'form-row' },
      field({ id: 'booking-start', label: 'Start time', name: 'startTime', type: 'time', required: true }),
      field({ id: 'booking-end', label: 'End time', name: 'endTime', type: 'time', required: true })),
    h('p', { class: 'hint' },
      `Open ${hoursLabel(openingHours)}. A booking lasts from ${BOOKING_MIN_MINUTES} minutes to ${BOOKING_MAX_MINUTES / 60} hours.`),
    field({
      id: 'booking-participants', label: 'Number of participants', name: 'participantCount', type: 'number',
      inputmode: 'numeric', min: 1, max: capacity, step: 1, required: true, hint: `Up to ${capacity}.`,
    }),
    field({
      id: 'booking-purpose', label: 'Purpose', name: 'purpose', tag: 'textarea', maxlength: BOOKING_TEXT_MAX_LENGTH,
      required: true, hint: 'What the room is for, for example "Capstone project team meeting".',
    }),
    field({ id: 'booking-notes', label: 'Notes', optional: true, name: 'notes', tag: 'textarea', maxlength: BOOKING_TEXT_MAX_LENGTH }),
    alertBox, // next to the button, so the result is on screen after submitting on a phone
    submit);

  let lookup = null;

  /** Empties the line, and stops a lookup still under way from filling it in afterwards. */
  function clearTakenTimes() {
    lookup?.abort();
    taken.textContent = '';
  }

  /** Shows the approved bookings on the chosen day, so a student can avoid them. */
  async function showTakenTimes() {
    clearTakenTimes();
    const { date } = readForm(form);
    if (!date) return;
    const controller = new AbortController();
    lookup = controller;
    taken.textContent = 'Checking booked times…';
    try {
      const { bookings } = await listApprovedTimes(facility.id, date, { signal: controller.signal });
      taken.textContent = bookings.length > 0
        ? `Already booked: ${bookings.map((slot) => `${slot.startTime}–${slot.endTime}`).join(', ')}.`
        : 'No approved bookings on this day yet.';
    } catch {
      if (!controller.signal.aborted) taken.textContent = 'Could not load the booked times for this day. You can still submit a request.';
    }
  }

  form.elements.date.addEventListener('change', showTakenTimes);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    renderAlert(alertBox, {});

    const values = readForm(form);
    const errors = validate(values, facility);
    if (Object.keys(errors).length > 0) {
      showFieldErrors(form, errors);
      return;
    }
    clearFieldErrors(form);

    try {
      await withButtonLoading(submit, createBooking({
        facilityId: facility.id,
        date: values.date,
        startTime: values.startTime,
        endTime: values.endTime,
        participantCount: Number(values.participantCount),
        purpose: values.purpose,
        notes: values.notes || undefined,
      }));
      form.reset();
      clearTakenTimes();
      showOutcome({
        type: 'success',
        title: 'Request submitted',
        message: `Your request for ${dateLabel(values.date)}, ${values.startTime}–${values.endTime} is pending. An administrator will review it.`,
        action: { label: 'See it in My bookings', href: `${ROUTES.myBookings}?tab=pending` },
      });
    } catch (error) {
      showFailure(error);
    }
  });

  /** Shows the result of submitting. It pushes the button down, so on a phone it could land off screen. */
  function showOutcome(alert) {
    renderAlert(alertBox, alert);
    alertBox.scrollIntoView({ block: 'nearest' });
  }

  function showFailure(error) {
    if (error.status === 409) {
      showOutcome({ type: 'danger', title: 'This time is not available', message: error.message });
      showTakenTimes();
      return;
    }
    // Field problems appear under the fields; anything without a field goes in the alert.
    const unmatched = error.details ? showFieldErrors(form, error.details) : [];
    if (!error.details || unmatched.length > 0) {
      showOutcome({
        type: 'danger',
        title: 'Could not submit your request',
        message: unmatched.length > 0 ? unmatched.join(' ') : error.message,
      });
    }
  }

  return form;
}

function field({ id, label, optional = false, hint, tag = 'input', ...attrs }) {
  const hintId = hint ? `${id}-hint` : null;
  return h('div', { class: 'field' },
    h('label', { class: 'label', for: id },
      label,
      optional ? ' ' : null,
      optional ? h('span', { class: 'label__optional' }, '(optional)') : null),
    h(tag, { class: tag === 'textarea' ? 'textarea' : 'input', id, 'aria-describedby': hintId, ...attrs }),
    hint ? h('p', { class: 'hint', id: hintId }, hint) : null);
}

function readForm(form) {
  const data = new FormData(form);
  const text = (name) => String(data.get(name) ?? '').trim();
  return {
    date: text('date'),
    startTime: text('startTime'),
    endTime: text('endTime'),
    participantCount: text('participantCount'),
    purpose: text('purpose'),
    notes: text('notes'),
  };
}

function minutesOf(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** The same rules as the server, checked first so mistakes show without a round trip. */
function validate({ date, startTime, endTime, participantCount, purpose, notes }, facility) {
  const { capacity, openingHours: { opensAt, closesAt, openWeekends } } = facility;
  const errors = {};
  const today = campusToday();
  const outsideHours = `Must be inside the opening hours, ${opensAt}–${closesAt}.`;

  if (!date) errors.date = 'Date is required.';
  else if (date < today) errors.date = 'Choose today or a later date.';
  else if (!openWeekends && isWeekend(date)) errors.date = 'This facility is closed on Saturdays and Sundays.';

  if (!startTime) errors.startTime = 'Start time is required.';
  else if (date === today && startTime < campusTimeNow()) errors.startTime = 'This start time has already passed. Choose a later time.';
  else if (startTime < opensAt || startTime >= closesAt) errors.startTime = outsideHours;

  if (!endTime) {
    errors.endTime = 'End time is required.';
  } else if (startTime && endTime <= startTime) {
    errors.endTime = 'End time must be after the start time.';
  } else if (startTime && minutesOf(endTime) - minutesOf(startTime) < BOOKING_MIN_MINUTES) {
    errors.endTime = `A booking must last at least ${BOOKING_MIN_MINUTES} minutes.`;
  } else if (startTime && minutesOf(endTime) - minutesOf(startTime) > BOOKING_MAX_MINUTES) {
    errors.endTime = `A booking can last at most ${BOOKING_MAX_MINUTES / 60} hours.`;
  } else if (endTime <= opensAt || endTime > closesAt) {
    errors.endTime = outsideHours;
  }

  if (!participantCount) errors.participantCount = 'Number of participants is required.';
  else if (!/^[0-9]+$/.test(participantCount) || Number(participantCount) < 1) errors.participantCount = 'Number of participants must be a whole number, at least 1.';
  else if (Number(participantCount) > capacity) errors.participantCount = `This facility holds at most ${capacity} ${capacity === 1 ? 'person' : 'people'}.`;

  if (!purpose) errors.purpose = 'Purpose is required.';
  else if (purpose.length < BOOKING_PURPOSE_MIN_LENGTH) errors.purpose = `Purpose must be at least ${BOOKING_PURPOSE_MIN_LENGTH} characters.`;
  else if (purpose.length > BOOKING_TEXT_MAX_LENGTH) errors.purpose = `Purpose must be at most ${BOOKING_TEXT_MAX_LENGTH} characters.`;

  if (notes.length > BOOKING_TEXT_MAX_LENGTH) errors.notes = `Notes must be at most ${BOOKING_TEXT_MAX_LENGTH} characters.`;

  return errors;
}
