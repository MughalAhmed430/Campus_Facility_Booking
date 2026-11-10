// The booking form on the facility details page at the narrowest phone width: field
// errors, a successful request, and a time already taken by an approved booking.
import { ACCOUNTS } from '../harness.js';

const ROOM = 'Group Study Room A'; // every day 09:00-22:00, 6 seats, no upcoming sample bookings
const CONFLICT = 'This time is already booked. Choose a different time.';
const PURPOSE = 'Browser check study session';
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;

/** A date `daysAhead` from today in Korea, YYYY-MM-DD. */
function campusDate(daysAhead) {
  return new Date(Date.now() + KST_MS + daysAhead * DAY_MS).toISOString().slice(0, 10);
}

/** @param {import('../harness.js').Harness} t */
export default async function booking(t) {
  const facilityId = (await t.db.query('SELECT id FROM facilities WHERE name = $1', [ROOM])).rows[0].id;
  const facilityPath = `/pages/facility.html?id=${facilityId}`;
  const { page } = await t.newPage({ width: 320, height: 800 });
  await t.signIn(page, ACCOUNTS.student, facilityPath);
  await page.waitForSelector('#booking-form');

  const submit = () => page.click('#booking-form button[type=submit]');
  const invalidFields = () => page.$$eval('#booking-form [aria-invalid="true"]', (fields) => fields.map((field) => field.name));
  const errorText = (name) => page.textContent(`#booking-form-${name}-error`);
  // axe counts a control as too small while the sticky header happens to overlap it, so
  // scans of a state reached by scrolling start from the top of the page.
  async function axeFromTop(label) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await t.axe(page, label);
  }
  async function fillForm({ date, startTime, endTime, participants, purpose = PURPOSE }) {
    await page.fill('#booking-date', date);
    await page.fill('#booking-start', startTime);
    await page.fill('#booking-end', endTime);
    await page.fill('#booking-participants', participants);
    await page.fill('#booking-purpose', purpose);
  }

  await t.noHorizontalOverflow(page, 'booking form @ 320px');
  await t.axe(page, 'booking form @ 320px');

  // Missing fields
  await submit();
  const missing = await invalidFields();
  t.check('booking: empty submit flags date, times, participants and purpose',
    JSON.stringify(missing) === '["date","startTime","endTime","participantCount","purpose"]', JSON.stringify(missing));
  t.check('booking: each missing field says so', (await errorText('date')) === 'Date is required.' && (await errorText('purpose')) === 'Purpose is required.');
  t.check('booking: focus moves to the first invalid field', await page.evaluate(() => document.activeElement.id === 'booking-date'));
  await t.noHorizontalOverflow(page, 'booking form with field errors @ 320px');
  await axeFromTop('booking form with field errors @ 320px');
  await t.screenshot(page, 'booking-320-field-errors');

  // Rules checked in the browser, mirroring the server
  await fillForm({ date: campusDate(1), startTime: '08:00', endTime: '07:30', participants: '7' });
  await submit();
  t.check('booking: a start before opening time is caught', (await errorText('startTime')) === 'Must be inside the opening hours, 09:00–22:00.');
  t.check('booking: an end before the start is caught', (await errorText('endTime')) === 'End time must be after the start time.');
  t.check('booking: more people than the room holds is caught', (await errorText('participantCount')) === 'This facility holds at most 6 people.');

  // A 400 from the server: the room shrank after the page loaded, so only the server can tell
  await t.db.query('UPDATE facilities SET capacity = 1 WHERE id = $1', [facilityId]);
  await fillForm({ date: campusDate(1), startTime: '10:00', endTime: '11:00', participants: '2' });
  await submit();
  await page.waitForSelector('#booking-participants[aria-invalid="true"]');
  t.check('booking: a server 400 shows under its field', (await errorText('participantCount')) === 'This facility holds at most 1 person.');
  t.check('booking: a field error is not shown as an alert', (await page.locator('#booking-form .alert').count()) === 0);
  await t.db.query('UPDATE facilities SET capacity = 6 WHERE id = $1', [facilityId]);

  // Success. The lookup of booked times is held open until after the form has been
  // cleared, so its late answer has every chance to write into the empty form.
  const dayLookup = /\/facilities\/\d+\/schedule\?from=[\d-]+&days=1$/; // the form's one-day lookup, not the week
  let releaseLookup;
  const lookupHeld = new Promise((resolve) => { releaseLookup = resolve; });
  await page.route(dayLookup, async (route) => {
    await lookupHeld;
    await route.continue().catch(() => {}); // the page has already cancelled this request
  });

  await fillForm({ date: campusDate(1), startTime: '10:00', endTime: '11:00', participants: '4' });
  await submit();
  await page.waitForSelector('#booking-form .alert--success');
  const confirmation = await page.textContent('#booking-form .alert--success');
  t.check('booking: success says the request was submitted and is pending',
    confirmation.includes('Request submitted') && confirmation.includes('is pending') && confirmation.includes('10:00–11:00'), confirmation);
  const onScreen = await page.locator('#booking-form .alert--success').evaluate((alert) => {
    const box = alert.getBoundingClientRect();
    return {
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      headerBottom: Math.round(document.querySelector('.app-header').getBoundingClientRect().bottom),
      viewport: window.innerHeight,
      scrollY: Math.round(window.scrollY),
    };
  });
  t.check('booking: the confirmation is on screen at 320px, without scrolling',
    onScreen.top >= onScreen.headerBottom && onScreen.bottom <= onScreen.viewport, JSON.stringify(onScreen));
  const myBookingsLink = await page.getAttribute('#booking-form .alert--success a', 'href');
  t.check('booking: the confirmation links to the Pending tab of My bookings', myBookingsLink === '/pages/my-bookings.html?tab=pending', myBookingsLink);
  t.check('booking: the form is cleared for another request', (await page.inputValue('#booking-purpose')) === '' && (await invalidFields()).length === 0);
  releaseLookup();
  await page.waitForTimeout(200);
  t.check('booking: a slow lookup cannot write into the cleared form', (await page.textContent('#booking-taken')) === '', await page.textContent('#booking-taken'));
  await page.unroute(dayLookup);
  const { rows: created } = await t.db.query(
    'SELECT bk.status, u.email FROM bookings bk JOIN users u ON u.id = bk.user_id WHERE bk.facility_id = $1 AND bk.purpose = $2',
    [facilityId, PURPOSE],
  );
  t.check('booking: one pending row, owned by the signed-in student',
    created.length === 1 && created[0].status === 'pending' && created[0].email === ACCOUNTS.student.email, JSON.stringify(created));
  await t.noHorizontalOverflow(page, 'booking form with confirmation @ 320px');
  await axeFromTop('booking form with confirmation @ 320px');
  await t.screenshot(page, 'booking-320-submitted');

  // A slot already covered by an approved booking
  const conflictDate = campusDate(2);
  const { rows: people } = await t.db.query("SELECT id, role FROM users WHERE email IN ('admin@kdu.example', 'jiho.park@kdu.example')");
  const adminId = people.find((person) => person.role === 'admin').id;
  const studentId = people.find((person) => person.role === 'student').id;
  await t.db.query(
    `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status, decided_by, decided_at)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 2, 'Approved earlier', 'approved', $5, now())`,
    [studentId, facilityId, `${conflictDate}T14:00:00+09:00`, `${conflictDate}T15:00:00+09:00`, adminId],
  );

  await page.fill('#booking-date', conflictDate);
  await page.waitForFunction(() => document.getElementById('booking-taken').textContent.includes('14:00–15:00'));
  t.check('booking: choosing a date shows the times already booked', (await page.textContent('#booking-taken')) === 'Already booked: 14:00–15:00.');

  await fillForm({ date: conflictDate, startTime: '14:30', endTime: '15:30', participants: '3', purpose: 'Should not be accepted' });
  await submit();
  await page.waitForSelector('#booking-form .alert--danger');
  const conflict = await page.textContent('#booking-form .alert--danger');
  t.check('booking: an approved booking gives the "already booked" message', conflict.includes(CONFLICT), conflict);
  t.check('booking: the conflict is not the generic failure', !conflict.includes('Could not submit'), conflict);
  t.check('booking: the conflict marks no field invalid', (await invalidFields()).length === 0);
  const { rows: refused } = await t.db.query('SELECT 1 FROM bookings WHERE purpose = $1', ['Should not be accepted']);
  t.check('booking: nothing was stored for the refused request', refused.length === 0);
  await t.noHorizontalOverflow(page, 'booking form with conflict @ 320px');
  await axeFromTop('booking form with conflict @ 320px');
  await t.screenshot(page, 'booking-320-conflict');

  // The confirmation's link: the new request is waiting on the Pending tab
  await page.goto(`${t.baseUrl}${myBookingsLink}`);
  await page.waitForSelector('.tabs__panel:not([aria-busy]) > *');
  const pendingTab = await page.textContent('.tabs__panel');
  t.check('booking: the request appears on the Pending tab of My bookings',
    (await page.$eval('[role=tab][aria-selected=true]', (tab) => tab.firstChild.textContent.trim())) === 'Pending'
    && pendingTab.includes(PURPOSE) && pendingTab.includes(ROOM), pendingTab.slice(0, 200));

  // Who sees the form
  const retiredId = (await t.db.query("SELECT id FROM facilities WHERE name = 'Conference Room 401'")).rows[0].id;
  await page.goto(`${t.baseUrl}/pages/facility.html?id=${retiredId}`);
  await page.waitForSelector('h1.page-header__title');
  t.check('booking: a facility that cannot be booked has no form', (await page.locator('#booking-form').count()) === 0);

  const { page: adminPage } = await t.newPage({ width: 320, height: 800 });
  await t.signIn(adminPage, ACCOUNTS.admin, facilityPath);
  await adminPage.waitForSelector('#booking-title');
  t.check('booking: an administrator has no form and is told why',
    (await adminPage.locator('#booking-form').count()) === 0 && (await adminPage.textContent('main')).includes('Booking requests are made from student accounts.'));
}
