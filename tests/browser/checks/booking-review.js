// Reviewing requests as an administrator: the queue and its clash markers, approving
// (which rejects the overlapping request too), rejecting with a required reason, a request
// decided by someone else while the dialog was open, the empty and error states, what each
// student then sees on My bookings, and who may open the page.
//
// It uses students of its own, with requests 30+ days ahead in a room no other group
// books then. Counts are read from the database, so the other groups' data does not matter.
import { ACCOUNTS } from '../harness.js';

const PASSWORD = 'Student@2026';
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const PAGE = '/pages/admin/requests.html';
const ROOM = 'Physics Lab';

const P = {
  chosen: 'Review check: optics write-up', // approved, with a note
  overlapping: 'Review check: club practice', // rejected automatically with it
  approvedEarlier: 'Review check: approved earlier',
  taken: 'Review check: after an approval', // its time is already approved
  rejectMe: 'Review check: too many people', // rejected with a reason
  decidedElsewhere: 'Review check: decided elsewhere', // rejected by someone else while the dialog is open
};
const NOTE = 'Collect the key from the physics office.';
const REASON = 'Please book the lecture hall for a group this size.';
const AUTO_REJECT_NOTE = 'Another request for this time was approved.';

/** A date `daysAhead` from today in Korea, YYYY-MM-DD. */
function campusDate(daysAhead) {
  return new Date(Date.now() + KST_MS + daysAhead * DAY_MS).toISOString().slice(0, 10);
}

/** @param {import('../harness.js').Harness} t */
export default async function bookingReview(t) {
  const db = t.db;
  const roomId = (await db.query('SELECT id FROM facilities WHERE name = $1', [ROOM])).rows[0].id;
  const adminId = (await db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;

  async function newStudent(name, email) {
    const { rows } = await db.query(
      `INSERT INTO users (full_name, email, password_hash, role)
       VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), 'student') RETURNING id`,
      [name, email, PASSWORD],
    );
    return { id: rows[0].id, name, email, password: PASSWORD };
  }
  const alpha = await newStudent('Review Alpha', 'review.alpha@kdu.example');
  const beta = await newStudent('Review Beta', 'review.beta@kdu.example');

  async function seed(owner, purpose, daysAhead, startTime, endTime, status = 'pending') {
    const date = campusDate(daysAhead);
    const approved = status === 'approved';
    await db.query(
      `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status, decided_by, decided_at)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 6, $5, $6, $7, $8)`,
      [owner.id, roomId, `${date}T${startTime}:00+09:00`, `${date}T${endTime}:00+09:00`, purpose, status,
        approved ? adminId : null, approved ? new Date() : null],
    );
  }
  await seed(alpha, P.chosen, 30, '10:00', '12:00');
  await seed(beta, P.overlapping, 30, '11:00', '12:30');
  await seed(alpha, P.approvedEarlier, 31, '14:00', '15:00', 'approved');
  await seed(beta, P.taken, 31, '14:30', '15:30');
  await seed(alpha, P.rejectMe, 32, '09:00', '10:00');
  await seed(alpha, P.decidedElsewhere, 33, '09:00', '10:00');

  const stored = async (purpose) => (await db.query(
    'SELECT status, decision_note, decided_by FROM bookings WHERE purpose = $1 AND user_id = ANY($2::int[])',
    [purpose, [alpha.id, beta.id]],
  )).rows[0];
  const waiting = async () => (await db.query("SELECT count(*)::int AS n FROM bookings WHERE status = 'pending' AND start_time > now()")).rows[0].n;

  // ---- Desktop: the queue -------------------------------------------------------------
  const { context, page } = await t.newPage({ width: 1280 });
  await t.signIn(page, ACCOUNTS.admin);
  await waitForList(page);
  t.check('requests: an administrator starts here after signing in', new URL(page.url()).pathname === PAGE, page.url());
  t.check('requests: the menu marks Requests as the current page',
    (await page.getAttribute(`.nav a[href="${PAGE}"]`, 'aria-current')) === 'page');
  const expected = await waiting();
  const countText = await page.textContent('#requests-count');
  t.check('requests: the count matches the pending requests that have not started', countText === `${expected} requests waiting for a decision.`, countText);
  const order = (await purposes(page)).filter((purpose) => Object.values(P).includes(purpose));
  t.check('requests: soonest first', JSON.stringify(order) === JSON.stringify([P.chosen, P.overlapping, P.taken, P.rejectMe, P.decidedElsewhere]), JSON.stringify(order));
  const chosenRow = await row(page, P.chosen).textContent();
  t.check('requests: overlapping requests are marked, naming the other student and time',
    chosenRow.includes('Overlaps 1 request') && chosenRow.includes('Review Beta, 11:00–12:30'), chosenRow);
  t.check('requests: a request whose time is already approved says so and cannot be approved',
    (await row(page, P.taken).textContent()).includes('Time already booked')
    && (await row(page, P.taken).getByRole('button', { name: /^Approve/ }).isDisabled()));
  const approveName = await row(page, P.chosen).getByRole('button', { name: /^Approve/ }).evaluate((button) => button.textContent.trim());
  t.check('requests: each button names its request for screen readers',
    approveName.startsWith('Approve: Review Alpha, Physics Lab, ') && approveName.endsWith(', 10:00'), approveName);
  t.check('requests: participants are shown against the room\'s capacity', chosenRow.includes('6 of 20 people'), chosenRow);
  await t.noHorizontalOverflow(page, 'admin requests @ 1280px');
  await t.axe(page, 'admin requests @ 1280px');
  await t.screenshot(page, 'admin-requests-1280');

  // Approving one rejects the overlapping one along with it
  const dialog = page.locator('dialog[open]');
  await row(page, P.chosen).getByRole('button', { name: /^Approve/ }).click();
  await dialog.waitFor();
  const approveText = await dialog.textContent();
  t.check('approve: the dialog names the request it will also reject',
    approveText.includes('Approving it also rejects this overlapping request:') && approveText.includes('Review Beta, 11:00–12:30'), approveText);
  t.check('approve: focus starts in the note box', await page.evaluate(() => document.activeElement.matches('dialog textarea')));
  await t.axe(page, 'approve dialog @ 1280px');
  await t.screenshot(page, 'admin-requests-1280-approve');
  await dialog.locator('textarea').fill(NOTE);
  await dialog.getByRole('button', { name: 'Approve request', exact: true }).click();
  await row(page, P.chosen).waitFor({ state: 'detached' });
  const chosen = await stored(P.chosen);
  const overlapping = await stored(P.overlapping);
  t.check('approve: approved with the note, by this administrator',
    chosen.status === 'approved' && chosen.decision_note === NOTE && chosen.decided_by === adminId, JSON.stringify(chosen));
  t.check('approve: the overlapping request is rejected automatically, with the reason',
    overlapping.status === 'rejected' && overlapping.decision_note === AUTO_REJECT_NOTE, JSON.stringify(overlapping));
  t.check('approve: both leave the list, and the count goes down by two',
    (await row(page, P.overlapping).count()) === 0 && (await page.textContent('#requests-count')) === `${expected - 2} requests waiting for a decision.`);
  t.check('approve: a toast says what happened', (await page.textContent('.toast-region')).includes('Request approved. 1 overlapping request rejected.'));
  t.check('approve: focus moves to the request that took its place', await page.evaluate(() => document.activeElement.tagName === 'BUTTON' && Boolean(document.activeElement.closest('#requests tbody'))));

  // Rejecting needs a reason
  await row(page, P.rejectMe).getByRole('button', { name: /^Reject/ }).click();
  await dialog.waitFor();
  const confirmReject = dialog.getByRole('button', { name: 'Reject request', exact: true });
  await confirmReject.click();
  t.check('reject: confirming without a reason keeps the dialog open and says why',
    (await dialog.isVisible()) && (await dialog.locator('.field-error').textContent()) === 'Reason is required.'
    && (await dialog.locator('textarea').getAttribute('aria-invalid')) === 'true');
  await dialog.locator('textarea').fill('No.');
  await confirmReject.click();
  t.check('reject: a reason under 5 characters is refused too', (await dialog.locator('.field-error').textContent()) === 'Reason must be at least 5 characters.');
  t.check('reject: the error is announced with the box', await dialog.locator('textarea').evaluate((box) => box.getAttribute('aria-describedby').includes(document.querySelector('dialog .field-error').id)));
  await t.axe(page, 'reject dialog with an error @ 1280px');
  await t.screenshot(page, 'admin-requests-1280-reject-error');
  await dialog.locator('textarea').fill(REASON);
  await confirmReject.click();
  await row(page, P.rejectMe).waitFor({ state: 'detached' });
  const rejected = await stored(P.rejectMe);
  t.check('reject: stored with the reason, by this administrator',
    rejected.status === 'rejected' && rejected.decision_note === REASON && rejected.decided_by === adminId, JSON.stringify(rejected));

  // Escape keeps the request
  const takenReject = row(page, P.taken).getByRole('button', { name: /^Reject/ });
  await takenReject.click();
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  t.check('dialog: Escape keeps the request, and focus returns to its button',
    (await stored(P.taken)).status === 'pending' && (await takenReject.evaluate((button) => button === document.activeElement)));

  // Decided by someone else while the dialog was open
  await row(page, P.decidedElsewhere).getByRole('button', { name: /^Approve/ }).click();
  await dialog.waitFor();
  await db.query(
    `UPDATE bookings SET status = 'rejected', decided_by = $1, decided_at = now(), decision_note = 'Decided by another administrator.'
     WHERE purpose = $2 AND user_id = $3`,
    [adminId, P.decidedElsewhere, alpha.id],
  );
  await dialog.getByRole('button', { name: 'Approve request', exact: true }).click();
  await page.waitForSelector('#requests-alert .alert--danger');
  await waitForList(page);
  const alertText = await page.textContent('#requests-alert');
  t.check('conflict: says the decision could not be saved, and why',
    alertText.includes('Could not save the decision') && alertText.includes('This request has already been rejected.'), alertText);
  t.check('conflict: the list is reloaded, without that request', (await row(page, P.decidedElsewhere).count()) === 0);
  t.check('conflict: the other decision stands', (await stored(P.decidedElsewhere)).decision_note === 'Decided by another administrator.');
  await t.noHorizontalOverflow(page, 'admin requests with an alert @ 1280px');
  await t.axe(page, 'admin requests with an alert @ 1280px');

  // Empty and error states. The real queue still holds sample requests, so the API answer is replaced.
  await page.route('**/api/bookings/requests', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { requests: [] } }),
  }));
  await page.reload();
  await waitForList(page);
  t.check('empty: says nothing is waiting',
    (await page.textContent('#requests')).includes('No requests waiting') && (await page.textContent('#requests-count')) === 'Nothing is waiting for a decision.');
  await t.axe(page, 'admin requests, empty @ 1280px');
  await page.unroute('**/api/bookings/requests');

  await page.route('**/api/bookings/requests', (route) => route.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again later.' } }),
  }));
  t.expectConsoleError(/status of 500/);
  await page.reload();
  await page.waitForSelector('#requests .state--error');
  t.check('error: a failed load says so and offers to try again',
    (await page.textContent('#requests')).includes('Could not load the requests') && (await page.locator('#requests button', { hasText: 'Try again' }).count()) === 1);
  await page.unroute('**/api/bookings/requests');
  await page.click('#requests button');
  await waitForList(page);
  t.check('error: "Try again" loads the list', (await row(page, P.taken).count()) === 1);
  const adminCookies = await context.cookies();
  await context.close();

  // ---- Phone ----------------------------------------------------------------------------
  const { page: phone } = await t.newPage({ width: 320, height: 800, cookies: adminCookies });
  await phone.goto(`${t.baseUrl}${PAGE}`);
  await waitForList(phone);
  t.check('320px: each request is a card, and nothing scrolls sideways inside the list', await phone.evaluate(() => {
    const wrap = document.querySelector('#requests .table-wrap');
    return getComputedStyle(document.querySelector('#requests tbody tr')).display === 'block' && wrap.scrollWidth <= wrap.clientWidth;
  }));
  await t.noHorizontalOverflow(phone, 'admin requests @ 320px');
  await t.axe(phone, 'admin requests @ 320px');
  await t.screenshot(phone, 'admin-requests-320');
  await row(phone, P.taken).getByRole('button', { name: /^Reject/ }).click();
  const phoneDialog = phone.locator('dialog[open]');
  await phoneDialog.waitFor();
  t.check('320px: the dialog is centred and fits', await phoneDialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.left > 0 && box.right < window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight;
  }));
  await t.noHorizontalOverflow(phone, 'reject dialog @ 320px');
  await t.axe(phone, 'reject dialog @ 320px');
  await phoneDialog.getByRole('button', { name: 'Go back' }).click();

  // ---- What the students see ------------------------------------------------------------
  const { page: alphaPage } = await t.newPage({ width: 1280 });
  await t.signIn(alphaPage, alpha, '/pages/my-bookings.html');
  await alphaPage.waitForSelector('.tabs__panel:not([aria-busy]) > *');
  t.check('student: the approved booking is under Upcoming, with the administrator\'s note',
    (await row(alphaPage, P.chosen, '.tabs__panel').textContent()).includes(`Note: ${NOTE}`));
  await alphaPage.getByRole('tab', { name: /^Cancelled/ }).click();
  t.check('student: the rejected request shows the reason',
    (await row(alphaPage, P.rejectMe, '.tabs__panel').textContent()).includes(`Reason: ${REASON}`));

  const { page: betaPage } = await t.newPage({ width: 1280 });
  await t.signIn(betaPage, beta, '/pages/my-bookings.html?tab=closed');
  await betaPage.waitForSelector('.tabs__panel:not([aria-busy]) > *');
  t.check('student: a request rejected automatically says why',
    (await row(betaPage, P.overlapping, '.tabs__panel').textContent()).includes(`Reason: ${AUTO_REJECT_NOTE}`));

  // ---- Who may open it --------------------------------------------------------------------
  await betaPage.goto(`${t.baseUrl}${PAGE}`);
  await betaPage.waitForSelector('main .state');
  t.check('access: a student is told the page is for administrators',
    (await betaPage.textContent('main')).includes('This page is not available to your account'));
  t.check('access: students have no Requests menu link', (await betaPage.locator(`.nav a[href="${PAGE}"]`).count()) === 0);
}

/** Waits until the list has finished loading and shows something. */
function waitForList(page) {
  return page.waitForSelector('#requests:not([aria-busy]) > *');
}

/** The purposes of the rows, top to bottom. The purpose is the fourth column. */
function purposes(page) {
  return page.$$eval('#requests tbody tr', (rows) => rows.map((row) => row.cells[3].childNodes[1].textContent));
}

function row(page, purpose, scope = '#requests') {
  return page.locator(`${scope} tbody tr`, { hasText: purpose });
}
