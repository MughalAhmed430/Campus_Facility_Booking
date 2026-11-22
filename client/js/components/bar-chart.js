import { h } from '../utils/dom.js';
import { setVars } from '../utils/timeline.js';

// A simple horizontal bar chart in HTML and CSS (no library). It repeats a table that is
// on the page next to it, so it is hidden from screen readers: the table is the
// accessible version. Each bar is labelled with its value.
//
//   barChart({ label: 'Bookings by status', max: 20, bars: [{ label, value, display, tone }] })
//   tone (optional): a modifier for the bar's colour, e.g. 'approved', 'warning'.

export function barChart({ label, bars, max = Math.max(1, ...bars.map((bar) => bar.value)) }) {
  return h('figure', { class: 'bar-chart', 'aria-hidden': 'true', 'data-chart': label },
    h('ul', { class: 'bar-chart__list list-reset' }, bars.map((bar) => h('li', { class: 'bar-chart__row' },
      h('span', { class: 'bar-chart__label' }, bar.label),
      h('span', { class: 'bar-chart__track' },
        setVars(h('span', { class: `bar-chart__bar${bar.tone ? ` bar-chart__bar--${bar.tone}` : ''}` }),
          { '--share': max > 0 ? Math.max(0, Math.min(1, bar.value / max)) : 0 })),
      h('span', { class: 'bar-chart__value' }, bar.display ?? String(bar.value))))));
}
