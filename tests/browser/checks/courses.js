// Phase 2: courses, registration, the timetable, lectures on the facility schedules, and
// the academic office's pages (courses, lecture times, professors).
//
// Students of its own register and drop, so the sample registrations stay as they are.
// Lectures it adds are in Seminar Room 302 on Monday evenings, which nothing else uses.
const PASSWORD = 'Student@2026';
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** The next date (from tomorrow) on ISO weekday `weekday` (1 = Monday), in Korea. */
function nextWeekday(weekday) {
  let time = Date.now() + KST_MS + DAY_MS;
  while ((new Date(time).getUTCDay() || 7) !== weekday) time += DAY_MS;
  return new Date(time).toISOString().slice(0, 10);
}

/** @param {import('../harness.js').Harness} t */
export default async function courses(t) {
  const db = t.db;
  async function newStudent(name, email) {
    await db.query(
      `INSERT INTO users (full_name, email, password_hash, role, student_number)
       VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), 'student', $4)`,
      [name, email, PASSWORD, String(Math.floor(100000 + Math.random() * 800000))],
    );
    return { email, password: PASSWORD };
  }
  const cardOf = (page, code) => page.locator('article.course-card', { has: page.locator('.course-card__code', { hasText: code }) });
  const waitList = (page, selector) => page.waitForFunction((sel) => {
    const element = document.querySelector(sel);
    return element && !element.hasAttribute('aria-busy') && element.children.length > 0;
  }, selector);

  // ---- Students: the catalogue -----------------------------------------------------------
  const student = await newStudent('Course Kappa', 'course.kappa@kdu.example');
  const { page } = await t.newPage({ width: 1280 });
  await t.signIn(page, student, '/pages/courses.html');
  await waitList(page, '#courses');
  t.check('courses: the menu has Courses, current; the page links to the timetable',
    (await page.getAttribute('.nav__link[href="/pages/courses.html"]', 'aria-current')) === 'page'
      && (await page.locator('.page-header a[href="/pages/timetable.html"]').count()) === 1);
  t.check('courses: all eight sample courses are listed', (await page.locator('article.course-card').count()) === 8);
  t.check('courses: the semester is named, and labelled sample data', /\(sample\)/.test(await page.textContent('#courses-semester')));
  t.check('courses: a card shows the professor, the lecture times and the seats',
    /Dr\. Han Ji-won/.test(await cardOf(page, 'CSE2010').textContent())
      && /Mon 09:00–10:30, ENG 204/.test(await cardOf(page, 'CSE2010').textContent())
      && /of 40 seats left/.test(await cardOf(page, 'CSE2010').textContent()));
  t.check('courses: the small seminar has one seat left', /1 of 3 seats left/.test(await cardOf(page, 'GEN1100').textContent()));
  await t.axe(page, 'courses');
  await t.noHorizontalOverflow(page, 'courses @ 1280px');
  await t.screenshot(page, 'courses-1280');

  await page.fill('#course-q', 'network');
  await page.waitForFunction(() => document.querySelectorAll('article.course-card').length === 1);
  t.check('courses: search finds a course by title', (await page.textContent('article.course-card h2')).includes('CSE3050'));
  t.check('courses: the search is kept in the address bar', new URL(page.url()).searchParams.get('q') === 'network');
  await page.fill('#course-q', '');
  await page.waitForFunction(() => document.querySelectorAll('article.course-card').length === 8);

  // Register, then a clash, then drop.
  await cardOf(page, 'CSE3050').getByRole('button', { name: /^Register/ }).click();
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Registered for CSE3050'));
  t.check('register: the card says Registered and offers Drop',
    (await cardOf(page, 'CSE3050').locator('.badge').textContent()) === 'Registered'
      && (await cardOf(page, 'CSE3050').getByRole('button', { name: /^Drop/ }).count()) === 1);
  t.check('register: focus stays on that course', await cardOf(page, 'CSE3050').getByRole('button', { name: /^Drop/ }).evaluate((el) => el === document.activeElement));

  await cardOf(page, 'BUS2040').getByRole('button', { name: /^Register/ }).click();
  await page.waitForSelector('#courses-alert .alert--danger');
  t.check('register: a timetable clash is explained above the list',
    /same time as CSE3050 Computer Networks/.test(await page.textContent('#courses-alert')));

  await cardOf(page, 'CSE3050').getByRole('button', { name: /^Drop/ }).click();
  await page.waitForSelector('dialog[open]');
  t.check('drop: asks first, naming the course', (await page.textContent('dialog[open] h2')) === 'Drop CSE3050?');
  await page.click('dialog[open] .btn--danger');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Dropped CSE3050'));
  t.check('drop: Register is offered again', (await cardOf(page, 'CSE3050').getByRole('button', { name: /^Register/ }).count()) === 1);

  // ---- Students: the timetable ------------------------------------------------------------
  await page.goto(`${t.baseUrl}/pages/timetable.html`);
  await waitList(page, '#timetable');
  t.check('timetable: with no courses, says so and links to Courses',
    /No courses yet/.test(await page.textContent('#timetable')) && (await page.locator('#timetable a[href="/pages/courses.html"]').count()) === 1);

  await page.goto(`${t.baseUrl}/pages/courses.html`);
  await waitList(page, '#courses');
  await cardOf(page, 'BUS1010').getByRole('button', { name: /^Register/ }).click();
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Registered for BUS1010'));
  await page.goto(`${t.baseUrl}/pages/timetable.html`);
  await page.waitForSelector('#timetable .week');
  t.check('timetable: the week has Monday to Friday', (await page.locator('.week__day').count()) === 5);
  t.check('timetable: BUS1010 is on Tuesday and Thursday at 10:00',
    /10:00–11:30\s*BUS1010/.test(await page.textContent('.week__day[data-weekday="2"]'))
      && /BUS1010/.test(await page.textContent('.week__day[data-weekday="4"]'))
      && (await page.locator('.week__day[data-weekday="1"] .slot').count()) === 0);
  t.check('timetable: the total credits', (await page.textContent('.timetable-total')) === '3 credits in 1 course');
  await t.axe(page, 'timetable');
  await t.noHorizontalOverflow(page, 'timetable @ 1280px');
  await t.screenshot(page, 'timetable-1280');
  await page.setViewportSize({ width: 390, height: 844 });
  await t.noHorizontalOverflow(page, 'timetable @ 390px');
  await t.axe(page, 'timetable @ 390px');

  // ---- Lectures on the facility week ---------------------------------------------------------
  await page.setViewportSize({ width: 1280, height: 900 });
  const seminarId = (await db.query("SELECT id FROM facilities WHERE name = 'Seminar Room 302'")).rows[0].id;
  await page.goto(`${t.baseUrl}/pages/facility.html?id=${seminarId}`);
  await page.waitForSelector('.schedule__body:not([aria-busy]) .week');
  const friday = page.locator('.week__day').nth(4);
  t.check('facility week: lectures show as Lecture blocks with the course code',
    (await friday.locator('.slot--lecture').count()) === 2 && /Lecture GEN1001/.test(await friday.textContent()));
  t.check('facility week: the key explains lectures', /Lecture \(a course meets here\)/.test(await page.textContent('.schedule-legend')));
  t.check('facility week: no free time is offered during a lecture',
    !(await friday.locator('.slot--free').allTextContents()).some((text) => text.startsWith('10:00') || text.startsWith('14:00')));

  // ---- Administrators: courses ------------------------------------------------------------
  const { page: admin } = await t.newPage({ width: 1280 });
  await t.signIn(admin, { email: 'admin@kdu.example', password: 'Admin@2026' }, '/pages/admin/courses.html');
  await waitList(admin, '#courses');
  t.check('admin courses: a row per course, with seats taken', (await admin.locator('#courses tbody tr').count()) === 8
    && /2 \/ 3/.test(await admin.textContent('#courses tbody tr:has-text("GEN1100")')));
  t.check('admin courses: Courses is current in the menu', (await admin.getAttribute('.nav__link[href="/pages/admin/courses.html"]', 'aria-current')) === 'page');
  await t.axe(admin, 'admin courses');
  await t.noHorizontalOverflow(admin, 'admin courses @ 1280px');

  // A new course, then a lecture.
  await admin.click('#new-course');
  await admin.waitForSelector('#course-form');
  await admin.fill('#course-code', 'tst 101');
  await admin.fill('#course-title', 'Browser Check Seminar');
  await admin.selectOption('#course-departmentId', { label: 'General Education' });
  await admin.selectOption('#course-professorId', { label: 'Dr. Yoon Tae-hee (HTM)' });
  await admin.fill('#course-seatLimit', '12');
  await t.axe(admin, 'new course form');
  await Promise.all([admin.waitForURL(/course-form\.html\?id=\d+/), admin.click('#course-form button[type=submit]')]);
  await admin.waitForSelector('#slot-form');
  t.check('new course: saved, then its page offers lecture times', (await admin.textContent('h1')) === 'TST101 Browser Check Seminar');

  await admin.selectOption('#slot-weekday', '1');
  await admin.selectOption('#slot-startTime', '18:00');
  t.check('lecture form: choosing a start suggests 90 minutes', (await admin.inputValue('#slot-endTime')) === '19:30');
  await admin.selectOption('#slot-facilityId', { label: 'Seminar Room 302 (HUM 302), 24 seats' });
  await admin.click('#slot-form button[type=submit]');
  await admin.waitForSelector('.slot-table tbody tr');
  t.check('lecture added: listed with its day, time and room',
    /Monday\s*18:00–19:30\s*Seminar Room 302/.test(await admin.textContent('.slot-table tbody tr')));
  await t.axe(admin, 'course page with a lecture');
  await t.screenshot(admin, 'admin-course-1280');

  // The same room at a time GEN1001 already has it.
  t.check('lecture added: the form is empty again, for the next one', (await admin.inputValue('#slot-facilityId')) === '');
  await admin.selectOption('#slot-weekday', '5');
  await admin.selectOption('#slot-startTime', '10:00');
  await admin.selectOption('#slot-facilityId', { label: 'Seminar Room 302 (HUM 302), 24 seats' });
  await admin.click('#slot-form button[type=submit]');
  await admin.waitForSelector('#slots-alert .alert--danger');
  t.check('lecture clash: refused, naming the lecture already there',
    /not free every week/.test(await admin.textContent('#slots-alert')) && /lecture GEN1001/.test(await admin.textContent('#slots-alert')));

  // The day schedule shows the new lecture.
  const monday = nextWeekday(1);
  await admin.goto(`${t.baseUrl}/pages/admin/schedule.html?date=${monday}`);
  await admin.waitForSelector('#day-schedule:not([aria-busy]) .day-grid');
  const row = admin.locator(`.day-row[data-facility-id="${seminarId}"]`);
  t.check('day schedule: the lecture is on the room\'s row, linking to the course',
    /TST101/.test(await row.locator('.slot--lecture').textContent())
      && /course-form\.html\?id=\d+/.test(await row.locator('.slot--lecture a').getAttribute('href')));
  t.check('day schedule: the key and the summary count lectures',
    /Lecture/.test(await admin.textContent('.schedule-legend')) && /lecture/.test(await admin.textContent('#day-summary')));

  // Remove the lecture, then delete the course.
  await row.locator('.slot--lecture a').click();
  await admin.waitForSelector('.slot-table');
  await admin.locator('.slot-table tbody tr', { hasText: '18:00' }).getByRole('button', { name: /Remove/ }).click();
  await admin.waitForSelector('dialog[open]');
  await admin.click('dialog[open] .btn--danger');
  await admin.waitForFunction(() => !document.querySelector('.slot-table') && document.querySelector('#slots-title'));
  t.check('lecture removed: the course has none left', /No lectures yet/.test(await admin.textContent('#slot-form-title ~ *, section[aria-labelledby=slots-title]')));
  await admin.getByRole('button', { name: 'Delete course' }).click();
  await admin.waitForSelector('dialog[open]');
  await Promise.all([admin.waitForURL(/courses\.html/), admin.click('dialog[open] .btn--danger')]);
  await admin.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Course deleted'));
  t.check('course deleted: back on the list, which no longer has it', !(await admin.textContent('#courses')).includes('TST101'));

  // ---- Administrators: professors ----------------------------------------------------------
  await admin.goto(`${t.baseUrl}/pages/admin/professors.html`);
  await waitList(admin, '#professors');
  t.check('professors: the five sample professors', (await admin.locator('#professors tbody tr').count()) === 5);
  t.check('professors: one who teaches has no Delete button',
    (await admin.locator('#professors tbody tr:has-text("Dr. Han Ji-won")').getByRole('button', { name: /^Delete/ }).count()) === 0);
  await t.axe(admin, 'professors');
  await t.noHorizontalOverflow(admin, 'professors @ 1280px');

  await admin.click('#new-professor');
  await admin.waitForSelector('dialog[open] #professor-fullName');
  await t.axe(admin, 'new professor dialog');
  await admin.fill('#professor-fullName', 'Dr. Check Lambda');
  await admin.selectOption('#professor-departmentId', { label: 'Business Administration' });
  await admin.click('dialog[open] button[type=submit]');
  await admin.waitForFunction(() => document.querySelector('#professors')?.textContent.includes('Dr. Check Lambda'));
  t.check('professors: a new one is added', true);

  const newRow = admin.locator('#professors tbody tr:has-text("Dr. Check Lambda")');
  await newRow.getByRole('button', { name: /^Add photo/ }).click();
  await admin.waitForSelector('dialog[open] #professor-photo');
  await admin.setInputFiles('#professor-photo', { name: 'lambda.png', mimeType: 'image/png', buffer: PNG });
  await admin.click('dialog[open] button[type=submit]');
  await admin.waitForSelector('dialog[open] .field-error');
  t.check('professor photo: the credit is required', /where the photo comes from/i.test(await admin.textContent('dialog[open]')));
  await admin.fill('#professor-credit', 'Sample image for the browser check');
  await admin.click('dialog[open] button[type=submit]');
  await admin.waitForFunction(() => [...document.querySelectorAll('#professors tbody tr')]
    .some((tr) => tr.textContent.includes('Dr. Check Lambda') && tr.querySelector('.avatar__img')));
  t.check('professor photo: shown, with its credit under the name',
    /Photo: Sample image for the browser check/.test(await newRow.textContent())
      && (await newRow.locator('.avatar__img').evaluate((img) => img.complete && img.naturalWidth > 0)));

  await newRow.getByRole('button', { name: /^Delete/ }).click();
  await admin.waitForSelector('dialog[open]');
  await admin.click('dialog[open] .btn--danger');
  await admin.waitForFunction(() => !document.querySelector('#professors')?.textContent.includes('Dr. Check Lambda'));
  t.check('professors: one who teaches nothing can be deleted', true);
}
