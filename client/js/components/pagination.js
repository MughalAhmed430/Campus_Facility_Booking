import { h } from '../utils/dom.js';

/**
 * Previous / "Page 2 of 3" / Next, for under a list with more than one page. The button
 * that cannot be used is disabled. onChange(page) is called with the page to show; the
 * caller loads it and moves focus (the button pressed may be gone or disabled by then).
 * label: what the pages are of, for screen readers ("Pages of bookings").
 */
export function pagination({ page, totalPages, label, onChange }) {
  const step = (text, target, disabled) => h('button', {
    type: 'button', class: 'btn btn--sm', disabled, onClick: () => onChange(target),
  }, text);
  return h('nav', { class: 'pagination', 'aria-label': label },
    step('Previous page', page - 1, page <= 1),
    h('p', { class: 'pagination__status' }, `Page ${page} of ${totalPages}`),
    step('Next page', page + 1, page >= totalPages));
}
