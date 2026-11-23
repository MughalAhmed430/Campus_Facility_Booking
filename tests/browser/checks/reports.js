// The Reports page for administrators: the default range, the four key figures, the two
// tables, the note on how utilization is simplified, choosing a range (kept in the
// address), an empty range, dates the page or the server refuses, and access.
//
// The figures are checked in a week of March 2035, where the sample data has nothing:
// the check makes a room of its own there with three requests.
import { ACCOUNTS } from '../harness.js';

const REPORTS = '/pages/admin/reports.html';
const ROOM = 'Report Check Room';
const WEEK = { from: '2035-03-05', to: '2035-03-11' }; // Monday to Sunday
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const NUMBER = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

/** A date `daysAhead` from today in Korea, YYYY-MM-DD. */
function campusDate(daysAhead) {
  return new Date(Date.now() + KST_MS + daysAhead * DAY_MS).toISOString().slice(0, 10);
}

/** @param {import('../harness.js').Harness} t */
export default async function reports(t) {
  const db = t.db;
  const adminId = (await db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;
  const studentId = (await db.query("SELECT id FROM users WHERE email = 'fatima.siddiqui@kdu.example'")).rows[0].id;

  // 09:00-19:00 on weekdays: 50 open hours in the week.
  const roomId = (await db.query(
    `INSERT INTO facilities (building_id, room_number, name, facility_type, capacity, floor, opens_at, closes_at, is_open_weekends)
     SELECT id, '990', $1, 'meeting_room', 8, 9, '09:00', '19:00', false FROM buildings WHERE code = 'ENG'
     RETURNING id`, [ROOM],
  )).rows[0].id;
  for (const [date, start, end, status] of [
    ['2035-03-05', '10:00', '13:00', 'approved'],
    ['2035-03-06', '10:00', '11:00', 'rejected'],
    ['2035-03-07', '10:00', '11:00', 'pending'],
  ]) {
    const decided = status !== 'pending';
    await db.query(
      `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status, decided_by, decided_at)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 4, 'Report check', $5, $6, $7)`,
      [studentId, roomId, `${date}T${start}:00+09:00`, `${date}T${end}:00+09:00`, status, decided ? adminId : null, decided ? new Date() : null],
    );
  }

  // ---- The default range ------------------------------------------------------------------
  const { context, page } = await t.newPage({ width: 1280 });
  await t.signIn(page, ACCOUNTS.admin, REPORTS);
  await waitForReport(page);
  t.check('reports: the menu has a Reports link, marked as the current page',
    (await page.getAttribute(`.nav a[href="${REPORTS}"]`, 'aria-current')) === 'page');
  t.check('reports: without dates the range is the last 30 days, shown in the date fields',
    (await page.inputValue('#range-from')) === campusDate(-29) && (await page.inputValue('#range-to')) === campusDate(0),
    `${await page.inputValue('#range-from')} to ${await page.inputValue('#range-to')}`);
  t.check('reports: the range is written out, with its length', (await page.textContent('#report-range')).endsWith('(30 days)'), await page.textContent('#report-range'));
  t.check('reports: the address stays clean until a range is chosen', new URL(page.url()).search === '');

  const counted = (await db.query(
    `SELECT count(*)::int AS requests,
            count(*) FILTER (WHERE status = 'completed')::int AS completed
     FROM bookings WHERE start_time >= $1::timestamptz AND start_time < $2::timestamptz`,
    [`${campusDate(-29)}T00:00:00+09:00`, `${campusDate(1)}T00:00:00+09:00`],
  )).rows[0];
  const labels = await page.locator('#report-figures .stat__label').allTextContents();
  t.check('reports: four key figures', labels.join(', ') === 'Booking requests, Approval rate, Hours booked, Utilization', labels.join(', '));
  t.check('reports: the request count is the number of bookings dated in the range',
    counted.requests > 0 && (await figure(page, 'Booking requests')).value === String(counted.requests),
    `${(await figure(page, 'Booking requests')).value} shown, ${counted.requests} stored`);
  t.check('reports: bookings by status lists the five statuses and their total',
    (await page.locator('#report-status tbody tr').count()) === 5
    && (await page.textContent('#report-status tr[data-status="completed"] td')) === String(counted.completed)
    && (await page.textContent('#report-status tfoot td')) === String(counted.requests),
    await page.textContent('#report-status'));

  const facilityCount = (await db.query('SELECT count(*)::int AS n FROM facilities')).rows[0].n;
  t.check('reports: every facility is listed', (await page.locator('#report-facilities tbody tr').count()) === facilityCount);
  const hours = (await page.locator('#report-facilities tbody tr td:nth-child(3)').allTextContents()).map((text) => Number(text.replace('Hours booked', '')));
  t.check('reports: the busiest facility comes first', hours[0] > 0 && hours.every((value, index) => index === 0 || value <= hours[index - 1]), hours.join(', '));
  const inactive = (await db.query("SELECT name FROM facilities WHERE status = 'inactive' ORDER BY id LIMIT 1")).rows[0].name;
  t.check('reports: an inactive facility is listed, marked and not counted',
    (await row(page, inactive).textContent()).includes('Inactive') && (await row(page, inactive).textContent()).includes('Not counted (inactive)'),
    await row(page, inactive).textContent());

  const method = await page.textContent('[aria-labelledby="method-title"]');
  t.check('reports: the page says how each figure is calculated',
    ['Booking requests', 'Approval rate', 'Hours booked', 'Utilization'].every((term) => method.includes(term)));
  t.check('reports: the page states the utilization simplification',
    method.includes('as they are today') && method.includes('no history') && method.includes('Inactive facilities are left out')
    && method.includes('under maintenance is counted') && method.includes('estimate'), method);
  await t.axe(page, 'admin reports @ 1280px');
  await t.screenshot(page, 'admin-reports-default-1280');

  // ---- A chosen range ----------------------------------------------------------------------
  await page.fill('#range-from', WEEK.from);
  await page.fill('#range-to', WEEK.to);
  await page.waitForFunction(() => document.getElementById('report-range').textContent.includes('2035'));
  await waitForReport(page);
  t.check('range: the heading names the chosen dates', /^5\s*–\s*11 March 2035 \(7 days\)$/.test(await page.textContent('#report-range')), await page.textContent('#report-range'));
  t.check('range: the address keeps it', new URL(page.url()).search === `?from=${WEEK.from}&to=${WEEK.to}`, page.url());

  const requests = await figure(page, 'Booking requests');
  const approval = await figure(page, 'Approval rate');
  const booked = await figure(page, 'Hours booked');
  const utilization = await figure(page, 'Utilization');
  t.check('range: 3 requests', requests.value === '3', requests.value);
  t.check('range: approval rate is approved out of decided, the pending request left out',
    approval.value === '50%' && approval.note === '1 of 2 decided requests approved', `${approval.value} / ${approval.note}`);
  t.check('range: hours booked counts the approved booking only', booked.value === '3', booked.value);

  // Open hours of every facility that is not inactive, as the page documents it.
  const { open } = (await db.query(
    `SELECT sum(extract(epoch FROM closes_at - opens_at) / 3600 * CASE WHEN is_open_weekends THEN 7 ELSE 5 END)::float8 AS open
     FROM facilities WHERE status <> 'inactive'`,
  )).rows[0];
  const expected = `${NUMBER.format(Math.round((3 / open) * 1000) / 10)}%`;
  t.check('range: utilization is hours booked out of the open hours of the facilities counted',
    utilization.value === expected && utilization.note === `Of ${NUMBER.format(open)} open hours (estimate, see below)`,
    `${utilization.value} / ${utilization.note}, expected ${expected} of ${open}`);

  const first = page.locator('#report-facilities tbody tr').first();
  const cells = await first.locator('td').allTextContents();
  t.check('range: the room with the booking is first, with its count, hours, open hours and utilization',
    cells[0].startsWith(ROOM) && cells[0].includes('ENG 990 · Meeting room') && cells[1].endsWith('1') && cells[2].endsWith('3')
    && cells[3].endsWith('50') && cells[4].endsWith('6%'), cells.join(' | '));
  const bar = await first.locator('.meter').evaluate((meter) => ({
    fill: meter.querySelector('.meter__fill').getBoundingClientRect().width,
    track: meter.querySelector('.meter__track').clientWidth,
    hidden: meter.querySelector('.meter__track').getAttribute('aria-hidden'),
  }));
  t.check('range: the bar is 6% of its track, and hidden from screen readers (the number is beside it)',
    bar.hidden === 'true' && Math.abs(bar.fill / bar.track - 0.06) < 0.02, JSON.stringify(bar));
  await t.screenshot(page, 'admin-reports-range-1280');

  await page.reload();
  await waitForReport(page);
  t.check('range: a reload keeps the range and its figures',
    (await page.inputValue('#range-from')) === WEEK.from && (await page.inputValue('#range-to')) === WEEK.to
    && (await figure(page, 'Booking requests')).value === '3');

  // ---- Dates that are refused ---------------------------------------------------------------
  await page.fill('#range-to', '2035-03-01');
  await page.waitForSelector('#range-to[aria-invalid="true"]');
  t.check('dates: a "To" before "From" is refused next to the field, and the figures stay',
    (await page.textContent('#range-form .field-error:not(:empty)')) === 'Must be on or after the "From" date.'
    && (await figure(page, 'Booking requests')).value === '3');
  await t.axe(page, 'admin reports with a date error @ 1280px');

  await page.fill('#range-to', '2036-03-06');
  await page.waitForFunction(() => document.querySelector('#range-form .field-error:not(:empty)')?.textContent.includes('one year'));
  t.check('dates: the server refuses a range over a year, said next to the field',
    (await page.textContent('#range-form .field-error:not(:empty)')) === 'The range can be at most one year.'
    && (await page.getAttribute('#range-to', 'aria-invalid')) === 'true' && (await page.locator('#report table').count()) === 0);

  // ---- An empty range ------------------------------------------------------------------------
  await page.fill('#range-from', '2036-06-02');
  await page.fill('#range-to', '2036-06-08');
  await page.waitForSelector('#report .alert');
  await waitForReport(page);
  t.check('empty: the error is gone once the dates are fine', (await page.locator('#range-form [aria-invalid="true"]').count()) === 0);
  t.check('empty: says no requests are dated in the range', (await page.textContent('#report .alert')).includes('No booking requests are dated in this range'));
  const none = await figure(page, 'Approval rate');
  t.check('empty: no approval rate rather than 0%', none.value === '–' && none.note === 'No request was decided', `${none.value} / ${none.note}`);
  t.check('empty: zero requests and hours', (await figure(page, 'Booking requests')).value === '0' && (await figure(page, 'Hours booked')).value === '0');
  await t.axe(page, 'admin reports for an empty range @ 1280px');

  // ---- Back to the last 30 days ---------------------------------------------------------------
  await page.click('#range-reset');
  await page.waitForFunction(() => document.getElementById('report-range').textContent.endsWith('(30 days)'));
  await waitForReport(page);
  t.check('reset: "Last 30 days" brings the default range back and clears the address',
    (await page.inputValue('#range-to')) === campusDate(0) && new URL(page.url()).search === ''
    && (await figure(page, 'Booking requests')).value === String(counted.requests));

  // An address with something that is not a date is ignored.
  await page.goto(`${t.baseUrl}${REPORTS}?from=yesterday&to=2035-02-30`);
  await waitForReport(page);
  t.check('address: values that are not dates are ignored', (await page.inputValue('#range-from')) === campusDate(-29));
  await context.close();

  // ---- On a phone -------------------------------------------------------------------------------
  const { context: phoneContext, page: phone } = await t.newPage({ width: 320, cookies: await signedInCookies(t) });
  await phone.goto(`${t.baseUrl}${REPORTS}?from=${WEEK.from}&to=${WEEK.to}`);
  await waitForReport(phone);
  t.check('phone: each facility is a card that names its values',
    await phone.locator('#report-facilities tbody tr').first().locator('.table__label').first().isVisible());
  await t.noHorizontalOverflow(phone, 'admin reports with a range @ 320px');
  await t.axe(phone, 'admin reports with a range @ 320px');
  await t.screenshot(phone, 'admin-reports-range-320');
  await phoneContext.close();

  // ---- Access ------------------------------------------------------------------------------------
  const { context: studentContext, page: studentPage } = await t.newPage({ width: 1280 });
  await t.signIn(studentPage, ACCOUNTS.student);
  await studentPage.goto(`${t.baseUrl}${REPORTS}`);
  await studentPage.waitForSelector('main .state');
  t.check('access: a student cannot open the Reports page', (await studentPage.textContent('main')).includes('This page is not available to your account'));
  t.check('access: students have no Reports menu link', (await studentPage.locator(`.nav a[href="${REPORTS}"]`).count()) === 0);
  t.expectConsoleError(/403 \(Forbidden\)/); // asked for on purpose
  const refused = await studentPage.evaluate(async () => (await fetch('/api/reports/summary')).status);
  t.check('access: the API refuses a student as well', refused === 403, String(refused));
  await studentContext.close();
}

function waitForReport(page) {
  return page.waitForSelector('#report:not([aria-busy]) > *');
}

function row(page, text) {
  return page.locator('#report-facilities tbody tr', { hasText: text });
}

/** { value, note } of the key figure with that label. */
async function figure(page, label) {
  const card = page.locator('#report-figures .stat', { has: page.locator('.stat__label', { hasText: new RegExp(`^${label}$`) }) });
  return { value: await card.locator('.stat__value').textContent(), note: await card.locator('.stat__note').textContent() };
}

async function signedInCookies(t) {
  const { context, page } = await t.newPage();
  await t.signIn(page, ACCOUNTS.admin);
  const cookies = await context.cookies();
  await context.close();
  return cookies;
}
