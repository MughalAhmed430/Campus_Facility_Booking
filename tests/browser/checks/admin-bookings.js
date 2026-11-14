// Managing bookings as an administrator: the list of every booking, its filters and
// pages (kept in the address bar), the details dialog, cancelling an approved booking
// with a required reason, a booking cancelled by someone else while the dialog was open,
// the empty and error states, what the student then sees, and who may open the page.
//
// It uses students of its own, with bookings 40+ days ahead in a room no other group
// books then, and finds them by student name, so the other groups' data does not matter.
import { ACCOUNTS } from '../harness.js';

const PASSWORD = 'Student@2026';
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const PAGE = '/pages/admin/bookings.html';
const ROOM = 'Networking Lab';

const P = {
  cancelMe: 'Manage check: routing practice', // approved, cancelled by the administrator
  cancelledElsewhere: 'Manage check: cancelled elsewhere', // cancelled by the student while the dialog is open
  pending: 'Manage check: waiting for review',
  rejected: 'Manage check: rejected earlier',
  byStudent: 'Manage check: cancelled by the student',
};
const REASON = 'The lab is closed for rewiring that day.';

/** A date `daysAhead` from today in Korea, YYYY-MM-DD. */
function campusDate(daysAhead) {
  return new Date(Date.now() + KST_MS + daysAhead * DAY_MS).toISOString().slice(0, 10);
}

/** @param {import('../harness.js').Harness} t */
export default async function adminBookings(t) {
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
  const gamma = await newStudent('Manage Gamma', 'manage.gamma@kdu.example');
  const many = await newStudent('Manage Paging', 'manage.paging@kdu.example');

  async function seed(owner, purpose, daysAhead, startTime, endTime, status = 'pending') {
    const date = campusDate(daysAhead);
    const decided = ['approved', 'rejected'].includes(status);
    const cancelled = status === 'cancelled';
    await db.query(
      `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status,
                             decided_by, decided_at, decision_note, cancelled_by, cancelled_at, cancellation_reason)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 6, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [owner.id, roomId, `${date}T${startTime}:00+09:00`, `${date}T${endTime}:00+09:00`, purpose, status,
        decided ? adminId : null, decided ? new Date() : null, status === 'rejected' ? 'Please choose a smaller room.' : null,
        cancelled ? owner.id : null, cancelled ? new Date() : null, cancelled ? 'Plans changed.' : null],
    );
  }
  await seed(gamma, P.cancelMe, 40, '10:00', '12:00', 'approved');
  await seed(gamma, P.cancelledElsewhere, 41, '10:00', '12:00', 'approved');
  await seed(gamma, P.pending, 42, '10:00', '12:00');
  await seed(gamma, P.rejected, 43, '10:00', '12:00', 'rejected');
  await seed(gamma, P.byStudent, 44, '10:00', '12:00', 'cancelled');
  for (let i = 1; i <= 45; i += 1) await seed(many, `Manage paging ${String(i).padStart(2, '0')}`, 50 + i, '09:00', '10:00');

  const stored = async (purpose) => (await db.query(
    'SELECT status, cancelled_by, cancellation_reason FROM bookings WHERE purpose = $1 AND user_id = $2', [purpose, gamma.id],
  )).rows[0];
  const total = async () => (await db.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n;

  // ---- Desktop: the list ----------------------------------------------------------------
  const { context, page } = await t.newPage({ width: 1280 });
  await t.signIn(page, ACCOUNTS.admin, PAGE);
  await waitForList(page);
  t.check('bookings: the menu has a Bookings link, marked as the current page',
    (await page.getAttribute(`.nav a[href="${PAGE}"]`, 'aria-current')) === 'page');
  const everything = await total();
  const countText = await page.textContent('#result-count');
  t.check('bookings: without filters the count is every booking, 20 to a page',
    countText === `${everything} bookings, showing 1–20` && (await rows(page).count()) === 20, countText);
  const dates = await page.$$eval('#bookings tbody tr', (trs) => trs.map((tr) => tr.cells[2].textContent));
  t.check('bookings: latest start first', dates[0].includes(dateText(campusDate(95))), dates[0]);
  await t.noHorizontalOverflow(page, 'admin bookings @ 1280px');
  await t.axe(page, 'admin bookings @ 1280px');
  await t.screenshot(page, 'admin-bookings-1280');

  // ---- Filters ---------------------------------------------------------------------------
  await page.fill('#filter-q', 'manage gamma');
  await waitForCount(page, '5 bookings match your filters');
  t.check('filter: the student search finds their bookings, any capitals', (await rows(page).count()) === 5);
  t.check('filter: the address bar keeps the search', new URL(page.url()).searchParams.get('q') === 'manage gamma', page.url());
  t.check('filter: one page of results has no page links', (await page.locator('.pagination').count()) === 0);
  const approvedRow = await row(page, P.cancelMe).textContent();
  t.check('row: student, facility, time and status are shown',
    approvedRow.includes('Manage Gamma') && approvedRow.includes('manage.gamma@kdu.example') && approvedRow.includes(ROOM)
    && approvedRow.includes('10:00–12:00') && approvedRow.includes('Approved'), approvedRow);
  t.check('row: only an approved booking can be cancelled',
    (await row(page, P.cancelMe).getByRole('button', { name: /^Cancel/ }).count()) === 1
    && (await page.locator('#bookings tbody').getByRole('button', { name: /^Cancel/ }).count()) === 2);
  t.check('row: a cancelled booking says who cancelled it', (await row(page, P.byStudent).textContent()).includes('By the student'));
  const detailsName = await row(page, P.cancelMe).getByRole('button', { name: /^Details/ }).evaluate((button) => button.textContent.trim());
  t.check('row: each button names its booking for screen readers',
    detailsName.startsWith(`Details: Manage Gamma, ${ROOM}, `) && detailsName.endsWith(', 10:00'), detailsName);

  await page.getByLabel('Rejected', { exact: true }).check();
  await page.getByLabel('Cancelled', { exact: true }).check();
  await waitForCount(page, '2 bookings match your filters');
  t.check('filter: several statuses can be ticked together',
    (await row(page, P.rejected).count()) === 1 && (await row(page, P.byStudent).count()) === 1);
  t.check('filter: the address bar keeps the statuses', new URL(page.url()).searchParams.get('status') === 'rejected,cancelled', page.url());
  await page.fill('#filter-from', campusDate(44));
  await waitForCount(page, '1 booking matches your filters');
  t.check('filter: a "From" date leaves that day and later', (await row(page, P.byStudent).count()) === 1);
  await page.fill('#filter-to', campusDate(43));
  await page.waitForSelector('#filter-to[aria-invalid="true"]');
  t.check('filter: a "To" date before "From" is refused next to the field',
    (await page.textContent('#filter-form .field-error:not(:empty)')) === 'Must be on or after the "From" date.');
  await t.axe(page, 'admin bookings with a filter error @ 1280px');

  // Reload: the filters come back from the address bar
  await page.fill('#filter-to', campusDate(44));
  await waitForCount(page, '1 booking matches your filters');
  await page.reload();
  await waitForList(page);
  t.check('filter: a reload keeps the filters',
    (await page.inputValue('#filter-q')) === 'manage gamma' && (await page.getByLabel('Rejected', { exact: true }).isChecked())
    && (await page.inputValue('#filter-from')) === campusDate(44) && (await page.textContent('#result-count')) === '1 booking matches your filters');

  await page.fill('#filter-q', 'nobody by this name');
  await waitForCount(page, 'No bookings match your filters');
  t.check('empty: says nothing matches and offers to clear the filters',
    (await page.textContent('#bookings')).includes('No bookings match these filters') && (await page.locator('#bookings button', { hasText: 'Clear filters' }).count()) === 1);
  await t.axe(page, 'admin bookings, no matches @ 1280px');
  await page.click('#bookings button');
  await waitForCount(page, `${everything} bookings, showing 1–20`);
  t.check('empty: "Clear filters" shows every booking again and empties the address bar', new URL(page.url()).search === '', page.url());

  await page.selectOption('#filter-facility', { label: `${ROOM} (ENG 312)` });
  await page.waitForFunction(() => document.getElementById('result-count').textContent.includes('match your filters'));
  const inRoom = (await db.query('SELECT count(*)::int AS n FROM bookings WHERE facility_id = $1', [roomId])).rows[0].n;
  t.check('filter: by facility', (await page.textContent('#result-count')).startsWith(`${inRoom} bookings match your filters`), await page.textContent('#result-count'));
  await page.click('#filter-clear');
  await waitForCount(page, `${everything} bookings, showing 1–20`);

  // ---- Pages -------------------------------------------------------------------------------
  await page.fill('#filter-q', 'Manage Paging');
  await waitForCount(page, '45 bookings match your filters, showing 1–20');
  const nav = page.locator('.pagination');
  t.check('pages: "Page 1 of 3", with Previous disabled',
    (await nav.locator('.pagination__status').textContent()) === 'Page 1 of 3'
    && (await nav.getByRole('button', { name: 'Previous page' }).isDisabled()) && (await nav.getByRole('button', { name: 'Next page' }).isEnabled()));
  await t.axe(page, 'admin bookings with page links @ 1280px');
  await nav.getByRole('button', { name: 'Next page' }).click();
  await waitForCount(page, '45 bookings match your filters, showing 21–40');
  t.check('pages: Next shows the next 20 and keeps the page in the address bar',
    (await rows(page).count()) === 20 && new URL(page.url()).searchParams.get('page') === '2' && (await row(page, 'Manage paging 25').count()) === 1, page.url());
  t.check('pages: focus moves to the top of the results', await page.evaluate(() => document.activeElement.id === 'results-title'));
  await nav.getByRole('button', { name: 'Next page' }).click();
  await waitForCount(page, '45 bookings match your filters, showing 41–45');
  t.check('pages: the last page has the rest, with Next disabled',
    (await rows(page).count()) === 5 && (await nav.getByRole('button', { name: 'Next page' }).isDisabled()));
  await page.reload();
  await waitForList(page);
  t.check('pages: a reload stays on the same page', (await page.textContent('#result-count')).endsWith('showing 41–45'));
  await page.getByLabel('Pending', { exact: true }).check();
  await waitForCount(page, '45 bookings match your filters, showing 1–20');
  t.check('pages: changing a filter goes back to the first page', !new URL(page.url()).searchParams.has('page'), page.url());
  await page.goto(`${t.baseUrl}${PAGE}?q=Manage+Paging&page=9`);
  await waitForList(page);
  t.check('pages: a page past the end in the address shows the last page instead',
    (await page.textContent('#result-count')).endsWith('showing 41–45') && new URL(page.url()).searchParams.get('page') === '3', page.url());

  // ---- Details ---------------------------------------------------------------------------
  await page.goto(`${t.baseUrl}${PAGE}?q=manage+gamma`);
  await waitForList(page);
  const dialog = page.locator('dialog[open]');
  const rejectedDetails = row(page, P.rejected).getByRole('button', { name: /^Details/ });
  await rejectedDetails.click();
  await dialog.waitFor();
  const rejectedText = await dialog.textContent();
  t.check('details: the whole record, with who decided and the reason',
    rejectedText.includes(P.rejected) && rejectedText.includes('6 of 24 people') && rejectedText.includes('Requested')
    && rejectedText.includes('by Facilities Administrator') && rejectedText.includes('Reason: Please choose a smaller room.'), rejectedText);
  await t.axe(page, 'booking details dialog @ 1280px');
  await t.screenshot(page, 'admin-bookings-1280-details');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  t.check('details: Escape closes it, and focus returns to its button', await rejectedDetails.evaluate((button) => button === document.activeElement));

  await row(page, P.byStudent).getByRole('button', { name: /^Details/ }).click();
  await dialog.waitFor();
  t.check('details: a cancellation says who cancelled and why',
    (await dialog.textContent()).includes('by the student') && (await dialog.textContent()).includes('Reason: Plans changed.'));
  await dialog.getByRole('button', { name: 'Close' }).click();

  await row(page, P.pending).getByRole('button', { name: /^Details/ }).click();
  await dialog.waitFor();
  t.check('details: a pending request links to Requests',
    (await dialog.getByRole('link', { name: 'Review in Requests' }).getAttribute('href')) === '/pages/admin/requests.html');
  await dialog.getByRole('button', { name: 'Close' }).click();

  // ---- Cancelling --------------------------------------------------------------------------
  const cancelButton = row(page, P.cancelMe).getByRole('button', { name: /^Cancel/ });
  await cancelButton.click();
  await dialog.waitFor();
  t.check('cancel: the dialog names the booking', (await dialog.textContent()).includes(`Manage Gamma: ${ROOM} (ENG 312)`));
  t.check('cancel: focus starts in the reason box', await page.evaluate(() => document.activeElement.matches('dialog textarea')));
  const confirm = dialog.getByRole('button', { name: 'Cancel booking', exact: true });
  await confirm.click();
  t.check('cancel: confirming without a reason keeps the dialog open and says why',
    (await dialog.isVisible()) && (await dialog.locator('.field-error').textContent()) === 'Reason is required.');
  await dialog.locator('textarea').fill('No.');
  await confirm.click();
  t.check('cancel: a reason under 5 characters is refused too', (await dialog.locator('.field-error').textContent()) === 'Reason must be at least 5 characters.');
  await t.axe(page, 'cancel dialog with an error @ 1280px');
  await t.screenshot(page, 'admin-bookings-1280-cancel-error');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  t.check('cancel: Escape keeps the booking, and focus returns to its button',
    (await stored(P.cancelMe)).status === 'approved' && (await cancelButton.evaluate((button) => button === document.activeElement)));

  await cancelButton.click();
  await dialog.waitFor();
  await dialog.locator('textarea').fill(REASON);
  await confirm.click();
  await page.waitForFunction((purpose) => [...document.querySelectorAll('#bookings tbody tr')]
    .some((tr) => tr.textContent.includes(purpose) && tr.textContent.includes('Cancelled')), P.cancelMe);
  const cancelled = await stored(P.cancelMe);
  t.check('cancel: stored with the reason, by this administrator',
    cancelled.status === 'cancelled' && cancelled.cancelled_by === adminId && cancelled.cancellation_reason === REASON, JSON.stringify(cancelled));
  const cancelledRow = await row(page, P.cancelMe).textContent();
  t.check('cancel: the row now says cancelled by an administrator, and has no Cancel button',
    cancelledRow.includes('By an administrator') && (await row(page, P.cancelMe).getByRole('button', { name: /^Cancel/ }).count()) === 0, cancelledRow);
  t.check('cancel: a toast says what happened', (await page.textContent('.toast-region')).includes('Booking cancelled.'));
  t.check('cancel: focus stays on the booking\'s row', await page.evaluate((purpose) => document.activeElement.closest('tr')?.textContent.includes(purpose) ?? false, P.cancelMe));

  // Cancelled by the student while the dialog was open
  await row(page, P.cancelledElsewhere).getByRole('button', { name: /^Cancel/ }).click();
  await dialog.waitFor();
  await db.query(
    `UPDATE bookings SET status = 'cancelled', cancelled_by = user_id, cancelled_at = now(), cancellation_reason = 'Cancelled by the student first.'
     WHERE purpose = $1 AND user_id = $2`,
    [P.cancelledElsewhere, gamma.id],
  );
  await dialog.locator('textarea').fill(REASON);
  await confirm.click();
  await page.waitForSelector('#bookings-alert .alert--danger');
  await waitForList(page);
  const alertText = await page.textContent('#bookings-alert');
  t.check('conflict: says the booking could not be cancelled, and why',
    alertText.includes('Could not cancel the booking') && alertText.includes('This booking has already been cancelled.'), alertText);
  t.check('conflict: the list is reloaded and shows the student\'s cancellation, which stands',
    (await row(page, P.cancelledElsewhere).textContent()).includes('By the student')
    && (await stored(P.cancelledElsewhere)).cancellation_reason === 'Cancelled by the student first.');
  await t.noHorizontalOverflow(page, 'admin bookings with an alert @ 1280px');
  await t.axe(page, 'admin bookings with an alert @ 1280px');

  // ---- Error state ---------------------------------------------------------------------------
  await page.route('**/api/bookings?*', (route) => route.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again later.' } }),
  }));
  t.expectConsoleError(/status of 500/);
  await page.reload();
  await page.waitForSelector('#bookings .state--error');
  t.check('error: a failed load says so and offers to try again',
    (await page.textContent('#bookings')).includes('Could not load the bookings') && (await page.locator('#bookings button', { hasText: 'Try again' }).count()) === 1);
  t.check('error: no count is shown while the list is unknown', (await page.textContent('#result-count')) === '');
  await page.unroute('**/api/bookings?*');
  await page.click('#bookings button');
  await waitForList(page);
  t.check('error: "Try again" loads the list', (await row(page, P.pending).count()) === 1);
  const adminCookies = await context.cookies();
  await context.close();

  // ---- Phone ----------------------------------------------------------------------------------
  const { page: phone } = await t.newPage({ width: 320, height: 800, cookies: adminCookies });
  await phone.goto(`${t.baseUrl}${PAGE}?q=manage+gamma`);
  await waitForList(phone);
  t.check('320px: the filters start collapsed, and the button says one is active',
    !(await phone.isVisible('#filter-form')) && (await phone.textContent('#filter-toggle')).includes('(1 active)'));
  t.check('320px: each booking is a card, and nothing scrolls sideways inside the list', await phone.evaluate(() => {
    const wrap = document.querySelector('#bookings .table-wrap');
    return getComputedStyle(document.querySelector('#bookings tbody tr')).display === 'block' && wrap.scrollWidth <= wrap.clientWidth;
  }));
  await t.noHorizontalOverflow(phone, 'admin bookings @ 320px');
  await t.axe(phone, 'admin bookings @ 320px');
  await t.screenshot(phone, 'admin-bookings-320');
  await phone.click('#filter-toggle');
  t.check('320px: the button opens the filters', (await phone.isVisible('#filter-form')) && (await phone.getAttribute('#filter-toggle', 'aria-expanded')) === 'true');
  await t.noHorizontalOverflow(phone, 'admin bookings @ 320px with filters open');
  await t.axe(phone, 'admin bookings @ 320px with filters open');
  await t.screenshot(phone, 'admin-bookings-320-filters-open');
  await row(phone, P.pending).getByRole('button', { name: /^Details/ }).click();
  const phoneDialog = phone.locator('dialog[open]');
  await phoneDialog.waitFor();
  t.check('320px: the details dialog fits', await phoneDialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.left > 0 && box.right < window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight;
  }));
  await t.noHorizontalOverflow(phone, 'booking details dialog @ 320px');
  await t.axe(phone, 'booking details dialog @ 320px');
  await phoneDialog.getByRole('button', { name: 'Close' }).click();

  // ---- What the student sees -----------------------------------------------------------------
  const { page: studentPage } = await t.newPage({ width: 1280 });
  await t.signIn(studentPage, gamma, '/pages/my-bookings.html?tab=closed');
  await studentPage.waitForSelector('.tabs__panel:not([aria-busy]) > *');
  const studentRow = await row(studentPage, P.cancelMe, '.tabs__panel').textContent();
  t.check('student: the booking is under Cancelled, by an administrator, with the reason and no name',
    studentRow.includes('Cancelled by an administrator.') && studentRow.includes(REASON) && !studentRow.includes('Facilities Administrator'), studentRow);

  // ---- Who may open it -------------------------------------------------------------------------
  await studentPage.goto(`${t.baseUrl}${PAGE}`);
  await studentPage.waitForSelector('main .state');
  t.check('access: a student is told the page is for administrators',
    (await studentPage.textContent('main')).includes('This page is not available to your account'));
  t.check('access: students have no Bookings menu link', (await studentPage.locator(`.nav a[href="${PAGE}"]`).count()) === 0);
}

/** Waits until the list has finished loading and shows something. */
function waitForList(page) {
  return page.waitForSelector('#bookings:not([aria-busy]) > *');
}

/** Waits until the count line says exactly `text` and the list has settled. */
async function waitForCount(page, text) {
  await page.waitForFunction((expected) => document.getElementById('result-count').textContent === expected
    && !document.getElementById('bookings').hasAttribute('aria-busy'), text);
}

function rows(page) {
  return page.locator('#bookings tbody tr');
}

function row(page, purpose, scope = '#bookings') {
  return page.locator(`${scope} tbody tr`, { hasText: purpose });
}

/** '2026-11-10' -> "10 Nov 2026", as it appears inside the page's date labels. */
function dateText(date) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}
