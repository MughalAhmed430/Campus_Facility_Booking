// The two dashboards: where each role lands after signing in, the figures (checked against
// the database), the previews, the links to the full pages, the "estimate" label on
// utilization, empty and error states, a phone, and who may open which dashboard.
//
// The student figures use a student and a room made here, so they are known exactly.
import { ACCOUNTS } from '../harness.js';

const STUDENT_HOME = '/pages/dashboard.html';
const ADMIN_HOME = '/pages/admin/dashboard.html';
const ROOM = 'Dashboard Check Room';
const PASSWORD = 'Student@2026';
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const NUMBER = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

/** A date `daysAhead` from today in Korea, YYYY-MM-DD. */
function campusDate(daysAhead) {
  return new Date(Date.now() + KST_MS + daysAhead * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday of this week in Korea (weeks run Monday to Sunday). */
function campusMonday() {
  const weekday = new Date(`${campusDate(0)}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return campusDate(weekday === 0 ? -6 : 1 - weekday);
}

/** @param {import('../harness.js').Harness} t */
export default async function dashboards(t) {
  const db = t.db;
  const adminId = (await db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;
  const otherStudentId = (await db.query("SELECT id FROM users WHERE email = 'yuna.choi@kdu.example'")).rows[0].id;

  async function newStudent(fullName, email) {
    const { rows } = await db.query(
      `INSERT INTO users (full_name, email, password_hash, role)
       VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), 'student') RETURNING id`,
      [fullName, email, PASSWORD],
    );
    return { id: rows[0].id, email, password: PASSWORD };
  }

  const roomId = (await db.query(
    `INSERT INTO facilities (building_id, room_number, name, facility_type, capacity, floor, opens_at, closes_at, is_open_weekends)
     SELECT id, '991', $1, 'meeting_room', 8, 9, '08:00', '23:30', true FROM buildings WHERE code = 'ENG'
     RETURNING id`, [ROOM],
  )).rows[0].id;

  async function book(userId, daysAhead, start, end, status) {
    const date = campusDate(daysAhead);
    const approved = status === 'approved';
    const { rows } = await db.query(
      `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status, decided_by, decided_at)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 4, 'Dashboard check: project meeting', $5, $6, $7) RETURNING id`,
      [userId, roomId, `${date}T${start}:00+09:00`, `${date}T${end}:00+09:00`, status, approved ? adminId : null, approved ? new Date() : null],
    );
    return rows[0].id;
  }

  // Seven upcoming: requests on days 1, 2 and 7, approved bookings on days 3 to 6.
  const student = await newStudent('Dash Zeta', 'dash.zeta@kdu.example');
  const soonest = await book(student.id, 1, '10:00', '11:00', 'pending');
  await book(student.id, 2, '10:00', '11:00', 'pending');
  for (const day of [3, 4, 5, 6]) await book(student.id, day, '10:00', '11:00', 'approved');
  await book(student.id, 7, '10:00', '11:00', 'pending');
  // Four notifications, the two newest unread.
  for (const [minutesAgo, title, read] of [[40, 'Fourth newest', true], [30, 'Third newest', true], [20, 'Second newest', false], [10, 'Newest', false]]) {
    await db.query(
      `INSERT INTO notifications (user_id, type, title, message, read_at, created_at)
       VALUES ($1, 'system', $2, 'Dashboard check message.', $3, now() - make_interval(mins => $4))`,
      [student.id, title, read ? new Date() : null, minutesAgo],
    );
  }
  // Someone else's booking late today, so the administrators' "today" list is never empty.
  const todayBooking = await book(otherStudentId, 0, '23:00', '23:30', 'approved');
  // And two more requests, so more are waiting than the administrators' preview shows.
  for (const day of [8, 9]) await book(otherStudentId, day, '10:00', '11:00', 'pending');

  // ---- Student: landing, figures, previews ---------------------------------------------------
  const { context, page } = await t.newPage({ width: 1280 });
  await t.signIn(page, student);
  t.check('student: signing in lands on the dashboard', new URL(page.url()).pathname === STUDENT_HOME, page.url());
  await waitForDashboard(page);
  t.check('student: the heading welcomes them by name', (await page.textContent('h1')) === 'Welcome, Dash Zeta', await page.textContent('h1'));
  t.check('student: the menu starts with Dashboard, marked as the current page',
    (await page.locator('.nav__link').first().textContent()) === 'Dashboard'
    && (await page.getAttribute('.nav__link[aria-current="page"]', 'href')) === STUDENT_HOME);
  t.check('student: the brand links to the dashboard', (await page.getAttribute('.brand', 'href')) === STUDENT_HOME);
  t.check('student: "Book a facility" leads to Facilities',
    (await page.getByRole('link', { name: 'Book a facility' }).getAttribute('href')) === '/pages/facilities.html');

  const labels = await page.locator('#dashboard-stats .stat__label').allTextContents();
  t.check('student: three figures', labels.join(', ') === 'Upcoming bookings, Pending requests, Unread notifications', labels.join(', '));
  t.check('student: 4 upcoming approved bookings, linking to My bookings',
    (await stat(page, 'upcoming')).value === '4' && (await stat(page, 'upcoming')).href === '/pages/my-bookings.html', JSON.stringify(await stat(page, 'upcoming')));
  t.check('student: 3 pending requests, linking to the Pending tab',
    (await stat(page, 'pending')).value === '3' && (await stat(page, 'pending')).href === '/pages/my-bookings.html?tab=pending', JSON.stringify(await stat(page, 'pending')));
  t.check('student: 2 unread notifications, linking to Notifications, and the same number in the menu',
    (await stat(page, 'unread')).value === '2' && (await stat(page, 'unread')).href === '/pages/notifications.html'
    && (await page.textContent('.nav__count')).startsWith('2'), JSON.stringify(await stat(page, 'unread')));

  const items = page.locator('#dashboard-upcoming .dash-item');
  const statuses = await items.locator('.badge').allTextContents();
  t.check('student: the next 5 bookings and requests, soonest first, each with its status',
    (await items.count()) === 5 && (await items.first().getAttribute('data-booking-id')) === String(soonest)
    && statuses.join(',') === 'Pending,Pending,Approved,Approved,Approved', statuses.join(','));
  t.check('student: each one names the facility, room, date and time',
    (await items.first().textContent()).includes(ROOM) && (await items.first().textContent()).includes('ENG 991')
    && (await items.first().textContent()).includes('10:00–11:00'), await items.first().textContent());
  t.check('student: says that 5 of 7 are shown, with a link to all', (await page.textContent('#dashboard-upcoming .dash-more')) === 'Showing the next 5 of 7.'
    && (await page.getByRole('link', { name: 'All my bookings' }).getAttribute('href')) === '/pages/my-bookings.html');

  const titles = await page.locator('#dashboard-notifications .notice__title').allTextContents();
  t.check('student: the latest 3 notifications, newest first', titles.join(',') === 'Newest,Second newest,Third newest', titles.join(','));
  t.check('student: unread ones are marked in words, and nothing is marked as read by looking',
    (await page.locator('#dashboard-notifications .notice.is-unread .badge', { hasText: 'Unread' }).count()) === 2
    && (await page.locator('#dashboard-notifications button').count()) === 0
    && (await db.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [student.id])).rows[0].n === 2);
  await t.axe(page, 'student dashboard @ 1280px');
  await t.screenshot(page, 'student-dashboard-1280');

  // The figures agree with the page they link to.
  await page.click('[data-stat="pending"] a');
  await page.waitForSelector('.tabs__panel:not([aria-busy]) table');
  t.check('student: the Pending tab of My bookings lists the same 3', (await page.locator('.tabs__panel tbody tr').count()) === 3);

  // ---- Student: a source that fails ------------------------------------------------------------
  await page.route('**/api/bookings/mine', (route) => route.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server.' } }),
  }));
  t.expectConsoleError(/status of 500/);
  await page.goto(`${t.baseUrl}${STUDENT_HOME}`);
  await waitForDashboard(page);
  t.check('error: the bookings preview says it could not load and offers to try again',
    (await page.textContent('#dashboard-upcoming')).includes('Could not load your bookings')
    && (await page.locator('#dashboard-upcoming button', { hasText: 'Try again' }).count()) === 1);
  t.check('error: its two figures show no number rather than 0',
    (await stat(page, 'upcoming')).value === '–' && (await stat(page, 'pending')).value === '–'
    && (await stat(page, 'upcoming')).note === 'Could not be loaded');
  t.check('error: the notifications still load', (await stat(page, 'unread')).value === '2'
    && (await page.locator('#dashboard-notifications .notice').count()) === 3);
  await t.axe(page, 'student dashboard with a failed source @ 1280px');
  await page.unroute('**/api/bookings/mine');
  await page.click('#dashboard-upcoming button');
  await page.waitForSelector('#dashboard-upcoming .dash-item');
  await waitForDashboard(page);
  t.check('error: "Try again" loads everything', (await stat(page, 'upcoming')).value === '4' && (await items.count()) === 5);

  // A signed-in visitor to the home page goes to their dashboard.
  await page.goto(`${t.baseUrl}/`);
  await page.waitForURL(`${t.baseUrl}${STUDENT_HOME}`);
  t.check('student: the home page sends a signed-in student to the dashboard', true);
  const cookies = await context.cookies();
  await context.close();

  // ---- Student: on a phone ----------------------------------------------------------------------
  const { context: phoneContext, page: phone } = await t.newPage({ width: 320, height: 800, cookies });
  await phone.goto(`${t.baseUrl}${STUDENT_HOME}`);
  await waitForDashboard(phone);
  await t.noHorizontalOverflow(phone, 'student dashboard with bookings @ 320px');
  await t.axe(phone, 'student dashboard with bookings @ 320px');
  await t.screenshot(phone, 'student-dashboard-320');
  await phoneContext.close();

  // ---- Student: nothing yet ----------------------------------------------------------------------
  const newcomer = await newStudent('Dash Eta', 'dash.eta@kdu.example');
  const { context: emptyContext, page: empty } = await t.newPage({ width: 1280 });
  await t.signIn(empty, newcomer);
  await waitForDashboard(empty);
  t.check('empty: a new student sees three zeros',
    (await empty.locator('#dashboard-stats .stat__value').allTextContents()).join(',') === '0,0,0');
  t.check('empty: no upcoming bookings, with a way to start',
    (await empty.textContent('#dashboard-upcoming')).includes('No upcoming bookings')
    && (await empty.locator('#dashboard-upcoming a[href="/pages/facilities.html"]').count()) === 1);
  t.check('empty: no notifications yet', (await empty.textContent('#dashboard-notifications')).includes('No notifications yet'));
  await t.axe(empty, 'student dashboard, nothing yet @ 1280px');
  await emptyContext.close();

  // ---- Administrator: landing and figures ---------------------------------------------------------
  const { context: adminContext, page: admin } = await t.newPage({ width: 1280 });
  await t.signIn(admin, ACCOUNTS.admin);
  t.check('admin: signing in lands on the dashboard', new URL(admin.url()).pathname === ADMIN_HOME, admin.url());
  await waitForDashboard(admin);
  t.check('admin: the menu starts with Dashboard, marked as the current page',
    (await admin.locator('.nav__link').first().textContent()) === 'Dashboard'
    && (await admin.getAttribute('.nav__link[aria-current="page"]', 'href')) === ADMIN_HOME);

  const adminLabels = await admin.locator('#dashboard-stats .stat__label').allTextContents();
  t.check('admin: four figures, utilization named as an estimate',
    adminLabels.join(', ') === 'Pending requests, Bookings today, Active facilities, Utilization this week (estimate)', adminLabels.join(', '));

  const { rows: waiting } = await db.query("SELECT id FROM bookings WHERE status = 'pending' AND start_time > now() ORDER BY start_time, id");
  t.check('admin: pending requests is the number waiting on the Requests page, and links there',
    waiting.length > 5 && (await stat(admin, 'pending')).value === String(waiting.length)
    && (await stat(admin, 'pending')).href === '/pages/admin/requests.html', `${(await stat(admin, 'pending')).value} shown, ${waiting.length} stored`);

  const { rows: todays } = await db.query(
    `SELECT id FROM bookings
     WHERE status IN ('approved', 'completed') AND start_time >= $1::timestamptz AND start_time < $2::timestamptz
     ORDER BY start_time, id`,
    [`${campusDate(0)}T00:00:00+09:00`, `${campusDate(1)}T00:00:00+09:00`],
  );
  t.check('admin: bookings today counts today\'s approved bookings, and links to the schedule',
    todays.length > 0 && (await stat(admin, 'today')).value === String(todays.length)
    && (await stat(admin, 'today')).href === '/pages/admin/schedule.html', `${(await stat(admin, 'today')).value} shown, ${todays.length} stored`);

  const active = (await db.query("SELECT count(*)::int AS n FROM facilities WHERE status = 'active'")).rows[0].n;
  t.check('admin: active facilities counts the bookable ones, and links to Facilities',
    (await stat(admin, 'facilities')).value === String(active) && (await stat(admin, 'facilities')).href === '/pages/admin/facilities.html',
    `${(await stat(admin, 'facilities')).value} shown, ${active} stored`);

  // Utilization is the Reports figure for Monday to Sunday of this week.
  const week = { from: campusMonday(), to: new Date(Date.parse(`${campusMonday()}T00:00:00Z`) + 6 * DAY_MS).toISOString().slice(0, 10) };
  const { totals } = await admin.evaluate(async ({ from, to }) =>
    (await (await fetch(`/api/reports/summary?from=${from}&to=${to}`)).json()).data, week);
  const utilization = await stat(admin, 'utilization');
  t.check('admin: utilization is the Reports figure for Monday to Sunday of this week',
    totals.utilizationPercent !== null && utilization.value === `${NUMBER.format(totals.utilizationPercent)}%`,
    `${utilization.value} shown, ${totals.utilizationPercent} from the API`);
  t.check('admin: its note says "Estimate", gives the hours behind it and points to Reports',
    utilization.note.startsWith('Estimate: ')
    && utilization.note.includes(`${NUMBER.format(totals.bookedHours)} of ${NUMBER.format(totals.openHours)} open hours booked`)
    && utilization.note.includes('See Reports'), utilization.note);
  t.check('admin: the card links to Reports for the same week',
    utilization.href === `/pages/admin/reports.html?from=${week.from}&to=${week.to}`, utilization.href);

  // ---- Administrator: previews --------------------------------------------------------------------
  const requestRows = admin.locator('#dashboard-requests-table tbody tr');
  const shownIds = await requestRows.evaluateAll((rows) => rows.map((row) => row.dataset.requestId));
  t.check('admin: the 5 requests starting soonest, in the order of the Requests page',
    shownIds.join(',') === waiting.slice(0, 5).map((row) => row.id).join(','), shownIds.join(','));
  t.check('admin: says how many more are waiting, and that deciding is done on Requests',
    (await admin.textContent('#dashboard-requests .dash-more')).startsWith(`Showing the 5 starting soonest of ${waiting.length}.`)
    && (await admin.locator('#dashboard-requests button').count()) === 0
    && (await admin.getByRole('link', { name: 'Review all requests' }).getAttribute('href')) === '/pages/admin/requests.html');

  const todayIds = await admin.locator('#dashboard-today-table tbody tr').evaluateAll((rows) => rows.map((row) => row.dataset.bookingId));
  t.check('admin: today\'s bookings lists each approved booking of today',
    todayIds.length === todays.length && todayIds.includes(String(todayBooking)), `${todayIds.length} rows, ${todays.length} stored`);
  const lateRow = admin.locator(`#dashboard-today-table tr[data-booking-id="${todayBooking}"]`);
  const lateText = await lateRow.textContent();
  t.check('admin: a row has the time, facility, student, purpose and status',
    ['23:00–23:30', ROOM, 'ENG 991', 'Choi', 'Dashboard check: project meeting'].every((text) => lateText.includes(text))
    && (await lateRow.locator('.badge').count()) === 1, lateText);
  const times = await admin.locator('#dashboard-today-table tbody tr td:first-child').allTextContents();
  t.check('admin: today\'s bookings are in order of start time', times.every((time, index) => index === 0 || time >= times[index - 1]), times.join(', '));
  await t.axe(admin, 'admin dashboard @ 1280px');
  await t.screenshot(admin, 'admin-dashboard-1280');

  // The estimate card opens Reports on the same week, where the simplification is explained.
  await admin.click('[data-stat="utilization"] a');
  await admin.waitForSelector('#report:not([aria-busy]) table');
  t.check('admin: Reports opens on this week and explains the estimate',
    (await admin.inputValue('#range-from')) === week.from && (await admin.inputValue('#range-to')) === week.to
    && (await admin.textContent('[aria-labelledby="method-title"]')).includes('estimate'));

  // ---- Administrator: a source that fails ----------------------------------------------------------
  await admin.route('**/api/reports/summary**', (route) => route.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server.' } }),
  }));
  t.expectConsoleError(/status of 500/);
  await admin.goto(`${t.baseUrl}${ADMIN_HOME}`);
  await waitForDashboard(admin);
  t.check('error: a utilization figure that cannot be loaded shows no number, still named an estimate',
    (await stat(admin, 'utilization')).value === '–' && (await stat(admin, 'utilization')).note === 'Could not be loaded'
    && (await admin.textContent('[data-stat="utilization"] .stat__label')).includes('(estimate)'));
  t.check('error: the other figures and both previews still load',
    (await stat(admin, 'pending')).value === String(waiting.length) && (await requestRows.count()) === 5
    && (await admin.locator('#dashboard-today-table tbody tr').count()) === todays.length);
  await admin.unroute('**/api/reports/summary**');

  await admin.route('**/api/bookings/requests', (route) => route.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server.' } }),
  }));
  t.expectConsoleError(/status of 500/);
  await admin.reload();
  await waitForDashboard(admin);
  t.check('error: a failed requests preview says so, offers to try again, and its figure shows no number',
    (await admin.textContent('#dashboard-requests')).includes('Could not load the requests')
    && (await admin.locator('#dashboard-requests button', { hasText: 'Try again' }).count()) === 1
    && (await stat(admin, 'pending')).value === '–');
  await t.axe(admin, 'admin dashboard with a failed source @ 1280px');
  await admin.unroute('**/api/bookings/requests');
  await admin.click('#dashboard-requests button');
  await admin.waitForSelector('#dashboard-requests-table');
  await waitForDashboard(admin);
  t.check('error: "Try again" loads everything', (await stat(admin, 'pending')).value === String(waiting.length));

  await admin.goto(`${t.baseUrl}/`);
  await admin.waitForURL(`${t.baseUrl}${ADMIN_HOME}`);
  t.check('admin: the home page sends a signed-in administrator to the dashboard', true);
  const adminCookies = await adminContext.cookies();

  // ---- Who may open which dashboard ------------------------------------------------------------------
  await admin.goto(`${t.baseUrl}${STUDENT_HOME}`);
  await admin.waitForSelector('main .state');
  t.check('access: an administrator cannot open the student dashboard, and is pointed to their own',
    (await admin.textContent('main')).includes('This page is not available to your account')
    && (await admin.getAttribute('main .state a', 'href')) === ADMIN_HOME);
  await adminContext.close();

  const { context: studentContext, page: studentPage } = await t.newPage({ width: 1280, cookies });
  await studentPage.goto(`${t.baseUrl}${ADMIN_HOME}`);
  await studentPage.waitForSelector('main .state');
  t.check('access: a student cannot open the admin dashboard, and is pointed to their own',
    (await studentPage.textContent('main')).includes('This page is not available to your account')
    && (await studentPage.getAttribute('main .state a', 'href')) === STUDENT_HOME);
  await studentContext.close();

  // ---- Administrator: on a phone -------------------------------------------------------------------------
  const { context: adminPhoneContext, page: adminPhone } = await t.newPage({ width: 320, height: 800, cookies: adminCookies });
  await adminPhone.goto(`${t.baseUrl}${ADMIN_HOME}`);
  await waitForDashboard(adminPhone);
  t.check('phone: each request is a card that names its values',
    await adminPhone.locator('#dashboard-requests-table tbody tr').first().locator('.table__label').first().isVisible());
  await t.noHorizontalOverflow(adminPhone, 'admin dashboard @ 320px');
  await t.screenshot(adminPhone, 'admin-dashboard-320');
  await adminPhoneContext.close();
}

function waitForDashboard(page) {
  return page.waitForSelector('#dashboard:not([aria-busy]) .stat');
}

/** { value, note, href } of the figure with that data-stat name. */
async function stat(page, id) {
  const card = page.locator(`#dashboard-stats [data-stat="${id}"]`);
  return {
    value: await card.locator('.stat__value').textContent(),
    note: await card.locator('.stat__note').textContent(),
    href: await card.locator('a').getAttribute('href'),
  };
}
