// Phase 4: attendance on the student's timetable, with the warning below 80%, and the
// administrators' attendance page (marking a lecture and the course report).
import { ACCOUNTS } from '../harness.js';

/** @param {import('../harness.js').Harness} t */
export default async function attendance(t) {
  // ---- Student: Ali Raza is below 80% in BUS1010 --------------------------------------
  const { page } = await t.newPage({ width: 1280 });
  await t.signIn(page, ACCOUNTS.student, '/pages/timetable.html');
  await page.waitForSelector('#timetable .week');
  t.check('timetable: a warning names the course below 80%',
    /Attendance below 80%/.test(await page.textContent('#timetable .alert--warning')) && /BUS1010 \(\d+(\.\d)?%\)/.test(await page.textContent('#timetable .alert--warning')));
  const bus = page.locator('#timetable article.course-card', { hasText: 'BUS1010' });
  t.check('timetable: each course shows its rate and counts',
    /Attendance \d+(\.\d)?% · \d+ present, \d+ absent, \d+ excused/.test(await bus.locator('.attendance-line').textContent())
      && (await bus.locator('.attendance-line .badge--warning').count()) === 1);
  const cse = page.locator('#timetable article.course-card', { hasText: 'CSE2010' });
  t.check('timetable: no warning where attendance is fine', (await cse.locator('.attendance-line .badge--warning').count()) === 0);
  await t.axe(page, 'timetable with attendance');

  // ---- Administrator: BUS1010's attendance page ------------------------------------------
  const { rows: [course] } = await t.db.query("SELECT id FROM courses WHERE code = 'BUS1010'");
  const { page: admin } = await t.newPage({ width: 1280 });
  await t.signIn(admin, ACCOUNTS.admin, `/pages/admin/course-form.html?id=${course.id}`);
  await admin.waitForSelector('#slot-form');
  await Promise.all([admin.waitForURL(/attendance\.html\?course=/), admin.click('.page-header a:has-text("Attendance")')]);
  await admin.waitForSelector('#attendance-report');
  t.check('report: lowest rate first, with the warning',
    /Ali Raza/.test(await admin.textContent('#attendance-report tbody tr:first-child'))
      && /Below 80%/.test(await admin.textContent('#attendance-report tbody tr:first-child')));
  t.check('report: says how many are below 80%', /\d+ of \d+ students are below 80%/.test(await admin.textContent('section[aria-labelledby=report-title]')));
  t.check('lecture picker: latest first, with how many are marked', /\(\d+ of \d+ marked\)/.test(await admin.textContent('#session-picker option:first-child')));
  await t.axe(admin, 'admin attendance');
  await t.noHorizontalOverflow(admin, 'admin attendance @ 1280px');
  await t.screenshot(admin, 'admin-attendance-1280');

  // Mark Fatima Siddiqui excused on the second-latest lecture (fully marked in the sample data).
  const second = await admin.locator('#session-picker option').nth(1).getAttribute('value');
  await admin.selectOption('#session-picker', second);
  await admin.waitForFunction((id) => document.querySelector('#session-picker')?.value === id && document.querySelector('#attendance-form'), second);
  t.check('lecture picker: choosing one keeps it in the address bar', new URL(admin.url()).searchParams.get('session') === second);
  const fatima = admin.locator('#attendance-form li', { hasText: 'Fatima Siddiqui' });
  await fatima.getByLabel('Excused').check();
  await admin.click('#attendance-form button[type=submit]');
  await admin.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Attendance saved'));
  await admin.waitForSelector('#attendance-form');
  t.check('saved: the mark stays chosen after reloading',
    await admin.locator('#attendance-form li', { hasText: 'Fatima Siddiqui' }).getByLabel('Excused').isChecked());
  t.check('saved: the report counts it', /\b[1-9]\d*\b/.test(await admin.textContent('#attendance-report tr:has-text("Fatima Siddiqui") td:nth-of-type(3)')));

  await admin.click('#attendance-form button[type=submit]');
  await admin.waitForSelector('#attendance-alert .alert--info');
  t.check('saving with no change says so', /Nothing was changed/.test(await admin.textContent('#attendance-alert')));
  await admin.setViewportSize({ width: 390, height: 844 });
  await t.noHorizontalOverflow(admin, 'admin attendance @ 390px');
  await t.axe(admin, 'admin attendance @ 390px');
}
