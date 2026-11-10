// My bookings: the tabs and their counts, the table on desktop and cards on a phone,
// cancelling (keep, Escape, with and without a reason, a pending request whose start
// time has passed, and a booking changed by someone else meanwhile), the empty and error
// states, links into the page, and who may open it.
//
// It uses new students of its own, so the other groups' data never changes the counts.
import { ACCOUNTS } from '../harness.js';

const PASSWORD = 'Student@2026';
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const PAGE = '/pages/my-bookings.html';

// One booking per state. Purposes identify the rows.
const P = {
  now: 'Optics experiment, happening now',
  soon: 'Capstone demo rehearsal', // approved; an administrator cancels it while the dialog is open
  later: 'Robotics team practice', // approved; cancelled at 320px
  pending: 'Web programming lab practice', // cancelled at 320px, with a reason
  unreviewed: 'Request nobody reviewed', // pending, start time passed: cancelled from Past
  ended: 'Finished but still approved', // marked completed when the list loads
  completed: 'Lab report session',
  rejected: 'Photography club event',
  cancelled: 'Guest lecture',
};
const REJECTION = 'Classrooms are reserved for academic activities on weekday mornings.';
const ADMIN_REASON = 'The room is needed for a make-up examination.';

/** A date `daysAhead` from today in Korea, YYYY-MM-DD. */
function campusDate(daysAhead) {
  return new Date(Date.now() + KST_MS + daysAhead * DAY_MS).toISOString().slice(0, 10);
}
const at = (date, time) => `${date}T${time}:00+09:00`;

/** @param {import('../harness.js').Harness} t */
export default async function myBookings(t) {
  const db = t.db;
  const facility = Object.fromEntries((await db.query('SELECT id, name FROM facilities')).rows.map((row) => [row.name, row.id]));
  const adminId = (await db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;

  async function newStudent(email) {
    const { rows } = await db.query(
      `INSERT INTO users (full_name, email, password_hash, role)
       VALUES ('Browser Check Student', $1, crypt($2, gen_salt('bf', 4)), 'student') RETURNING id`,
      [email, PASSWORD],
    );
    return { id: rows[0].id, email, password: PASSWORD };
  }

  const student = await newStudent('my.bookings.check@kdu.example');
  async function seed(purpose, room, start, end, status, extra = {}) {
    const decided = ['approved', 'rejected', 'completed'].includes(status);
    const cancelled = status === 'cancelled';
    await db.query(
      `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status,
                             decided_by, decided_at, decision_note, cancelled_by, cancelled_at, cancellation_reason)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 6, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [student.id, facility[room], start, end, purpose, status,
        decided ? adminId : null, decided ? new Date() : null, extra.note ?? null,
        cancelled ? adminId : null, cancelled ? new Date() : null, extra.reason ?? null],
    );
  }
  // Far from the sample bookings (days -7 to +6) and the booking group's (days +1, +2).
  await seed(P.now, 'Physics Lab', new Date(Date.now() - 3600e3).toISOString(), new Date(Date.now() + 3600e3).toISOString(), 'approved');
  await seed(P.soon, 'Computer Lab A', at(campusDate(20), '10:00'), at(campusDate(20), '12:00'), 'approved');
  await seed(P.later, 'Computer Lab A', at(campusDate(24), '10:00'), at(campusDate(24), '12:00'), 'approved');
  await seed(P.pending, 'Computer Lab A', at(campusDate(21), '15:00'), at(campusDate(21), '17:00'), 'pending');
  await seed(P.unreviewed, 'Computer Lab A', at(campusDate(-2), '15:00'), at(campusDate(-2), '16:00'), 'pending');
  await seed(P.ended, 'Physics Lab', at(campusDate(-3), '09:00'), at(campusDate(-3), '10:00'), 'approved');
  await seed(P.completed, 'Physics Lab', at(campusDate(-5), '09:00'), at(campusDate(-5), '10:00'), 'completed');
  await seed(P.rejected, 'Computer Lab A', at(campusDate(22), '09:00'), at(campusDate(22), '12:00'), 'rejected', { note: REJECTION });
  await seed(P.cancelled, 'Computer Lab A', at(campusDate(23), '10:00'), at(campusDate(23), '12:00'), 'cancelled', { reason: ADMIN_REASON });

  // Always this student's row: some purposes also occur in the sample data.
  const statusOf = async (purpose) => (await db.query(
    'SELECT status, cancelled_by, cancellation_reason FROM bookings WHERE user_id = $1 AND purpose = $2',
    [student.id, purpose],
  )).rows[0];

  // ---- Desktop: the table, counts, order, keyboard -------------------------------------
  const { context, page } = await t.newPage({ width: 1280 });
  await t.signIn(page, student, PAGE);
  await waitForPanel(page);

  t.check('my bookings: the menu links here and marks it as the current page',
    (await page.getAttribute('.nav a[href="/pages/my-bookings.html"]', 'aria-current')) === 'page');
  const counts = await tabCounts(page);
  t.check('my bookings: tab counts (3 upcoming, 1 pending, 3 past, 2 cancelled & rejected)',
    JSON.stringify(counts) === '["3","1","3","2"]', JSON.stringify(counts));
  t.check('my bookings: an approved booking that has ended was marked completed when the list loaded',
    (await statusOf(P.ended)).status === 'completed');
  t.check('my bookings: Upcoming is selected first', (await selectedTab(page)) === 'Upcoming');
  t.check('my bookings: upcoming bookings start with the soonest',
    JSON.stringify(await purposes(page)) === JSON.stringify([P.now, P.soon, P.later]), JSON.stringify(await purposes(page)));
  t.check('my bookings: a booking in progress says so and cannot be cancelled',
    (await row(page, P.now).textContent()).includes('Happening now.') && (await row(page, P.now).getByRole('button').count()) === 0);
  const buttonName = await row(page, P.soon).getByRole('button').evaluate((button) => button.textContent.trim());
  t.check('my bookings: each cancel button names its booking for screen readers',
    buttonName.startsWith('Cancel booking: Computer Lab A, ') && buttonName.endsWith(', 10:00'), buttonName);
  t.check('my bookings: a table on desktop, with its header row shown',
    await page.evaluate(() => getComputedStyle(document.querySelector('.tabs__panel thead')).position !== 'absolute'
      && getComputedStyle(document.querySelector('.tabs__panel tbody tr')).display === 'table-row'));
  await t.noHorizontalOverflow(page, 'my bookings @ 1280px');
  await t.axe(page, 'my bookings @ 1280px');
  await t.screenshot(page, 'my-bookings-1280');

  // Keyboard: arrows, Home and End move between tabs and select them
  await page.getByRole('tab', { name: /^Upcoming/ }).focus();
  await page.keyboard.press('ArrowRight');
  t.check('keyboard: Right arrow selects and focuses the next tab',
    (await selectedTab(page)) === 'Pending' && (await focusedTab(page)) === 'Pending');
  t.check('my bookings: the chosen tab is kept in the address', new URL(page.url()).searchParams.get('tab') === 'pending');
  t.check('my bookings: the panel shows that tab', JSON.stringify(await purposes(page)) === JSON.stringify([P.pending]));
  await page.keyboard.press('End');
  t.check('keyboard: End selects the last tab', (await selectedTab(page)) === 'Cancelled & rejected');
  await page.keyboard.press('Home');
  t.check('keyboard: Home selects the first tab', (await selectedTab(page)) === 'Upcoming' && new URL(page.url()).searchParams.get('tab') === null);
  await page.keyboard.press('ArrowLeft');
  t.check('keyboard: Left arrow from the first tab wraps to the last', (await selectedTab(page)) === 'Cancelled & rejected');
  t.check('keyboard: only the selected tab is a Tab stop',
    (await page.locator('[role=tab][tabindex="0"]').count()) === 1 && (await page.locator('[role=tab][tabindex="-1"]').count()) === 3);
  t.check('keyboard: the focused tab shows a focus ring', await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
  }));
  await page.keyboard.press('Tab');
  t.check('keyboard: Tab goes from the tabs into the panel', await page.evaluate(() => document.activeElement.getAttribute('role') === 'tabpanel'));

  const closedText = await page.textContent('.tabs__panel');
  t.check('my bookings: a rejected request shows the administrator\'s reason', closedText.includes(`Reason: ${REJECTION}`));
  t.check('my bookings: a booking cancelled by an administrator says so, with the reason',
    closedText.includes(`Cancelled by an administrator. Reason: ${ADMIN_REASON}`));
  t.check('my bookings: nothing cancelled or rejected can be cancelled', (await page.locator('.tabs__panel button').count()) === 0);
  await t.axe(page, 'my bookings, cancelled & rejected @ 1280px');

  // Past: completed bookings, and a request nobody reviewed, which can still be cancelled
  await page.getByRole('tab', { name: /^Past/ }).click();
  t.check('my bookings: past bookings start with the latest',
    JSON.stringify(await purposes(page)) === JSON.stringify([P.unreviewed, P.ended, P.completed]), JSON.stringify(await purposes(page)));
  t.check('my bookings: a request nobody reviewed says so', (await row(page, P.unreviewed).textContent()).includes('Not reviewed before the start time.'));
  t.check('my bookings: completed bookings cannot be cancelled', (await row(page, P.completed).getByRole('button').count()) === 0);
  await row(page, P.unreviewed).getByRole('button', { name: /^Cancel request/ }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Cancel request', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected=true] .tabs__count').textContent === '2');
  const unreviewed = await statusOf(P.unreviewed);
  t.check('cancel: a pending request whose start time has passed can be cancelled, without a reason',
    unreviewed.status === 'cancelled' && unreviewed.cancelled_by === student.id && unreviewed.cancellation_reason === null, JSON.stringify(unreviewed));
  t.check('cancel: the counts move it to Cancelled & rejected', JSON.stringify(await tabCounts(page)) === '["3","1","2","3"]', JSON.stringify(await tabCounts(page)));
  t.check('cancel: focus returns to the selected tab', (await focusedTab(page)) === 'Past');
  t.check('cancel: a toast confirms it', (await page.textContent('.toast-region')).includes('Request cancelled'));
  const cookies = await context.cookies();
  await context.close();

  // ---- Phone: cards, the dialog, cancelling --------------------------------------------
  const { page: phone } = await t.newPage({ width: 320, height: 800, cookies });
  await phone.goto(`${t.baseUrl}${PAGE}`);
  await waitForPanel(phone);
  t.check('320px: each booking is a card, with the column names shown inside it', await phone.evaluate(() => {
    const row = document.querySelector('.tabs__panel tbody tr');
    return getComputedStyle(row).display === 'block'
      && getComputedStyle(document.querySelector('.tabs__panel thead')).position === 'absolute'
      && getComputedStyle(row.querySelector('.table__label')).display === 'block';
  }));
  t.check('320px: the cards fit; nothing scrolls sideways inside the list',
    await phone.evaluate(() => { const wrap = document.querySelector('.table-wrap'); return wrap.scrollWidth <= wrap.clientWidth; }));
  t.check('320px: all four tabs are on screen', await phone.evaluate(() => [...document.querySelectorAll('[role=tab]')]
    .every((tab) => { const box = tab.getBoundingClientRect(); return box.left >= 0 && box.right <= window.innerWidth; })));
  await t.noHorizontalOverflow(phone, 'my bookings @ 320px');
  await t.axe(phone, 'my bookings @ 320px');
  await t.screenshot(phone, 'my-bookings-320');

  // Keep, Escape, then cancel with a reason
  await phone.getByRole('tab', { name: /^Pending/ }).click();
  const pendingButton = row(phone, P.pending).getByRole('button', { name: /^Cancel request/ });
  await pendingButton.click();
  const dialog = phone.locator('dialog[open]');
  await dialog.waitFor();
  t.check('dialog: asks before cancelling, naming the booking',
    (await dialog.getByRole('heading').textContent()) === 'Cancel this request?' && (await dialog.textContent()).includes('Computer Lab A (ENG 310)'));
  t.check('dialog: focus starts in the reason box', await phone.evaluate(() => document.activeElement.matches('dialog textarea[name=reason]')));
  t.check('dialog: centred on screen', await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.left > 0 && box.right < window.innerWidth && box.top > 0 && Math.abs(box.left - (window.innerWidth - box.right)) <= 1;
  }));
  await t.noHorizontalOverflow(phone, 'cancel dialog @ 320px');
  await t.axe(phone, 'cancel dialog @ 320px');
  await t.screenshot(phone, 'my-bookings-320-dialog');
  await phone.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  t.check('dialog: Escape keeps the request', (await statusOf(P.pending)).status === 'pending');
  t.check('dialog: focus returns to the button that opened it', await pendingButton.evaluate((button) => button === document.activeElement));

  await pendingButton.click();
  await dialog.getByRole('button', { name: 'Keep request' }).click();
  await dialog.waitFor({ state: 'detached' });
  t.check('dialog: "Keep request" keeps it', (await statusOf(P.pending)).status === 'pending');

  await pendingButton.click();
  await dialog.locator('textarea').fill('The lab moved to next week.');
  await dialog.getByRole('button', { name: 'Cancel request', exact: true }).click();
  await phone.waitForSelector('.tabs__panel .state');
  const cancelledPending = await statusOf(P.pending);
  t.check('cancel: the request is cancelled with the reason given',
    cancelledPending.status === 'cancelled' && cancelledPending.cancellation_reason === 'The lab moved to next week.', JSON.stringify(cancelledPending));
  const emptyText = await phone.textContent('.tabs__panel');
  t.check('cancel: an empty Pending tab says so and offers the facilities',
    emptyText.includes('No pending requests') && (await phone.locator('.tabs__panel a[href="/pages/facilities.html"]').count()) === 1);
  await t.axe(phone, 'my bookings, empty tab @ 320px');
  await phone.getByRole('tab', { name: /^Cancelled/ }).click();
  t.check('cancel: it now reads "Cancelled by you", with the reason',
    (await row(phone, P.pending).textContent()).includes('Cancelled by you. Reason: The lab moved to next week.'));

  // Changed by someone else while the dialog was open
  await phone.getByRole('tab', { name: /^Upcoming/ }).click();
  await row(phone, P.soon).getByRole('button').click();
  await dialog.waitFor();
  await db.query(
    "UPDATE bookings SET status = 'cancelled', cancelled_by = $1, cancelled_at = now(), cancellation_reason = 'Building closed' WHERE user_id = $2 AND purpose = $3",
    [adminId, student.id, P.soon],
  );
  await dialog.getByRole('button', { name: 'Cancel booking', exact: true }).click();
  await phone.waitForSelector('#bookings-alert .alert--danger');
  await waitForPanel(phone);
  const alert = await phone.textContent('#bookings-alert');
  t.check('conflict: says why it could not be cancelled', alert.includes('Could not cancel') && alert.includes('This booking has already been cancelled.'), alert);
  t.check('conflict: the list is reloaded, and the booking has left Upcoming',
    JSON.stringify(await purposes(phone)) === JSON.stringify([P.now, P.later]), JSON.stringify(await purposes(phone)));
  t.check('conflict: the administrator\'s cancellation is what was stored', (await statusOf(P.soon)).cancellation_reason === 'Building closed');
  await t.noHorizontalOverflow(phone, 'my bookings with an alert @ 320px');
  await t.axe(phone, 'my bookings with an alert @ 320px');
  await t.screenshot(phone, 'my-bookings-320-conflict');

  // An approved booking, cancelled
  await row(phone, P.later).getByRole('button', { name: /^Cancel booking/ }).click();
  t.check('dialog: an approved booking is a "booking", and the room is freed',
    (await dialog.getByRole('heading').textContent()) === 'Cancel this booking?' && (await dialog.textContent()).includes('The room becomes free for others to book.'));
  await dialog.getByRole('button', { name: 'Cancel booking', exact: true }).click();
  await phone.waitForFunction(() => document.querySelector('[role=tab][aria-selected=true] .tabs__count').textContent === '1');
  t.check('cancel: an approved booking that has not started is cancelled', (await statusOf(P.later)).status === 'cancelled');
  t.check('cancel: the earlier alert is cleared', (await phone.textContent('#bookings-alert')).trim() === '');

  // ---- Links into the page ---------------------------------------------------------------
  await phone.goto(`${t.baseUrl}${PAGE}?tab=closed`);
  await waitForPanel(phone);
  t.check('link: ?tab=closed opens Cancelled & rejected', (await selectedTab(phone)) === 'Cancelled & rejected');
  await phone.goto(`${t.baseUrl}${PAGE}?tab=nonsense`);
  await waitForPanel(phone);
  t.check('link: an unknown tab opens Upcoming', (await selectedTab(phone)) === 'Upcoming');

  // ---- Error, then retry -------------------------------------------------------------------
  await phone.route('**/api/bookings/mine', (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again later.' } }),
  }));
  t.expectConsoleError(/status of 500/);
  await phone.reload();
  await phone.waitForSelector('.tabs__panel .state--error');
  t.check('error: a failed load says so and offers to try again',
    (await phone.textContent('.tabs__panel')).includes('Could not load your bookings') && (await phone.locator('.tabs__panel button', { hasText: 'Try again' }).count()) === 1);
  t.check('error: no counts are shown while the list is unknown', (await phone.locator('.tabs__count:not([hidden])').count()) === 0);
  await t.axe(phone, 'my bookings, load error @ 320px');
  await phone.unroute('**/api/bookings/mine');
  await phone.click('.tabs__panel button');
  await waitForPanel(phone);
  t.check('error: "Try again" loads the list', (await purposes(phone)).length > 0 && (await phone.locator('.tabs__count:not([hidden])').count()) === 4);

  // ---- A student with no bookings ---------------------------------------------------------
  const newcomer = await newStudent('no.bookings.yet@kdu.example');
  const { page: empty } = await t.newPage({ width: 320, height: 800 });
  await t.signIn(empty, newcomer, PAGE);
  await waitForPanel(empty);
  t.check('empty: a new student sees zero everywhere and a way to start', JSON.stringify(await tabCounts(empty)) === '["0","0","0","0"]'
    && (await empty.textContent('.tabs__panel')).includes('No upcoming bookings')
    && (await empty.locator('.tabs__panel a[href="/pages/facilities.html"]').count()) === 1);

  // ---- Who may open it ---------------------------------------------------------------------
  const { page: adminPage } = await t.newPage({ width: 1280 });
  await t.signIn(adminPage, ACCOUNTS.admin, PAGE);
  await adminPage.waitForSelector('main .state');
  t.check('access: an administrator is told the page is for students',
    (await adminPage.textContent('main')).includes('This page is not available to your account'));
  t.check('access: administrators have no "My bookings" menu link', (await adminPage.locator('.nav a[href="/pages/my-bookings.html"]').count()) === 0);
}

/** Waits until the panel has finished loading and shows something. */
function waitForPanel(page) {
  return page.waitForSelector('.tabs__panel:not([aria-busy]) > *');
}

function tabCounts(page) {
  return page.$$eval('[role=tab] .tabs__count', (counts) => counts.map((count) => count.textContent));
}

// A tab's first child is its label; the count follows it.
function selectedTab(page) {
  return page.$eval('[role=tab][aria-selected=true]', (tab) => tab.firstChild.textContent.trim());
}

function focusedTab(page) {
  return page.evaluate(() => (document.activeElement.getAttribute('role') === 'tab' ? document.activeElement.firstChild.textContent.trim() : null));
}

/** The purposes of the rows on the selected tab, top to bottom. */
function purposes(page) {
  return page.$$eval('.tabs__panel tbody tr', (rows) => rows.map((row) => row.cells[3].firstChild.nextSibling.textContent));
}

function row(page, purpose) {
  return page.locator('.tabs__panel tbody tr', { hasText: purpose });
}
