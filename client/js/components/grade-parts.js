import { h } from '../utils/dom.js';

// Shared by the grade pages: how totals, GPAs and the grade scale are written.

/** 3.5625 -> "3.56"; null -> "–" */
export function gpaLabel(gpa) {
  return gpa === null || gpa === undefined ? '–' : gpa.toFixed(2);
}

/** A course total: "89.25", "25.2 so far (30% marked)" or "Not marked yet". */
export function totalLabel(result) {
  if (result.total === null) return 'Not marked yet';
  if (result.complete) return String(result.total);
  return `${result.total} so far (${result.markedWeight}% marked)`;
}

/** The letter grade as a badge, or "In progress". */
export function letterBadge(result) {
  if (!result.complete) return h('span', { class: 'badge badge--pending' }, 'In progress');
  return h('span', { class: `grade-letter${result.letter === 'F' ? ' grade-letter--fail' : ''}` }, result.letter);
}

/** The grade scale as a small table, for reference. */
export function scaleTable(scale) {
  return h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Grade scale table' },
    h('table', { class: 'table table--compact' },
      h('caption', {}, 'Grade scale (4.5)'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Grade'), h('th', { scope: 'col' }, 'Course total'), h('th', { scope: 'col' }, 'Grade points'))),
      h('tbody', {}, scale.map((grade, index) => h('tr', {},
        h('th', { scope: 'row' }, grade.letter),
        h('td', {}, index === 0 ? `${grade.min} to 100` : `${grade.min} to under ${scale[index - 1].min}`),
        h('td', {}, grade.points.toFixed(1)))))));
}
