import { getCurrentUser, logout } from '../api/auth.js';
import { h, svgIcon } from '../utils/dom.js';
import { renderError, toast } from './feedback.js';

export const ROUTES = {
  home: '/',
  login: '/pages/login.html',
  register: '/pages/register.html',
  studentHome: '/pages/dashboard.html',
  adminHome: '/pages/admin/dashboard.html',
};

// Navigation per role (docs/ux-plan.md). `match` marks extra pages that belong to an item.
const NAV = {
  guest: [
    { label: 'Sign in', href: ROUTES.login },
    { label: 'Register', href: ROUTES.register },
  ],
  student: [
    { label: 'Dashboard', href: ROUTES.studentHome },
    { label: 'Facilities', href: '/pages/facilities.html', match: ['/pages/facility.html'] },
    { label: 'My bookings', href: '/pages/my-bookings.html' },
    { label: 'Notifications', href: '/pages/notifications.html' },
  ],
  admin: [
    { label: 'Dashboard', href: ROUTES.adminHome },
    { label: 'Requests', href: '/pages/admin/requests.html' },
    { label: 'Bookings', href: '/pages/admin/bookings.html' },
    { label: 'Schedule', href: '/pages/admin/schedule.html' },
    { label: 'Facilities', href: '/pages/admin/facilities.html' },
    { label: 'Users', href: '/pages/admin/users.html' },
    { label: 'Reports', href: '/pages/admin/reports.html' },
  ],
};

const ROLE_LABELS = { student: 'Student', admin: 'Admin' };

// Must match the breakpoint in layout.css where the navigation moves into the header.
const DESKTOP_NAV = window.matchMedia('(min-width: 64em)');

export function homeFor(user) {
  if (!user) return ROUTES.home;
  return user.role === 'admin' ? ROUTES.adminHome : ROUTES.studentHome;
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
    renderError(box, error, { title: 'Cannot load this page', onRetry: () => window.location.reload() });
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
  return user;
}

export function redirectToLogin(reason) {
  const next = window.location.pathname + window.location.search;
  const params = new URLSearchParams({ next });
  if (reason) params.set('reason', reason);
  window.location.replace(`${ROUTES.login}?${params}`);
}

function renderForbidden(main, user) {
  main.replaceChildren(
    h('div', { class: 'container container--narrow' },
      h('div', { class: 'state', role: 'alert' },
        h('p', { class: 'state__title' }, 'This page is not available to your account'),
        h('p', { class: 'state__message' },
          `You are signed in as ${ROLE_LABELS[user.role] ?? user.role}. This page is for ${user.role === 'admin' ? 'students' : 'administrators'}.`),
        h('a', { class: 'btn btn--primary', href: homeFor(user) }, 'Go to your dashboard'))),
  );
}

/* ---- Header -------------------------------------------------------------------- */

function renderHeader(header, { user, ready }) {
  const items = ready ? NAV[user?.role] ?? NAV.guest : [];
  const nav = h('nav', { id: 'primary-nav', class: 'nav', 'aria-label': 'Main' },
    h('ul', { class: 'nav__list' }, items.map((item) => h('li', {},
      h('a', { class: 'nav__link', href: item.href, 'aria-current': isCurrent(item) ? 'page' : null }, item.label)))),
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

let navState = null;
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

function brand(href) {
  // Simple calendar mark: deliberately not the university's logo.
  const mark = svgIcon([
    'M7 3v3', 'M17 3v3', 'M4 8h16',
    'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
    'M9 14l2 2 4-4',
  ], { class: 'brand__mark' });
  return h('a', { class: 'brand', href },
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

  return h('div', { class: 'user-menu' },
    h('span', { class: 'user-menu__name', title: user.fullName }, user.fullName),
    h('span', { class: 'role-tag' }, ROLE_LABELS[user.role] ?? user.role),
    signOut);
}

/* ---- Footer -------------------------------------------------------------------- */

function renderFooter(footer) {
  footer.replaceChildren(
    h('div', { class: 'container cluster' },
      h('p', {}, 'Campus Facility Booking · Web Application Development course project. Not an official Kyungdong University service.'),
      h('a', { href: '/pages/style-guide.html' }, 'Design system')),
  );
}
