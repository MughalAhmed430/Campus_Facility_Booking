// The booking schedule: a facility's week on the Facility details page (as a student, on a
// phone, and as an administrator), choosing free time to fill in the booking form, the
// "Free at" filter on the Facilities page, and the administrators' day schedule.
//
// Its bookings are next week (always still to come) in a room no other group books.
import { ACCOUNTS } from '../harness.js';

const ROOM = 'Networking Lab'; // ENG 312, 09:00-21:00 on weekdays, no sample bookings
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const P = {
  theirs: 'Schedule check: network lab practice', // Park Ji-ho, approved
  mine: 'Schedule check: my booking', // Kim Min-jun, approved
  myRequest: 'Schedule check: my request', // Kim Min-jun, pending
  theirRequest: 'Schedule check: their request', // Park Ji-ho, pending
  overlapping: 'Schedule check: overlapping request', // Park Ji-ho, pending, overlaps both requests
  fromSchedule: 'Schedule check: from the schedule', // sent through the form by this check
};

const campusToday = () => new Date(Date.now() + KST_MS).toISOString().slice(0, 10);
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
function mondayOf(date) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, weekday === 0 ? -6 : 1 - weekday);
}

const waitForWeek = (page, monday) => page.waitForSelector(
  `.schedule__body:not([aria-busy]) .week__day[data-date="${monday}"]`, { state: 'attached' });
const waitForDay = (page) => page.waitForSelector('#day-schedule:not([aria-busy]) > *');
const dayOf = (page, date) => page.locator(`.week__day[data-date="${date}"]`);
const texts = (locator) => locator.evaluateAll((elements) => elements.map((element) => element.textContent.trim()));
const box = (locator) => locator.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
});

/** @param {import('../harness.js').Harness} t */
export default async function schedule(t) {
  const { db, baseUrl } = t;
  const today = campusToday();
  const thisMonday = mondayOf(today);
  const monday = addDays(thisMonday, 7);
  const tuesday = addDays(monday, 1);
  const saturday = addDays(monday, 5);
  const roomId = (await db.query('SELECT id FROM facilities WHERE name = $1', [ROOM])).rows[0].id;
  const userId = {};
  for (const row of (await db.query('SELECT id, email FROM users')).rows) userId[row.email] = row.id;

  async function seed(email, date, startTime, endTime, status, purpose) {
    const approved = status === 'approved';
    await db.query(
      `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status, decided_by, decided_at)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 4, $5, $6, $7, $8)`,
      [userId[email], roomId, `${date}T${startTime}:00+09:00`, `${date}T${endTime}:00+09:00`, purpose, status,
        approved ? userId['admin@kdu.example'] : null, approved ? new Date() : null],
    );
  }
  await seed('jiho.park@kdu.example', monday, '10:00', '12:00', 'approved', P.theirs);
  await seed(ACCOUNTS.student.email, monday, '13:00', '14:00', 'approved', P.mine);
  await seed(ACCOUNTS.student.email, tuesday, '10:00', '11:00', 'pending', P.myRequest);
  await seed('jiho.park@kdu.example', tuesday, '11:00', '12:00', 'pending', P.theirRequest);
  await seed('jiho.park@kdu.example', tuesday, '10:30', '11:30', 'pending', P.overlapping);
  const facilityPath = `/pages/facility.html?id=${roomId}`;

  // ---- A student's week, on a desktop ---------------------------------------------------
  const { context, page } = await t.newPage({ width: 1280, height: 900 });
  await t.signIn(page, ACCOUNTS.student, facilityPath);
  await waitForWeek(page, thisMonday);
  t.check('week: opens on this week, Monday to Sunday',
    JSON.stringify(await page.$$eval('.week__day', (days) => [days.length, days[0].dataset.date])) === JSON.stringify([7, thisMonday]));
  t.check('week: today is marked', (await page.getAttribute('.week__day.is-today', 'data-date')) === today
    && (await page.textContent('.week__day.is-today .week__date')).includes('Today'));
  const thisWeekRange = await page.textContent('.schedule__range');
  t.check('week: says which week it shows, in Korea time', thisWeekRange.endsWith('Korea time (KST)'), thisWeekRange);

  await page.click('.schedule__nav >> text=Next week');
  await waitForWeek(page, monday);
  t.check('week: "Next week" shows the next week and keeps it in the address bar',
    new URL(page.url()).searchParams.get('week') === monday && (await page.textContent('.schedule__range')) !== thisWeekRange, page.url());

  const mondayText = await dayOf(page, monday).textContent();
  t.check('week: someone else\'s booking reads "Booked", without their name or purpose',
    (await texts(dayOf(page, monday).locator('.slot--booked'))).join() === '10:00–12:00 Booked'
      && !mondayText.includes('Park') && !mondayText.includes(P.theirs), mondayText);
  t.check('week: the student\'s own booking reads "Your booking"',
    (await texts(dayOf(page, monday).locator('.slot--yours'))).join() === '13:00–14:00 Your booking');
  t.check('week: the student\'s own request reads "Your request"',
    (await texts(dayOf(page, tuesday).locator('.slot--your-request .slot__time'))).join() === '10:00–11:00');
  const tuesdayText = await dayOf(page, tuesday).textContent();
  t.check('week: other students\' requests are not shown', !tuesdayText.includes('11:00–12:00') && !tuesdayText.includes('10:30'), tuesdayText);
  const freeMonday = await texts(dayOf(page, monday).locator('.slot--free .slot__time'));
  t.check('week: the free time around bookings can be chosen', freeMonday.join() === '09:00–10:00,12:00–13:00,14:00–21:00', freeMonday.join());
  t.check('week: a request leaves its time free (only approval holds time)',
    (await texts(dayOf(page, tuesday).locator('.slot--free .slot__time'))).join() === '09:00–21:00');
  for (const date of [saturday, addDays(monday, 6)]) {
    t.check(`week: ${date === saturday ? 'Saturday' : 'Sunday'} says Closed, with no free time to choose`,
      (await dayOf(page, date).textContent()).includes('Closed') && (await dayOf(page, date).locator('.slot--free').count()) === 0);
  }

  // The timeline: days side by side, each booking at its time and as long as it lasts.
  const [mondayBox, tuesdayBox] = [await box(dayOf(page, monday)), await box(dayOf(page, tuesday))];
  t.check('week @ 1280px: the days are columns side by side', tuesdayBox.top === mondayBox.top && tuesdayBox.left >= mondayBox.right - 1,
    JSON.stringify([mondayBox, tuesdayBox]));
  const booked = await box(dayOf(page, monday).locator('.slot--booked'));
  const yours = await box(dayOf(page, monday).locator('.slot--yours'));
  t.check('week @ 1280px: a 2-hour booking is twice as tall as a 1-hour one, three hours higher up',
    Math.abs(booked.height - 2 * yours.height) <= 2 && Math.abs(yours.top - booked.top - 1.5 * booked.height) <= 2, JSON.stringify([booked, yours]));
  const lanes = await box(dayOf(page, tuesday).locator('.slot--your-request'));
  t.check('week @ 1280px: a request does not cover the free time behind it completely',
    lanes.width > 0 && lanes.width <= tuesdayBox.width);
  await t.noHorizontalOverflow(page, 'facility week @ 1280px');
  await t.axe(page, 'facility week @ 1280px');
  await t.screenshot(page, 'facility-week-1280');

  // Choosing free time fills in the form
  await dayOf(page, monday).locator('.slot--free button', { hasText: '12:00–13:00' }).click();
  t.check('choose: the date and times are filled in',
    JSON.stringify([await page.inputValue('#booking-date'), await page.inputValue('#booking-start'), await page.inputValue('#booking-end')])
      === JSON.stringify([monday, '12:00', '13:00']));
  t.check('choose: focus moves to the start time', await page.evaluate(() => document.activeElement.id === 'booking-start'));
  await page.waitForFunction(() => document.getElementById('booking-taken').textContent.startsWith('Already booked'));
  t.check('choose: the form lists the times already booked that day',
    (await page.textContent('#booking-taken')) === 'Already booked: 10:00–12:00, 13:00–14:00.', await page.textContent('#booking-taken'));
  await dayOf(page, monday).locator('.slot--free button', { hasText: '14:00–21:00' }).click();
  t.check('choose: longer free time suggests one hour', (await page.inputValue('#booking-end')) === '15:00');
  const freeName = await dayOf(page, monday).locator('.slot--free button').first().evaluate((button) => button.textContent);
  t.check('choose: each free-time button says what it does', freeName.includes('Fills in the form with 09:00–10:00'), freeName);

  await page.fill('#booking-participants', '3');
  await page.fill('#booking-purpose', P.fromSchedule);
  await page.click('#booking-form button[type=submit]');
  await page.waitForSelector('#booking-form .alert--success');
  await page.waitForFunction((date) => document.querySelectorAll(`.week__day[data-date="${date}"] .slot--your-request`).length === 1, monday);
  t.check('submit: the new request appears on the schedule, in the same week',
    (await texts(dayOf(page, monday).locator('.slot--your-request .slot__time'))).join() === '14:00–15:00');

  await page.reload();
  await waitForWeek(page, monday);
  t.check('week: reloading keeps the week', true);
  await page.click('.schedule__nav >> text=This week');
  await waitForWeek(page, thisMonday);
  t.check('week: "This week" goes back to the current week', new URL(page.url()).searchParams.get('week') === thisMonday);

  const weekLookup = /\/schedule\?from=[\d-]+&days=7$/;
  await page.route(weekLookup, (route) => route.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again later.' } }),
  }));
  t.expectConsoleError(/status of 500/);
  await page.click('.schedule__nav >> text=Next week');
  await page.waitForSelector('.schedule__body .state--error');
  t.check('week: a failed load says so and offers to try again',
    (await page.textContent('.schedule__body')).includes('Could not load the schedule')
      && (await page.locator('.schedule__body button', { hasText: 'Try again' }).count()) === 1);
  await page.unroute(weekLookup);
  await page.click('.schedule__body button');
  await waitForWeek(page, monday);
  t.check('week: "Try again" loads it', true);

  // ---- On a phone: a list of days -------------------------------------------------------
  const studentCookies = await context.cookies();
  {
    const { page: phone } = await t.newPage({ width: 390, height: 800, cookies: studentCookies });
    await phone.goto(`${baseUrl}${facilityPath}&week=${monday}`);
    await waitForWeek(phone, monday);
    const [first, second] = [await box(dayOf(phone, monday)), await box(dayOf(phone, tuesday))];
    t.check('week @ 390px: the days are a list, one under another', second.top >= first.bottom, JSON.stringify([first, second]));
    t.check('week @ 390px: hour labels are left out', !(await phone.isVisible('.week__hours')));
    await t.noHorizontalOverflow(phone, 'facility week @ 390px');
    await t.axe(phone, 'facility week @ 390px');
    await t.screenshot(phone, 'facility-week-390');
  }
  {
    const { page: small } = await t.newPage({ width: 320, height: 700, cookies: studentCookies });
    await small.goto(`${baseUrl}${facilityPath}&week=${monday}`);
    await waitForWeek(small, monday);
    await t.noHorizontalOverflow(small, 'facility week @ 320px');
  }

  // ---- An administrator's view of the same week -------------------------------------------
  const { context: adminContext, page: admin } = await t.newPage({ width: 1280, height: 900 });
  await t.signIn(admin, ACCOUNTS.admin, `${facilityPath}&week=${monday}`);
  await waitForWeek(admin, monday);
  t.check('week (admin): every booking reads "Booked"',
    (await texts(dayOf(admin, monday).locator('.slot--booked .slot__label'))).join() === 'Booked,Booked'
      && (await admin.locator('.slot--yours, .slot--your-request').count()) === 0);
  t.check('week (admin): no free time to choose, and a key without the student entries',
    (await admin.locator('.slot--free').count()) === 0 && !(await admin.textContent('.schedule-legend')).includes('Your'));
  await t.axe(admin, 'facility week, administrator @ 1280px');

  // ---- "Free at" on the Facilities page ------------------------------------------------------
  await page.goto(`${baseUrl}/pages/facilities.html?type=laboratory`);
  await page.waitForSelector('#results article');
  const cardNames = () => texts(page.locator('#results article h3'));
  await page.fill('#filter-date', monday);
  await page.waitForTimeout(500);
  t.check('free at: a date alone changes nothing yet', (await cardNames()).length === 4 && !new URL(page.url()).searchParams.has('date'));
  await page.fill('#filter-start', '10:30');
  await page.fill('#filter-end', '11:30');
  await page.waitForFunction(() => document.getElementById('result-count').textContent.includes('free on'));
  const labs = await cardNames();
  t.check('free at: a lab with a booking then is left out; one without is listed',
    !labs.includes(ROOM) && labs.includes('Computer Lab A'), labs.join());
  const countLine = await page.textContent('#result-count');
  t.check('free at: the count says when', /match(es)? your filters and (is|are) free on .+, 10:30–11:30$/.test(countLine), countLine);
  const params = new URL(page.url()).searchParams;
  t.check('free at: the address bar keeps the time',
    params.get('date') === monday && params.get('startTime') === '10:30' && params.get('endTime') === '11:30', page.url());
  t.check('free at: it counts as one filter', (await page.textContent('#filter-count')) === '(2 active)', await page.textContent('#filter-count'));

  await page.fill('#filter-end', '10:00');
  await page.waitForSelector('#filter-end[aria-invalid="true"]');
  t.check('free at: an end before the start is caught', (await page.textContent('#filter-form')).includes('End time must be after the start time.'));
  await page.fill('#filter-start', '12:00');
  await page.fill('#filter-end', '13:00');
  await page.waitForFunction(() => document.getElementById('result-count').textContent.endsWith('12:00–13:00'));
  t.check('free at: the gap between two bookings counts as free', (await cardNames()).includes(ROOM));
  await t.axe(page, 'facilities with "Free at"');
  await t.screenshot(page, 'facilities-free-at');
  const cardLink = await page.locator('#results article', { hasText: ROOM }).locator('a').getAttribute('href');
  t.check('free at: the card links to the facility with the time',
    new URL(cardLink, baseUrl).searchParams.get('startTime') === '12:00' && new URL(cardLink, baseUrl).searchParams.get('date') === monday, cardLink);
  await page.click(`text=${ROOM}`);
  await waitForWeek(page, monday);
  t.check('free at: the booking form arrives filled in, and the schedule shows that week',
    JSON.stringify([await page.inputValue('#booking-date'), await page.inputValue('#booking-start'), await page.inputValue('#booking-end')])
      === JSON.stringify([monday, '12:00', '13:00']));

  // ---- The administrators' day schedule ------------------------------------------------------
  const schedulePath = '/pages/admin/schedule.html';
  await admin.goto(`${baseUrl}${schedulePath}`);
  await waitForDay(admin);
  t.check('day: in the admin menu, as the current page',
    (await admin.getAttribute('.nav__link[aria-current="page"]', 'href')) === schedulePath);
  t.check('day: opens on today', (await admin.inputValue('#day-date')) === today && (await admin.textContent('#day-title')).endsWith('(today)'));
  const listed = (await db.query("SELECT count(*)::int AS n FROM facilities WHERE status <> 'inactive'")).rows[0].n;
  t.check('day: one row per facility, retired ones left out', (await admin.locator('.day-row').count()) === listed);

  await admin.fill('#day-date', monday);
  await admin.waitForFunction((date) => new URL(window.location.href).searchParams.get('date') === date, monday);
  await waitForDay(admin);
  const row = admin.locator(`.day-row[data-facility-id="${roomId}"]`);
  await row.waitFor();
  const rowText = await row.textContent();
  t.check('day: bookings show the student and purpose', rowText.includes('Park Ji-ho') && rowText.includes(P.theirs), rowText);
  t.check('day: approved bookings and pending requests are both shown',
    (await row.locator('.slot--approved').count()) === 2 && (await row.locator('.slot--pending').count()) === 1);
  const summary = await admin.textContent('#day-summary');
  t.check('day: the summary counts bookings and requests', /^\d+ bookings? and \d+ pending requests? in \d+ facilities\.$/.test(summary), summary);
  const [ten, one] = [await box(row.locator('.slot', { hasText: '10:00–12:00' })), await box(row.locator('.slot', { hasText: '13:00–14:00' }))];
  t.check('day @ 1280px: bookings sit on a timeline, as long as they last',
    one.left > ten.right && Math.abs(ten.width - 2 * one.width) <= 3, JSON.stringify([ten, one]));
  await t.noHorizontalOverflow(admin, 'admin schedule @ 1280px');
  await t.axe(admin, 'admin schedule @ 1280px');
  await t.screenshot(admin, 'admin-schedule-1280');

  // Details of a booking
  const theirsButton = row.locator('.slot--approved button', { hasText: P.theirs });
  await theirsButton.click();
  await admin.waitForSelector('dialog[open]');
  const details = await admin.textContent('dialog[open]');
  t.check('details: the dialog shows the student, number, purpose and status',
    ['Park Ji-ho', '241003', 'jiho.park@kdu.example', P.theirs, 'Approved', '4 of 24 people'].every((text) => details.includes(text)), details);
  t.check('details: an approved booking has no link to Requests', (await admin.locator('dialog[open] a').count()) === 0);
  await t.axe(admin, 'admin schedule, booking details');
  await admin.keyboard.press('Escape');
  await admin.waitForSelector('dialog', { state: 'detached' });
  t.check('details: Escape closes it and focus returns to the booking',
    await theirsButton.evaluate((button) => document.activeElement === button));
  await row.locator('.slot--pending button').click();
  await admin.waitForSelector('dialog[open]');
  t.check('details: a pending request links to Requests',
    (await admin.getAttribute('dialog[open] a', 'href')) === '/pages/admin/requests.html' && (await admin.textContent('dialog[open]')).includes('holds no time'));
  await admin.click('dialog[open] >> text=Close');

  // Moving between days, and overlapping requests
  await admin.click('#day-next');
  await admin.waitForFunction((date) => new URL(window.location.href).searchParams.get('date') === date, tuesday);
  await waitForDay(admin);
  t.check('day: "Next day" moves on one day', (await admin.inputValue('#day-date')) === tuesday);
  const tuesdayRow = admin.locator(`.day-row[data-facility-id="${roomId}"]`);
  const [request, overlapping] = [
    await box(tuesdayRow.locator('.slot', { hasText: P.myRequest })),
    await box(tuesdayRow.locator('.slot', { hasText: P.overlapping })),
  ];
  t.check('day @ 1280px: overlapping requests go on separate lanes', overlapping.top >= request.bottom - 1, JSON.stringify([request, overlapping]));
  await admin.selectOption('#day-type', 'meeting_room');
  await admin.waitForFunction(() => new URL(window.location.href).searchParams.get('type') === 'meeting_room');
  await waitForDay(admin);
  t.check('day: the type filter shows one kind of facility, kept in the address bar', (await admin.locator('.day-row').count()) === 3);
  await admin.selectOption('#day-type', '');
  await admin.fill('#day-date', saturday);
  await admin.waitForFunction((date) => new URL(window.location.href).searchParams.get('date') === date, saturday);
  await waitForDay(admin);
  t.check('day: at weekends, a weekday-only facility says it is closed',
    (await admin.locator(`.day-row[data-facility-id="${roomId}"]`).textContent()).includes('Closed today'));
  await admin.click('#day-today');
  await admin.waitForFunction((date) => new URL(window.location.href).searchParams.get('date') === date, today);
  t.check('day: "Today" goes back to today', (await admin.inputValue('#day-date')) === today);

  // On a phone: one card per facility
  {
    const { page: phone } = await t.newPage({ width: 390, height: 800, cookies: await adminContext.cookies() });
    await phone.goto(`${baseUrl}${schedulePath}?date=${monday}`);
    await waitForDay(phone);
    const phoneRow = phone.locator(`.day-row[data-facility-id="${roomId}"]`);
    const [a, b] = [await box(phoneRow.locator('.slot').nth(0)), await box(phoneRow.locator('.slot').nth(1))];
    t.check('day @ 390px: a facility\'s bookings are a list, one under another', b.top >= a.bottom, JSON.stringify([a, b]));
    await t.noHorizontalOverflow(phone, 'admin schedule @ 390px');
    await t.axe(phone, 'admin schedule @ 390px');
    await t.screenshot(phone, 'admin-schedule-390');
  }

  // Students cannot open it
  await page.goto(`${baseUrl}${schedulePath}`);
  await page.waitForSelector('main .state');
  t.check('day: a student is told the page is for administrators',
    (await page.textContent('main')).includes('This page is not available to your account')
      && (await page.locator(`.nav a[href="${schedulePath}"]`).count()) === 0);
}
