import { getCurrentUser, logout } from '../api/auth.js';
import { api } from '../api/client.js';
import { getUnreadCount } from '../api/notifications.js';
import { photoUrl } from '../api/profile.js';
import { h, svgIcon } from '../utils/dom.js';
import { renderError, toast } from './feedback.js';

export const ROUTES = {
  home: '/',
  login: '/pages/login.html',
  register: '/pages/register.html',
  facilities: '/pages/facilities.html',
  myBookings: '/pages/my-bookings.html',
  studentHome: '/pages/dashboard.html',
  adminHome: '/pages/admin/dashboard.html',
  adminRequests: '/pages/admin/requests.html',
  adminSchedule: '/pages/admin/schedule.html',
  adminBookings: '/pages/admin/bookings.html',
  adminFacilities: '/pages/admin/facilities.html',
  adminFacilityForm: '/pages/admin/facility-form.html',
  adminUsers: '/pages/admin/users.html',
  adminReports: '/pages/admin/reports.html',
  notifications: '/pages/notifications.html',
  profile: '/pages/profile.html',
  bookingPrint: '/pages/booking-print.html',
  courses: '/pages/courses.html',
  timetable: '/pages/timetable.html',
  adminCourses: '/pages/admin/courses.html',
  adminCourseForm: '/pages/admin/course-form.html',
  adminProfessors: '/pages/admin/professors.html',
  grades: '/pages/grades.html',
  transcript: '/pages/transcript.html',
  adminGradebook: '/pages/admin/gradebook.html',
  adminAttendance: '/pages/admin/attendance.html',
  counselling: '/pages/counselling.html',
  course: '/pages/course.html',
  adminAssignments: '/pages/admin/assignments.html',
  adminMeetings: '/pages/admin/meetings.html',
};

/** The printable confirmation of one booking. */
export function bookingPrintUrl(id) {
  return `${ROUTES.bookingPrint}?id=${encodeURIComponent(id)}`;
}

// Navigation per role (docs/ux-plan.md), in the university's terms. `match` marks extra
// pages that belong to an item. An item with `items` is a group: a button that opens a
// short list of links (inline in the Menu panel, a dropdown in the header).
const NAV = {
  guest: [
    { label: 'Sign in', href: ROUTES.login },
    { label: 'Register', href: ROUTES.register },
  ],
  student: [
    { label: 'My Portal', href: ROUTES.studentHome },
    { label: 'Campus Facilities', href: ROUTES.facilities, match: ['/pages/facility.html'] },
    { label: 'My Reservations', href: ROUTES.myBookings, match: [ROUTES.bookingPrint] },
    {
      label: 'Academics',
      items: [
        { label: 'Courses', href: ROUTES.courses, match: [ROUTES.course] },
        { label: 'My timetable', href: ROUTES.timetable },
        { label: 'Grades', href: ROUTES.grades, match: [ROUTES.transcript] },
        { label: 'Counselling', href: ROUTES.counselling },
      ],
    },
    { label: 'University Notices', href: ROUTES.notifications },
  ],
  admin: [
    { label: 'My Portal', href: ROUTES.adminHome },
    {
      label: 'Facilities Office',
      items: [
        { label: 'Reservation Approvals', href: ROUTES.adminRequests },
        { label: 'Facility Reservations', href: ROUTES.adminBookings, match: [ROUTES.bookingPrint] },
        { label: 'Facility Calendar', href: ROUTES.adminSchedule },
        { label: 'Campus Facilities', href: ROUTES.adminFacilities, match: [ROUTES.adminFacilityForm, '/pages/facility.html'] },
        { label: 'Facility Usage Reports', href: ROUTES.adminReports },
      ],
    },
    {
      label: 'Academic Office',
      items: [
        { label: 'Courses', href: ROUTES.adminCourses, match: [ROUTES.adminCourseForm, ROUTES.adminGradebook, ROUTES.adminAttendance, ROUTES.adminAssignments] },
        { label: 'Professors', href: ROUTES.adminProfessors },
        { label: 'Counselling', href: ROUTES.adminMeetings },
      ],
    },
    { label: 'Users', href: ROUTES.adminUsers },
  ],
};

const ROLE_LABELS = { student: 'Student', admin: 'Facilities Office' };

// Must match the breakpoint in layout.css where the navigation moves into the header.
const DESKTOP_NAV = window.matchMedia('(min-width: 64em)');

/** Where a user starts: their dashboard (the home page for a visitor who is not signed in). */
export function homeFor(user) {
  if (!user) return ROUTES.home;
  return user.role === 'admin' ? ROUTES.adminHome : ROUTES.studentHome;
}

/**
 * Returns `next` (from ?next=) only if it is a page on this site, otherwise null.
 * Without this check, a link like /pages/login.html?next=https://evil.example would
 * send the user to another site right after they sign in (an "open redirect").
 */
export function safeNextPath(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return null;
  }
  let url;
  try {
    url = new URL(next, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  if (url.pathname === ROUTES.login || url.pathname === ROUTES.register) return null;
  return url.pathname + url.search + url.hash;
}

/**
 * Renders the header and footer, loads the signed-in user and enforces page access.
 * Call it once at the top of every page script:
 *
 *   const user = await initAppShell({ access: 'student' });
 *   if (!user) return; // redirected, or an error/permission message is already shown
 *
 * access: 'public' (anyone; user may be null), 'signed-in', 'student' or 'admin'.
 */
export async function initAppShell({ access = 'public' } = {}) {
  const header = document.querySelector('[data-app-header]');
  const footer = document.querySelector('[data-app-footer]');
  const main = document.querySelector('main');
  if (footer) renderFooter(footer);
  if (header) renderHeader(header, { user: null, ready: false });
  loadBranding();

  let user;
  try {
    user = await getCurrentUser();
  } catch (error) {
    if (header) renderHeader(header, { user: null, ready: true });
    if (access === 'public') {
      toast(error.message, { type: 'error', durationMs: 8000 });
      return null;
    }
    const box = h('div', { class: 'container container--narrow' });
    main.replaceChildren(box);
    renderError(box, error, { title: 'Cannot load this page', heading: 'h1', onRetry: () => window.location.reload() });
    return null;
  }

  if (header) renderHeader(header, { user, ready: true });

  if (access !== 'public' && !user) {
    redirectToLogin();
    return null;
  }
  if ((access === 'student' || access === 'admin') && user.role !== access) {
    renderForbidden(main, user);
    return null;
  }

  // If the session ends while this page is open, any API call reports it here.
  window.addEventListener('api:unauthorized', () => redirectToLogin('expired'), { once: true });
  // Students see how many notifications are unread next to the menu link. It is a
  // convenience: if it cannot be loaded, the link simply shows no number.
  if (unreadCountEl) getUnreadCount().then(({ unreadCount }) => setUnreadCount(unreadCount)).catch(() => {});
  return user;
}

function redirectToLogin(reason) {
  const next = window.location.pathname + window.location.search;
  const params = new URLSearchParams({ next });
  if (reason) params.set('reason', reason);
  window.location.replace(`${ROUTES.login}?${params}`);
}

function renderForbidden(main, user) {
  main.replaceChildren(
    h('div', { class: 'container container--narrow' },
      h('div', { class: 'state', role: 'alert' },
        h('h1', { class: 'state__title' }, 'This page is not available to your account'),
        h('p', { class: 'state__message' },
          `You are signed in as ${ROLE_LABELS[user.role] ?? user.role}. This page is for ${user.role === 'admin' ? 'students' : 'administrators'}.`),
        h('a', { class: 'btn btn--primary', href: homeFor(user) }, 'Go to your start page'))),
  );
}

/* ---- Header -------------------------------------------------------------------- */

function renderHeader(header, { user, ready }) {
  const items = ready ? (NAV[user?.role] ?? NAV.guest) : [];
  const nav = h('nav', { id: 'primary-nav', class: 'nav', 'aria-label': 'Main' },
    h('ul', { class: 'nav__list' }, items.map((item, index) => (item.items ? navGroup(item, index) : h('li', {}, navLink(item))))),
    user ? userMenu(user) : null);

  const toggle = h('button', {
    type: 'button', class: 'nav-toggle', 'aria-expanded': 'false', 'aria-controls': 'primary-nav',
    onClick: () => setNavOpen(header, toggle, !header.classList.contains('is-nav-open')),
  }, svgIcon(['M4 6h16', 'M4 12h16', 'M4 18h16'], { class: 'nav-toggle__icon' }), 'Menu');

  header.replaceChildren(
    h('div', { class: 'app-header__inner container' },
      brand(homeFor(user)),
      ready ? toggle : null,
      nav),
  );

  header.onkeydown = (event) => {
    if (event.key === 'Escape' && header.classList.contains('is-nav-open')) {
      setNavOpen(header, toggle, false);
      toggle.focus();
    }
  };

  if (ready) {
    navState = { header, toggle };
    fitNav();
  }
}

function navLink(item) {
  return h('a', { class: 'nav__link', href: item.href, 'aria-current': isCurrent(item) ? 'page' : null },
    item.label,
    item.href === ROUTES.notifications ? unreadCountBadge() : null);
}

/**
 * A group of links behind a button (aria-expanded). Escape, or focus or a click going
 * elsewhere, closes it. The button is marked when the current page is in the group.
 */
function navGroup(group, index) {
  const listId = `nav-group-${index}`;
  const current = group.items.some(isCurrent);
  const list = h('ul', { class: 'nav__sub list-reset', id: listId, hidden: true },
    group.items.map((item) => h('li', {}, navLink(item))));
  const toggle = h('button', {
    type: 'button', class: `nav__group-toggle${current ? ' is-current' : ''}`, 'aria-expanded': 'false', 'aria-controls': listId,
  }, group.label, svgIcon(['M6 9l6 6 6-6'], { class: 'nav__chevron' }));
  const item = h('li', { class: 'nav__group' }, toggle, list);
  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
  };
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    for (const other of document.querySelectorAll('.nav__group-toggle[aria-expanded="true"]')) if (other !== toggle) other.click();
    setOpen(open);
  });
  item.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      event.stopPropagation(); // the Menu panel stays open
      setOpen(false);
      toggle.focus();
    }
  });
  item.addEventListener('focusout', (event) => {
    if (!item.contains(event.relatedTarget)) setOpen(false);
  });
  document.addEventListener('click', (event) => {
    if (!item.contains(event.target)) setOpen(false);
  });
  return item;
}

let navState = null;
let unreadCountEl = null; // the number next to "Notifications", once the header has one

function unreadCountBadge() {
  unreadCountEl = h('span', { class: 'nav__count', hidden: true });
  return unreadCountEl;
}

/**
 * Shows how many notifications are unread next to the "Notifications" menu link
 * (nothing for 0). The notifications page calls it after marking some as read.
 */
export function setUnreadCount(count) {
  if (!unreadCountEl) return;
  unreadCountEl.hidden = !(count > 0);
  unreadCountEl.replaceChildren(...(count > 0
    ? [count > 99 ? '99+' : String(count), h('span', { class: 'visually-hidden' }, ' unread')]
    : []));
  fitNav(); // the link is wider or narrower now
}
window.addEventListener('resize', () => requestAnimationFrame(fitNav));

function setNavOpen(header, toggle, open) {
  header.classList.toggle('is-nav-open', open);
  toggle.setAttribute('aria-expanded', String(open));
}

/**
 * On desktop widths, shows the navigation in the header only if it fits on one line;
 * otherwise keeps the "Menu" button (.is-compact). Measured rather than guessed, because
 * the width depends on the role's links and the length of the user's name.
 */
function fitNav() {
  if (!navState) return;
  const { header, toggle } = navState;
  header.classList.remove('is-compact');
  if (!DESKTOP_NAV.matches) return;
  const inner = header.querySelector('.app-header__inner');
  if (inner.scrollWidth > inner.clientWidth) {
    header.classList.add('is-compact');
  } else if (header.classList.contains('is-nav-open')) {
    setNavOpen(header, toggle, false); // the dropdown is no longer needed
  }
}

function isCurrent(item) {
  const path = window.location.pathname;
  return path === item.href || (item.match ?? []).includes(path);
}

// The university's logo, used with permission, is not part of the repository: it is
// copied to client/assets/brand/kdu-logo.png (see the README there). GET /api/branding
// says whether it is installed; the answer is kept for the browser session. Until then
// the header shows the project's own calendar mark and the footer has no credit line.
const BRAND_KEY = 'campus-booking:brand-logo';
let logoUrl = null;
let logoShown = false;

function loadBranding() {
  let known = null;
  try {
    known = sessionStorage.getItem(BRAND_KEY);
  } catch {
    // storage blocked: ask the server every time
  }
  const apply = (url) => {
    logoUrl = url || null;
    for (const img of document.querySelectorAll('.brand__logo')) if (logoUrl) img.src = logoUrl;
  };
  if (known !== null) {
    apply(known);
    return;
  }
  api.get('/branding').then(({ logo }) => {
    try {
      sessionStorage.setItem(BRAND_KEY, logo ?? '');
    } catch {
      // not kept; fine
    }
    apply(logo);
  }).catch(() => {});
}

function brand(href) {
  const logo = h('img', { class: 'brand__logo', alt: '' });
  if (logoUrl) logo.src = logoUrl;
  logo.addEventListener('load', () => {
    logoShown = true;
    logo.closest('.brand')?.classList.add('has-logo');
    document.querySelector('[data-footer-credit]')?.removeAttribute('hidden');
    fitNav();
  });
  // The project's own mark: deliberately not the university's logo.
  const mark = svgIcon([
    'M7 3v3', 'M17 3v3', 'M4 8h16',
    'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
    'M9 14l2 2 4-4',
  ], { class: 'brand__mark' });
  return h('a', { class: `brand${logoShown ? ' has-logo' : ''}`, href },
    logo,
    mark,
    h('span', {},
      h('span', { class: 'brand__name' }, 'Campus Facility Booking'),
      h('span', { class: 'brand__sub' }, 'Kyungdong University')));
}

function userMenu(user) {
  const signOut = h('button', {
    type: 'button', class: 'btn btn--inverse btn--sm',
    onClick: async () => {
      signOut.classList.add('is-loading');
      try {
        await logout();
        window.location.assign(ROUTES.home);
      } catch (error) {
        signOut.classList.remove('is-loading');
        toast(error.message, { type: 'error' });
      }
    },
  }, 'Sign out');

  // The name leads to the profile page, with the photo (or initials) beside it.
  const onProfile = window.location.pathname === ROUTES.profile;
  return h('div', { class: 'user-menu' },
    h('a', { class: 'user-menu__profile', href: ROUTES.profile, 'aria-current': onProfile ? 'page' : null },
      avatar(user, { size: 'sm' }),
      h('span', { class: 'user-menu__name', title: user.fullName }, user.fullName),
      h('span', { class: 'visually-hidden' }, ', my profile')),
    h('span', { class: 'role-tag' }, ROLE_LABELS[user.role] ?? user.role),
    signOut);
}

/**
 * A round profile picture: the user's photo, or their initials when they have none.
 * Decorative (the name is always next to it), so it is hidden from screen readers.
 * size: 'sm' (header) | 'lg' (profile page). version: changes the address after an upload.
 */
export function avatar(user, { size = 'sm', version = '' } = {}) {
  const initials = user.fullName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
  const box = h('span', { class: `avatar avatar--${size}`, 'aria-hidden': 'true' }, initials);
  if (user.hasPhoto) {
    const img = h('img', { class: 'avatar__img', src: photoUrl(user.id, version), alt: '' });
    img.addEventListener('error', () => img.remove()); // e.g. the file is gone: the initials stay
    box.append(img);
  }
  return box;
}

/** Replaces the header's picture and name after a profile change, without reloading. */
export function refreshHeaderUser(user, { version = '' } = {}) {
  const link = document.querySelector('.user-menu__profile');
  if (!link) return;
  link.querySelector('.avatar')?.replaceWith(avatar(user, { size: 'sm', version }));
  const name = link.querySelector('.user-menu__name');
  name.textContent = user.fullName;
  name.title = user.fullName;
  fitNav();
}

/* ---- Theme ------------------------------------------------------------------------
   System (the default) follows the device's light or dark setting; Light and Dark are
   kept for this browser. Applied as soon as this module loads, before the page renders. */
const THEME_KEY = 'campus-booking:theme';
const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];

function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
applyTheme(storedTheme());

function themePicker() {
  const select = h('select', { class: 'select select--sm', id: 'theme-picker' },
    THEMES.map(([value, label]) => h('option', { value }, label)));
  select.value = storedTheme();
  select.addEventListener('change', () => {
    try {
      if (select.value === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, select.value);
    } catch {
      // not kept for next time; it still applies now
    }
    applyTheme(select.value);
  });
  return h('div', { class: 'theme-picker' }, h('label', { for: 'theme-picker' }, 'Theme'), select);
}

/* ---- Footer -------------------------------------------------------------------- */

function renderFooter(footer) {
  footer.replaceChildren(
    h('div', { class: 'container cluster' },
      h('p', {},
        h('span', { class: 'project-label' }, 'Student project'), ' ',
        'Campus Facility Booking · Web Application Development course project. Not an official Kyungdong University service.',
        h('span', { class: 'footer-credit', 'data-footer-credit': '', hidden: !logoShown }, ' Logo and images used with permission of Kyungdong University.')),
      h('div', { class: 'cluster' }, themePicker(), h('a', { href: '/pages/style-guide.html' }, 'Design system'))),
  );
}
