/**
 * Builds DOM elements without innerHTML, so text that came from the API (names,
 * purposes, notes) can never be interpreted as markup:
 *
 *   h('a', { class: 'btn btn--primary', href: '/pages/facilities.html' }, 'Browse facilities')
 *   h('button', { type: 'button', onClick: () => save() }, 'Save')
 *
 * Attribute values: true -> present, false / null / undefined -> omitted,
 * on<Event> -> event listener (functions only; inline handlers are blocked by the CSP anyway).
 * Children: strings, numbers, nodes, arrays, or null/false (skipped).
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  setAttributes(el, attrs);
  appendChildren(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An inline SVG icon from path data: svgIcon(['M4 6h16', 'M4 12h16'], { class: 'icon' }) */
export function svgIcon(paths, attrs = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  setAttributes(svg, {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', ...attrs,
  });
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function setAttributes(el, attrs) {
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === false || value === null || value === undefined) continue;
    if (name.startsWith('on')) {
      if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
      el.addEventListener(name.slice(2).toLowerCase(), value);
    } else {
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
}
