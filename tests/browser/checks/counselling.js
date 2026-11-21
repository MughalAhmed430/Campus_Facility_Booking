// Phase 6: a student requests a meeting inside an advisor's office hours and cancels it;
// the academic office approves one of two overlapping requests (the other is declined)
// and manages office hours.
const PASSWORD = 'Student@2026';
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;

/** The first date at least 3 days ahead on ISO weekday `weekday`, in Korea. */
function nextWeekday(weekday) {
  let time = Date.now() + KST_MS + 3 * DAY_MS;
  while ((new Date(time).getUTCDay() || 7) !== weekday) time += DAY_MS;
  return new Date(time).toISOString().slice(0, 10);
}

/** @param {import('../harness.js').Harness} t */
export default async function counselling(t) {
  await t.db.query(
    `INSERT INTO users (full_name, email, password_hash, role, student_number)
     VALUES ('Counsel Nu', 'counsel.nu@kdu.example', crypt($1, gen_salt('bf', 4)), 'student', '765432')`,
    [PASSWORD],
  );

  const professorId = async (name) => String((await t.db.query('SELECT id FROM professors WHERE full_name = $1', [name])).rows[0].id);

  // ---- Student: request, then cancel ------------------------------------------------------
  const { page } = await t.newPage({ width: 1280 });
  await t.signIn(page, { email: 'counsel.nu@kdu.example', password: PASSWORD }, '/pages/courses.html');
  await page.waitForSelector('#courses article');
  await page.click('.page-header a[href="/pages/counselling.html"]');
  await page.waitForSelector('#meeting-form');
  t.check('counselling: reached from Courses, which stays current in the menu',
    (await page.getAttribute('.nav__link[href="/pages/courses.html"]', 'aria-current')) === 'page');
  t.check('counselling: no meetings yet', /No meetings yet/.test(await page.textContent('#meetings')));
  await t.axe(page, 'counselling');
  await t.noHorizontalOverflow(page, 'counselling @ 1280px');

  await page.selectOption('#meeting-professorId', await professorId('Dr. Yoon Tae-hee'));
  t.check('advisor: the office hours and place are shown', /Thursday 10:00–12:00, HUM 214/.test(await page.textContent('.advisor-info')));
  const thursday = nextWeekday(4);
  await page.fill('#meeting-date', thursday);
  await page.dispatchEvent('#meeting-date', 'change');
  await page.waitForSelector('.slot-choice');
  t.check('free times: every 30 minutes inside the office hours',
    JSON.stringify(await page.$$eval('.slot-choice input', (inputs) => inputs.map((input) => input.value))) === '["10:00","10:30","11:00","11:30"]');
  await t.axe(page, 'counselling with free times');

  await page.fill('#meeting-date', nextWeekday(1));
  await page.dispatchEvent('#meeting-date', 'change');
  await page.waitForFunction(() => /has no office hours on/.test(document.getElementById('meeting-slots').textContent));
  t.check('free times: a day without office hours says which days have them', /Their days: Thu 10:00–12:00/.test(await page.textContent('#meeting-slots')));

  await page.fill('#meeting-date', thursday);
  await page.dispatchEvent('#meeting-date', 'change');
  await page.waitForSelector('.slot-choice');
  await page.click('button[type=submit]:has-text("Send request")');
  await page.waitForSelector('#meeting-form .alert--danger');
  t.check('request: missing fields are reported', /Choose a time|Start time is required/.test(await page.textContent('#meeting-form .alert--danger'))
    && (await page.getAttribute('#meeting-category', 'aria-invalid')) === 'true');
  await page.check('.slot-choice input[value="10:30"]');
  await page.selectOption('#meeting-category', 'career_guidance');
  await page.fill('#meeting-description', 'Advice on internships in hotels next summer.');
  await page.click('button[type=submit]:has-text("Send request")');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Meeting requested'));
  await page.waitForSelector('#meetings li[data-meeting-id]');
  const mine = page.locator('#meetings li[data-meeting-id]');
  t.check('request: listed as pending, with time and place',
    /Dr\. Yoon Tae-hee: Career guidance/.test(await mine.textContent()) && /Pending/.test(await mine.textContent())
      && /10:30–11:00 · HUM 214/.test(await mine.textContent()));
  t.check('request: focus moves to My meetings', await page.evaluate(() => document.activeElement?.id === 'meetings-title'));

  await mine.getByRole('button', { name: /^Cancel/ }).click();
  await page.waitForSelector('dialog[open]');
  await page.click('dialog[open] .btn--danger');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Meeting cancelled'));
  await page.waitForFunction(() => /Cancelled/.test(document.querySelector('#meetings li')?.textContent ?? ''));
  t.check('cancel: the meeting shows as cancelled by you, with no Cancel button',
    /By you/.test(await mine.textContent()) && (await mine.getByRole('button', { name: /^Cancel/ }).count()) === 0);

  // ---- Administrators: decide, and office hours ----------------------------------------------
  const { page: admin } = await t.newPage({ width: 1280 });
  await t.signIn(admin, { email: 'admin@kdu.example', password: 'Admin@2026' }, '/pages/admin/courses.html');
  await admin.waitForSelector('#courses table');
  await admin.click('.page-header a[href="/pages/admin/meetings.html"]');
  await admin.waitForSelector('#pending li[data-meeting-id]');
  const jiho = admin.locator('#pending li', { hasText: 'Park Ji-ho → Dr. Han Ji-won' });
  t.check('queue: overlapping requests to one advisor are pointed out', /Overlaps 1 other request: Lee Seo-yeon/.test(await jiho.textContent()));
  await t.axe(admin, 'admin counselling');
  await t.noHorizontalOverflow(admin, 'admin counselling @ 1280px');
  await t.screenshot(admin, 'admin-counselling-1280');

  await jiho.getByRole('button', { name: /^Approve/ }).click();
  await admin.waitForSelector('dialog[open]');
  t.check('approve: the dialog says which request it declines', /also declines: Lee Seo-yeon/.test(await admin.textContent('dialog[open]')));
  await admin.click('dialog[open] .btn--primary');
  await admin.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('1 overlapping request declined'));
  await admin.waitForFunction(() => !document.querySelector('#pending')?.textContent.includes('Dr. Han Ji-won'));
  t.check('approve: both leave the queue; the list shows one approved, one declined',
    /Park Ji-ho[\s\S]*Approved|Approved[\s\S]*Park Ji-ho/.test(await admin.textContent('#meetings-table'))
      && /Another meeting at this time was approved/.test(await admin.textContent('#meetings-table')));
  t.check('approve: focus goes back to the queue heading', await admin.evaluate(() => document.activeElement?.id === 'pending-title'));

  await admin.selectOption('#hours-advisor', await professorId('Dr. Jung Hye-jin'));
  await admin.selectOption('#hours-weekday', '3');
  await admin.selectOption('#hours-startTime', '09:00');
  await admin.selectOption('#hours-endTime', '10:00');
  await admin.fill('#hours-location', 'HUM 220');
  await admin.click('#hours-form button[type=submit]');
  await admin.waitForSelector('#hours-list li:has-text("Wednesday 09:00–10:00, HUM 220")');
  t.check('office hours: added for the professor chosen', true);
  await admin.selectOption('#hours-weekday', '3');
  await admin.selectOption('#hours-startTime', '09:30');
  await admin.selectOption('#hours-endTime', '11:00');
  await admin.fill('#hours-location', 'HUM 220');
  await admin.click('#hours-form button[type=submit]');
  await admin.waitForSelector('#hours-form .field-error, #hours-form .alert--danger');
  t.check('office hours: overlapping ones are refused', /overlap/.test(await admin.textContent('#hours-form')));
  await admin.locator('#hours-list li', { hasText: 'Wednesday 09:00–10:00' }).getByRole('button', { name: /^Remove/ }).click();
  await admin.waitForSelector('dialog[open]');
  await admin.click('dialog[open] .btn--danger');
  await admin.waitForFunction(() => !document.querySelector('#hours-list')?.textContent.includes('Wednesday 09:00'));
  t.check('office hours: removed', true);
}
