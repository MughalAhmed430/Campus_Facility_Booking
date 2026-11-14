// Notifications as a student: nothing yet, then an approval, a rejection and an
// administrator's cancellation made through the real API; the unread count in the menu on
// every page; marking one and then all as read; the error state; a phone; and that
// administrators have no notifications page.
//
// It uses a student of its own, with requests 60+ days ahead in a room no other group
// books then.
import { ACCOUNTS } from '../harness.js';

const PASSWORD = 'Student@2026';
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const PAGE = '/pages/notifications.html';
const ROOM = 'Chemistry Lab';
const NOTE = 'Wear a lab coat.';
const REJECT_REASON = 'The fume hoods are being serviced that day.';
const CANCEL_REASON = 'The lab has to close for an inspection.';

/** A date `daysAhead` from today in Korea, YYYY-MM-DD. */
function campusDate(daysAhead) {
  return new Date(Date.now() + KST_MS + daysAhead * DAY_MS).toISOString().slice(0, 10);
}

/** @param {import('../harness.js').Harness} t */
export default async function notifications(t) {
  const db = t.db;
  const roomId = (await db.query('SELECT id FROM facilities WHERE name = $1', [ROOM])).rows[0].id;
  const adminId = (await db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;
  const { rows: [created] } = await db.query(
    `INSERT INTO users (full_name, email, password_hash, role)
     VALUES ('Notify Epsilon', 'notify.epsilon@kdu.example', crypt($1, gen_salt('bf', 4)), 'student') RETURNING id`,
    [PASSWORD],
  );
  const student = { id: created.id, email: 'notify.epsilon@kdu.example', password: PASSWORD };

  async function seed(daysAhead, status = 'pending') {
    const date = campusDate(daysAhead);
    const approved = status === 'approved';
    const { rows } = await db.query(
      `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status, decided_by, decided_at)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 6, 'Notify check: titration practice', $5, $6, $7) RETURNING id`,
      [student.id, roomId, `${date}T10:00:00+09:00`, `${date}T11:00:00+09:00`, status, approved ? adminId : null, approved ? new Date() : null],
    );
    return rows[0].id;
  }

  // The administrator's decisions go through the real API, so the notifications are the real ones.
  const login = await fetch(`${t.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ACCOUNTS.admin),
  });
  const adminCookie = login.headers.getSetCookie().find((cookie) => cookie.startsWith('sid=')).split(';')[0];
  async function decide(path, body) {
    const response = await fetch(`${t.baseUrl}/api${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify(body),
    });
    if (response.status !== 200) throw new Error(`${path} answered ${response.status}`);
  }

  // ---- Nothing yet ----------------------------------------------------------------------
  const { context, page } = await t.newPage({ width: 1280 });
  await t.signIn(page, student, PAGE);
  await waitForList(page);
  t.check('empty: the menu has a Notifications link, marked as the current page, with no number',
    (await page.getAttribute(`.nav a[href="${PAGE}"]`, 'aria-current')) === 'page' && !(await page.isVisible('.nav__count')));
  t.check('empty: says there are none yet, and nothing to mark',
    (await page.textContent('#notifications')).includes('No notifications yet') && !(await page.isVisible('#mark-all')));
  await t.axe(page, 'notifications, none yet @ 1280px');

  // ---- An approval, a rejection and a cancellation arrive ---------------------------------
  const approvedId = await seed(60);
  const rejectedId = await seed(61);
  const cancelledId = await seed(62, 'approved');
  await decide(`/bookings/${approvedId}/approve`, { note: NOTE });
  await decide(`/bookings/${rejectedId}/reject`, { reason: REJECT_REASON });
  await decide(`/bookings/${cancelledId}/cancel`, { reason: CANCEL_REASON });

  await page.goto(`${t.baseUrl}/pages/facilities.html`);
  await page.waitForSelector('.nav__count:not([hidden])');
  const countText = await page.textContent('.nav__count');
  t.check('menu: on any page, the Notifications link shows how many are unread', countText === '3 unread', countText);
  await t.axe(page, 'facilities with an unread count in the menu @ 1280px');

  await page.click(`.nav a[href="${PAGE}"]`);
  await waitForList(page);
  const items = page.locator('#notifications .notice');
  const titles = await items.locator('.notice__title').allTextContents();
  t.check('list: newest first', JSON.stringify(titles) === JSON.stringify(['Booking cancelled', 'Booking request rejected', 'Booking request approved']), JSON.stringify(titles));
  t.check('list: all three are unread, and the count says so',
    (await page.locator('#notifications .notice.is-unread .badge', { hasText: 'Unread' }).count()) === 3 && (await page.textContent('#notifications-count')) === '3 unread.');
  const texts = await items.locator('.notice__message').allTextContents();
  t.check('list: each says what happened, where, and the administrator\'s note or reason',
    texts[0].includes(`Your booking for ${ROOM} (SCI 205)`) && texts[0].endsWith(`was cancelled by an administrator. Reason: ${CANCEL_REASON}`)
    && texts[1].endsWith(`was rejected. Reason: ${REJECT_REASON}`) && texts[2].endsWith(`was approved. Note: ${NOTE}`), JSON.stringify(texts));
  t.check('list: nothing names the administrator', !(await page.textContent('#notifications')).includes('Facilities Administrator'));
  const links = await items.getByRole('link', { name: /^View in My bookings/ }).evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href')));
  t.check('list: each links to the right tab of My bookings',
    JSON.stringify(links) === JSON.stringify(['/pages/my-bookings.html?tab=closed', '/pages/my-bookings.html?tab=closed', '/pages/my-bookings.html']), JSON.stringify(links));
  await t.noHorizontalOverflow(page, 'notifications @ 1280px');
  await t.axe(page, 'notifications @ 1280px');
  await t.screenshot(page, 'notifications-1280');

  // ---- Marking as read ------------------------------------------------------------------------
  const first = items.nth(0);
  const readButton = first.getByRole('button', { name: /^Mark as read/ });
  const buttonName = await readButton.evaluate((button) => button.textContent.trim());
  t.check('read one: the button names its notification for screen readers', buttonName.startsWith('Mark as read: Booking cancelled, '), buttonName);
  await readButton.click();
  await page.waitForFunction(() => document.getElementById('notifications-count').textContent === '2 unread.');
  t.check('read one: it loses its badge and button, and the others keep theirs',
    (await first.locator('.badge').count()) === 0 && (await first.getByRole('button').count()) === 0
    && (await page.locator('#notifications .notice.is-unread').count()) === 2);
  t.check('read one: the menu count goes down', (await page.textContent('.nav__count')) === '2 unread');
  t.check('read one: focus stays on that notification', await first.getByRole('link').evaluate((link) => link === document.activeElement));
  t.check('read one: stored', (await db.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [student.id])).rows[0].n === 2);
  await page.reload();
  await waitForList(page);
  t.check('read one: still read after a reload', (await page.textContent('#notifications-count')) === '2 unread.');

  await page.click('#mark-all');
  await page.waitForFunction(() => document.getElementById('notifications-count').textContent === 'You have read them all.');
  t.check('read all: no badges or buttons are left, and the button itself goes',
    (await page.locator('#notifications .notice.is-unread').count()) === 0 && !(await page.isVisible('#mark-all')));
  t.check('read all: the menu shows no number', !(await page.isVisible('.nav__count')));
  t.check('read all: a toast says how many', (await page.textContent('.toast-region')).includes('2 notifications marked as read.'));
  t.check('read all: focus moves to the page title', await page.evaluate(() => document.activeElement.id === 'notifications-title'));
  t.check('read all: stored', (await db.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [student.id])).rows[0].n === 0);
  await t.axe(page, 'notifications, all read @ 1280px');

  // ---- Error state ------------------------------------------------------------------------------
  await page.route('**/api/notifications', (route) => route.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again later.' } }),
  }));
  t.expectConsoleError(/status of 500/);
  await page.reload();
  await page.waitForSelector('#notifications .state--error');
  t.check('error: a failed load says so and offers to try again',
    (await page.textContent('#notifications')).includes('Could not load your notifications') && (await page.locator('#notifications button', { hasText: 'Try again' }).count()) === 1);
  await page.unroute('**/api/notifications');
  await page.click('#notifications button');
  await waitForList(page);
  t.check('error: "Try again" loads the list', (await items.count()) === 3);
  const cookies = await context.cookies();
  await context.close();

  // ---- Phone --------------------------------------------------------------------------------------
  await db.query('UPDATE notifications SET read_at = NULL WHERE user_id = $1', [student.id]);
  const { page: phone } = await t.newPage({ width: 320, height: 800, cookies });
  await phone.goto(`${t.baseUrl}${PAGE}`);
  await waitForList(phone);
  await t.noHorizontalOverflow(phone, 'notifications @ 320px');
  await t.axe(phone, 'notifications @ 320px');
  await t.screenshot(phone, 'notifications-320');
  await phone.click('.nav-toggle');
  t.check('320px: the opened menu shows the unread count', (await phone.textContent('.nav__count')) === '3 unread' && (await phone.isVisible('.nav__count')));
  await t.axe(phone, 'menu open with an unread count @ 320px');

  // ---- Administrators have none ---------------------------------------------------------------------
  const { page: adminPage } = await t.newPage({ width: 1280 });
  await t.signIn(adminPage, ACCOUNTS.admin);
  t.check('admin: no Notifications link in the menu', (await adminPage.locator(`.nav a[href="${PAGE}"]`).count()) === 0);
  await adminPage.goto(`${t.baseUrl}${PAGE}`);
  await adminPage.waitForSelector('main .state');
  t.check('admin: the page says it is for students', (await adminPage.textContent('main')).includes('This page is not available to your account'));
}

/** Waits until the list has finished loading and shows something. */
function waitForList(page) {
  return page.waitForSelector('#notifications:not([aria-busy]) > *');
}
