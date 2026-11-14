// Responsive layout from 320px to 1920px on every page, axe scans at phone and desktop
// width, the mobile filter panel, keyboard focus, and focus never hidden by the header.
// New pages: add them to PAGES.
import { ACCOUNTS, WIDTHS, waitForResults } from '../harness.js';

// as: who is signed in (null: nobody). ready: an element that exists once the page has
// rendered its content. path null: filled in at run time (needs a real facility id).
const PAGES = [
  { label: 'home', path: '/', as: null, ready: '.hero' },
  { label: 'login', path: '/pages/login.html', as: null, ready: '#login-form' },
  { label: 'register', path: '/pages/register.html', as: null, ready: '#register-form' },
  { label: 'style guide', path: '/pages/style-guide.html', as: null, ready: '[data-check] .badge' },
  { label: 'facilities', path: '/pages/facilities.html', as: 'student', ready: '#results article' },
  { label: 'facility details', path: null, as: 'student', ready: '.schedule__body:not([aria-busy]) > *' },
  { label: 'facility not found', path: '/pages/facility.html?id=999999', as: 'student', ready: '.state' },
  { label: 'my bookings', path: '/pages/my-bookings.html', as: 'student', ready: '.tabs__panel:not([aria-busy]) > *' },
  { label: 'admin requests', path: '/pages/admin/requests.html', as: 'admin', ready: '#requests:not([aria-busy]) > *' },
  { label: 'admin bookings', path: '/pages/admin/bookings.html', as: 'admin', ready: '#bookings:not([aria-busy]) > *' },
  { label: 'admin facilities', path: '/pages/admin/facilities.html', as: 'admin', ready: '#facilities:not([aria-busy]) > *' },
  { label: 'admin facility form', path: '/pages/admin/facility-form.html', as: 'admin', ready: '#facility-form' },
  { label: 'admin users', path: '/pages/admin/users.html', as: 'admin', ready: '#users:not([aria-busy]) > *' },
  { label: 'admin schedule', path: '/pages/admin/schedule.html', as: 'admin', ready: '#day-schedule:not([aria-busy]) > *' },
];
const AXE_WIDTHS = [320, 1280];
const SCREENSHOT_WIDTHS = [320, 768, 1280, 1920];

/** @param {import('../harness.js').Harness} t */
export default async function layout(t) {
  const base = t.baseUrl;

  // Sign in once per role and reuse the session cookie for every page and width.
  const cookies = {};
  {
    const { context, page } = await t.newPage();
    await t.signIn(page, ACCOUNTS.student);
    await waitForResults(page);
    PAGES.find((p) => p.label === 'facility details').path =
      await page.locator('article', { hasText: 'Computer Lab A' }).locator('a').getAttribute('href');
    cookies.student = await context.cookies();
    await context.close();
  }
  {
    const { context, page } = await t.newPage();
    await t.signIn(page, ACCOUNTS.admin);
    cookies.admin = await context.cookies();
    await context.close();
  }

  for (const width of WIDTHS) {
    for (const target of PAGES) {
      const { context: ctx, page: p } = await t.newPage({ width, cookies: target.as ? cookies[target.as] : undefined });
      await p.goto(`${base}${target.path}`);
      await p.waitForSelector(target.ready, { state: 'attached' });
      await p.waitForSelector('.nav-toggle', { state: 'attached' }); // the header has rendered
      await p.waitForTimeout(150); // the header's fit check runs after layout
      await t.noHorizontalOverflow(p, `${target.label} @ ${width}px`);
      if (SCREENSHOT_WIDTHS.includes(width)) await t.screenshot(p, `${target.label.replace(/\s+/g, '-')}-${width}`);
      if (AXE_WIDTHS.includes(width)) await t.axe(p, `${target.label} @ ${width}px`);

      if (target.label === 'facilities' && width === 320) await mobileFilters(t, p);
      if (target.label === 'facilities' && width === 1280) await desktopKeyboard(t, p);
      await ctx.close();
    }
  }

  await focusNotObscured(t);
}

async function mobileFilters(t, page) {
  t.check('mobile: filters start collapsed', !(await page.isVisible('#filter-form')));
  t.check('mobile: toggle reports collapsed', (await page.getAttribute('#filter-toggle', 'aria-expanded')) === 'false');
  await page.focus('#filter-toggle');
  await page.keyboard.press('Enter');
  t.check('mobile: Enter on the toggle opens the filters',
    (await page.isVisible('#filter-form')) && (await page.getAttribute('#filter-toggle', 'aria-expanded')) === 'true');
  await t.noHorizontalOverflow(page, 'facilities @ 320px with filters open');
  await t.axe(page, 'facilities @ 320px with filters open');
  await t.screenshot(page, 'facilities-320-filters-open');
  await page.selectOption('#filter-type', 'laboratory');
  await page.waitForFunction(() => document.querySelectorAll('#results article').length === 4);
  t.check('mobile: toggle shows the active filter count', (await page.textContent('#filter-toggle')).includes('(1 active)'));
}

async function desktopKeyboard(t, page) {
  t.check('desktop: filter toggle hidden, panel visible', !(await page.isVisible('#filter-toggle')) && (await page.isVisible('#filter-form')));
  await page.keyboard.press('Tab');
  t.check('keyboard: first Tab reaches the skip link', await page.evaluate(() => document.activeElement.classList.contains('skip-link')));
  await page.keyboard.press('Enter');
  t.check('keyboard: skip link moves focus to main', await page.evaluate(() => document.activeElement.id === 'main'));

  // Tab through the filters to the fifth card, Computer Lab A. Date and time boxes take
  // more than one Tab stop each (day, month, year), so the number of stops is not fixed.
  const stops = [];
  for (let i = 0; i < 40 && stops.at(-1)?.text !== 'Computer Lab A'; i += 1) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => {
      const element = document.activeElement;
      const ringOn = element.closest('.card--interactive') ?? element; // cards draw the ring on the card
      const style = getComputedStyle(ringOn);
      return {
        id: element.id,
        text: (element.textContent || element.value || '').trim().slice(0, 30),
        ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2,
      };
    }));
  }
  const withoutRing = stops.filter((stop) => !stop.ring);
  t.check(`keyboard: all ${stops.length} Tab stops from main to the fifth card show a focus ring`, withoutRing.length === 0, JSON.stringify(withoutRing));
  const order = stops.map((stop) => stop.id || stop.text);
  t.check('keyboard: Tab order goes through the filters, then the cards',
    order[0] === 'filter-q' && order.at(-1) === 'Computer Lab A' && order.indexOf('filter-clear') < order.indexOf('Group Study Room A'), order.join(' > '));
}

// WCAG 2.4.11 Focus Not Obscured: moving backwards through a long form on a short
// screen must not leave the focused field under the sticky header.
async function focusNotObscured(t) {
  const { page } = await t.newPage({ width: 390, height: 500 });
  await page.goto(`${t.baseUrl}/pages/register.html`);
  await page.waitForSelector('.nav-toggle', { state: 'attached' });
  await page.focus('#register-form button[type=submit]');
  const hidden = [];
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press('Shift+Tab');
    const box = await page.evaluate(() => ({
      id: document.activeElement.id,
      top: document.activeElement.getBoundingClientRect().top,
      headerBottom: document.querySelector('.app-header').getBoundingClientRect().bottom,
    }));
    if (box.top < box.headerBottom) hidden.push(box);
  }
  t.check('keyboard: Shift+Tab never leaves the focused field under the sticky header', hidden.length === 0, JSON.stringify(hidden));
}
