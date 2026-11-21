import { professorPhotoUrl } from '../api/academic.js';
import { h } from '../utils/dom.js';
import { pluralize } from '../utils/format.js';

// Small pieces shared by the course pages (students and administrators).

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** ISO weekday (1 = Monday) -> "Monday"; short: "Mon". */
export function weekdayName(weekday, { short = false } = {}) {
  return (short ? WEEKDAY_SHORT : WEEKDAY_NAMES)[weekday - 1] ?? String(weekday);
}

/** "Mon 09:00–10:30, ENG 204" */
export function slotLabel(slot) {
  return `${weekdayName(slot.weekday, { short: true })} ${slot.startTime}–${slot.endTime}, ${slot.facility.building.code} ${slot.facility.roomNumber}`;
}

/** The lecture times as a list, or a note when there are none yet. */
export function slotList(course) {
  if (course.slots.length === 0) return h('p', { class: 'card__meta' }, 'No lecture times yet.');
  return h('ul', { class: 'course-slots list-reset', 'aria-label': 'Lectures' },
    course.slots.map((slot) => h('li', {}, slotLabel(slot))));
}

/** "12 of 40 seats left", or "Full". */
export function seatsLabel(course) {
  if (course.seatsLeft === 0) return `Full (${course.seatLimit} seats)`;
  return `${course.seatsLeft} of ${pluralize(course.seatLimit, 'seat')} left`;
}

/**
 * The professor with their photo, if there is one, and its credit under it. Initials
 * stand in for a missing photo. The photo is decorative: the name is next to it.
 */
export function professorBadge(professor, { version = '' } = {}) {
  const initials = professor.fullName.replace(/^Dr\.?\s+|^Prof\.?\s+/i, '')
    .split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
  const picture = h('span', { class: 'avatar avatar--md', 'aria-hidden': 'true' }, initials);
  if (professor.hasPhoto) {
    const img = h('img', { class: 'avatar__img', src: professorPhotoUrl(professor.id, version), alt: '' });
    img.addEventListener('error', () => img.remove());
    picture.append(img);
  }
  return h('div', { class: 'professor' },
    picture,
    h('div', {},
      h('p', { class: 'professor__name' }, professor.fullName),
      professor.photoCredit ? h('p', { class: 'professor__credit' }, `Photo: ${professor.photoCredit}`) : null));
}
