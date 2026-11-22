import { h } from '../utils/dom.js';
import { icon as iconFor } from './icons.js';

/** Shown instead of a figure that could not be loaded, or that has nothing to divide by. */
export const NO_FIGURE = '–';

/**
 * A dashboard figure that links to the page with the details. The label is the link and
 * stretches over the whole card (.card--interactive). Returns an <li> for statGrid().
 *   id     names the card for scripts and checks (data-stat)
 *   value  text; NO_FIGURE when there is none
 *   note   the line under the value: what the figure counts
 *   icon   (optional) a decorative icon name from icons.js
 */
export function statCard({ id, label, value, note, href, icon = null }) {
  return h('li', {},
    h('div', { class: 'card card--interactive stat', 'data-stat': id },
      icon ? iconFor(icon, { className: 'stat__icon' }) : null,
      h('p', { class: 'stat__label' }, h('a', { class: 'card__link', href }, label)),
      h('p', { class: 'stat__value' }, value),
      h('p', { class: 'stat__note' }, note)));
}

/** A figure whose source could not be loaded: no number rather than a wrong one. */
export function failedStatCard({ id, label, href, icon = null }) {
  return statCard({ id, label, href, icon, value: NO_FIGURE, note: 'Could not be loaded' });
}

/** The row of figures at the top of a dashboard. */
export function statGrid(cards) {
  return h('ul', { class: 'grid grid--stats list-reset' }, cards);
}
