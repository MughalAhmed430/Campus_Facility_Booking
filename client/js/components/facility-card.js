import { h } from '../utils/dom.js';
import { facilityTypeLabel, hoursLabel, locationLabel } from '../utils/format.js';
import { statusBadge } from './status-badge.js';

/** linkQuery (optional): more of the query string, e.g. "date=2026-11-12&startTime=10:00&endTime=12:00" */
export function facilityUrl(id, linkQuery = '') {
  return `/pages/facility.html?id=${encodeURIComponent(id)}${linkQuery ? `&${linkQuery}` : ''}`;
}

/**
 * A facility card for lists. The whole card is clickable (the title link covers it),
 * and it is a single stop for keyboard users. linkQuery: as for facilityUrl.
 */
export function facilityCard(facility, { linkQuery = '' } = {}) {
  return h('article', { class: 'card card--interactive' },
    h('div', { class: 'card__header' },
      h('div', { class: 'card__heading' },
        h('h3', { class: 'card__title' },
          h('a', { class: 'card__link', href: facilityUrl(facility.id, linkQuery) }, facility.name)),
        statusBadge(facility.status)),
      h('p', { class: 'card__meta' }, locationLabel(facility))),
    h('div', { class: 'card__body stack stack--sm' },
      h('ul', { class: 'facts' },
        h('li', {}, facilityTypeLabel(facility.type)),
        h('li', {}, h('strong', {}, facility.capacity), ' seats'),
        h('li', {}, 'Open ', h('strong', {}, hoursLabel(facility.openingHours)),
          facility.openingHours.openWeekends ? ' every day' : ' on weekdays')),
      facility.equipment.length > 0
        ? equipmentChips(facility.equipment)
        : h('p', { class: 'card__meta' }, 'No equipment listed')));
}

/** Equipment as chips: "Projector", "Desktop computer ×30". */
export function equipmentChips(equipment) {
  return h('ul', { class: 'chip-list', 'aria-label': 'Equipment' },
    equipment.map((item) => h('li', { class: 'chip' }, item.name, quantity(item.quantity))));
}

/** "×30" on screen, ", 30 units" for screen readers (instead of "times 30"). */
export function quantity(count) {
  if (count <= 1) return null;
  return [
    h('span', { 'aria-hidden': 'true' }, `×${count}`), // .chip already spaces its children
    h('span', { class: 'visually-hidden' }, `, ${count} units`),
  ];
}
