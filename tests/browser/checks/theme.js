// Phase 8: dark mode (following the system setting, or chosen in the footer), with axe
// contrast scans of the main pages in dark mode, and the calendar export link.
import { ACCOUNTS } from '../harness.js';

const STUDENT_PAGES = [
  ['student portal', '/pages/dashboard.html', '#dashboard-studies .stat'],
  ['campus facilities', '/pages/facilities.html', '#results article'],
  ['facility', null, '.schedule__body:not([aria-busy]) > *'],
  ['my reservations', '/pages/my-bookings.html', '.tabs__panel:not([aria-busy]) > *'],
  ['courses', '/pages/courses.html', '#courses article'],
  ['timetable', '/pages/timetable.html', '#timetable .week'],
  ['grades', '/pages/grades.html', '#grades section[data-semester-id]'],
  ['university notices', '/pages/notifications.html', '#notifications:not([aria-busy]) > *'],
];
const ADMIN_PAGES = [
  ['admin portal', '/pages/admin/dashboard.html', '#dashboard-academic .stat'],
  ['reservation approvals', '/pages/admin/requests.html', '#requests:not([aria-busy]) > *'],
  ['facility calendar', '/pages/admin/schedule.html', '#day-schedule:not([aria-busy]) > *'],
  ['facility usage reports', '/pages/admin/reports.html', '#report:not([aria-busy]) table'],
  ['admin counselling', '/pages/admin/meetings.html', '#hours-form'],
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

  // ---- Calendar export ----------------------------------------------------------------------
  await page.goto(`${t.baseUrl}/pages/timetable.html`);
  await page.waitForSelector('#timetable .week');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('a:has-text("Add to my calendar")')]);
  t.check('calendar: the timetable offers an .ics file of lectures, reservations and meetings', download.suggestedFilename() === 'campus-calendar.ics');

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
