// Phase 8: dark mode (following the system setting, or chosen in the footer), with axe
// contrast scans of the main pages in dark mode.
import { ACCOUNTS } from '../harness.js';

const STUDENT_PAGES = [
  ['student portal', '/pages/dashboard.html', '#dashboard-stats .stat'],
  ['campus facilities', '/pages/facilities.html', '#results article'],
  ['facility', null, '.schedule__body:not([aria-busy]) > *'],
  ['my reservations', '/pages/my-bookings.html', '.tabs__panel:not([aria-busy]) > *'],
  ['university notices', '/pages/notifications.html', '#notifications:not([aria-busy]) > *'],
];
const ADMIN_PAGES = [
  ['admin portal', '/pages/admin/dashboard.html', '#dashboard-stats .stat'],
  ['reservation approvals', '/pages/admin/requests.html', '#requests:not([aria-busy]) > *'],
  ['facility calendar', '/pages/admin/schedule.html', '#day-schedule:not([aria-busy]) > *'],
  ['facility usage reports', '/pages/admin/reports.html', '#report:not([aria-busy]) table'],
];

/** @param {import('../harness.js').Harness} t */
export default async function theme(t) {
  // ---- The picker -----------------------------------------------------------------------------
  const { page } = await t.newPage({ width: 1280 });
  await t.signIn(page, ACCOUNTS.student, '/pages/dashboard.html');
  await page.waitForSelector('#theme-picker');
  t.check('theme: System by default, with no data-theme', (await page.inputValue('#theme-picker')) === 'system'
    && (await page.evaluate(() => document.documentElement.dataset.theme)) === undefined);
  await page.selectOption('#theme-picker', 'dark');
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  t.check('theme: Dark applies at once', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark' && dark === 'rgb(15, 19, 24)', dark);
  await page.reload();
  await page.waitForSelector('#theme-picker');
  t.check('theme: kept after reloading', (await page.inputValue('#theme-picker')) === 'dark'
    && (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await page.selectOption('#theme-picker', 'system');
  t.check('theme: back to System', (await page.evaluate(() => document.documentElement.dataset.theme)) === undefined);

  // The header switch: one click between light and dark, named for what it will do.
  const toggle = page.locator('.app-header .theme-toggle');
  t.check('header switch: offers dark mode while the page is light', (await toggle.getAttribute('aria-label')) === 'Switch to dark mode');
  await toggle.click();
  t.check('header switch: switches to dark, and the footer picker follows',
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark' && (await page.inputValue('#theme-picker')) === 'dark'
      && (await toggle.getAttribute('aria-label')) === 'Switch to light mode');
  await toggle.click();
  t.check('header switch: and back to light', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  await page.selectOption('#theme-picker', 'system');

  // The footer: link columns for the role, the student-project label and the KST note.
  const headings = await page.locator('.app-footer .footer__heading').allTextContents();
  t.check('footer: Facilities and Preferences columns for a student', headings.join(', ') === 'Facilities, Preferences', headings.join(', '));
  t.check('footer: links to the pages of a student', (await page.locator('.app-footer a[href="/pages/my-bookings.html"]').count()) === 1);
  t.check('footer: says it is a student project, and that times are Korea time',
    /Student project/.test(await page.textContent('.app-footer')) && /All times are Korea time/.test(await page.textContent('.app-footer')));

  // ---- Every main page in dark mode (the system setting) ----------------------------------------
  const { rows: [lab] } = await t.db.query("SELECT id FROM facilities WHERE name = 'Computer Lab A'");
  for (const [role, pages, account] of [['student', STUDENT_PAGES, ACCOUNTS.student], ['admin', ADMIN_PAGES, ACCOUNTS.admin]]) {
    const { page: p } = await t.newPage({ width: 1280 });
    await p.emulateMedia({ colorScheme: 'dark' });
    await t.signIn(p, account);
    for (const [label, path, ready] of pages) {
      await p.goto(`${t.baseUrl}${path ?? `/pages/facility.html?id=${lab.id}`}`);
      await p.waitForSelector(ready);
      await t.axe(p, `dark mode: ${label}`);
    }
    await t.screenshot(p, `dark-${role}-last`);
  }
  const { page: guest } = await t.newPage({ width: 390, height: 844 });
  await guest.emulateMedia({ colorScheme: 'dark' });
  for (const [label, path, ready] of [['home', '/', '.hero'], ['sign in', '/pages/login.html', '#login-form']]) {
    await guest.goto(`${t.baseUrl}${path}`);
    await guest.waitForSelector(ready);
    await t.axe(guest, `dark mode: ${label} @ 390px`);
  }
}
