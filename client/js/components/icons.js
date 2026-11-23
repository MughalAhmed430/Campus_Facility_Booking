import { svgIcon } from '../utils/dom.js';

// A few line icons (24x24, stroked), decorative: the text next to them says the same.
const PATHS = {
  calendar: ['M7 3v3', 'M17 3v3', 'M4 8h16', 'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'],
  clock: ['M12 7v5l3 2', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
  bell: ['M6 16V11a6 6 0 1 1 12 0v5l2 2H4z', 'M10 20a2 2 0 0 0 4 0'],
  book: ['M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z', 'M4 19V5'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  check: ['M5 12l4 4 10-10'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  people: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M2 21a7 7 0 0 1 14 0', 'M17 11a3 3 0 1 0 0-6', 'M22 21a6 6 0 0 0-4-5.6'],
  building: ['M4 21V5l8-3 8 3v16', 'M9 21v-5h6v5', 'M8 8h.01', 'M12 8h.01', 'M16 8h.01', 'M8 12h.01', 'M12 12h.01', 'M16 12h.01'],
};

/** icon('calendar') -> an <svg> hidden from screen readers. */
export function icon(name, { className = 'icon' } = {}) {
  return svgIcon(PATHS[name] ?? PATHS.check, { class: className });
}
