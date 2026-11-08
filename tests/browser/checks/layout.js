// Responsive layout from 320px to 1920px on every page, axe scans at phone and desktop
// width, the mobile filter panel, keyboard focus, and focus never hidden by the header.
// New pages: add them to PAGES.
import { ACCOUNTS, WIDTHS, waitForResults } from '../harness.js';

// ready: an element that exists once the page has rendered its content.
// path null: filled in at run time (needs a real facility id).
// path function: called for every width, returns a full URL (for single-use links).
const PAGES = [
  { label: 'home', path: '/', signedIn: false, ready: '.hero' },
  { label: 'login', path: '/pages/login.html', signedIn: false, ready: '#login-form' },
  { label: 'register', path: '/pages/register.html', signedIn: false, ready: '#register-form' },
  { label: 'style guide', path: '/pages/style-guide.html', signedIn: false, ready: '[data-check] .badge' },
  // A well-formed token that was never issued: the API answers "not valid" and the page
  // offers the form for a new link.
  { label: 'verify email (link not valid)', path: `/pages/verify-email.html?token=${'x'.repeat(43)}`, signedIn: false, ready: '#resend-form' },
  {
    label: 'verify email (confirmed)',
    path: (t) => t.freshVerificationUrl(ACCOUNTS.student.email),
    signedIn: false,
    ready: 'h1:has-text("Email address confirmed")',
  },
  { label: 'facilities', path: '/pages/facilities.html', signedIn: true, ready: '#results article' },
  { label: 'facility details', path: null, signedIn: true, ready: 'h1.page-header__title' },
  { label: 'facility not found', path: '/pages/facility.html?id=999999', signedIn: true, ready: '.state' },
];
const AXE_WIDTHS = [320, 1280];
const SCREENSHOT_WIDTHS = [320, 768, 1280, 1920];

/** @param {import('../harness.js').Harness} t */
export default async function layout(t) {
  const base = t.baseUrl;

  // Sign in once and reuse the session cookie for every signed-in page and width.
  const { context, page } = await t.newPage();
  await t.signIn(page, ACCOUNTS.student);
  await waitForResults(page);
  PAGES.find((p) => p.label === 'facility details').path =
    await page.locator('article', { hasText: 'Computer Lab A' }).locator('a').getAttribute('href');
  const cookies = await context.cookies();
  await context.close();

  for (const width of WIDTHS) {
    for (const target of PAGES) {
      const { context: ctx, page: p } = await t.newPage({ width, cookies: target.signedIn ? cookies : undefined });
      await p.goto(typeof target.path === 'function' ? await target.path(t) : `${base}${target.path}`);
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

  const stops = [];
  for (let i = 0; i < 18; i += 1) {
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
  t.check('keyboard: 18 Tab stops after main all show a focus ring', withoutRing.length === 0, JSON.stringify(withoutRing));
  t.check('keyboard: Tab order goes through the filters, then the cards',
    stops[0].id === 'filter-q' && stops.some((stop) => stop.text === 'Computer Lab A'), stops.map((stop) => stop.id || stop.text).join(' > '));
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
