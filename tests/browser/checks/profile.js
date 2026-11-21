// Phase 1 usability: the profile page (name, photo, password), reservation references,
// the printable confirmation, and approving or rejecting a request from the administrators'
// day schedule.
//
// It uses students of its own, with bookings 90+ days ahead in the Physics Lab, a room no
// other group books then.
import { ACCOUNTS } from '../harness.js';

const PASSWORD = 'Student@2026';
const NEW_PASSWORD = 'Brand new 2026 pass';
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const ROOM = 'Physics Lab';
// A real 1x1 PNG, so the browser can draw it.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** The first weekday at least `daysAhead` from today in Korea, YYYY-MM-DD. */
function campusWeekday(daysAhead) {
  let time = Date.now() + KST_MS + daysAhead * DAY_MS;
  while ([0, 6].includes(new Date(time).getUTCDay())) time += DAY_MS;
  return new Date(time).toISOString().slice(0, 10);
}

const reference = (id) => `FR-${String(id).padStart(6, '0')}`;

/** @param {import('../harness.js').Harness} t */
export default async function profile(t) {
  const db = t.db;
  const roomId = (await db.query('SELECT id FROM facilities WHERE name = $1', [ROOM])).rows[0].id;
  const adminId = (await db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;

  async function newStudent(name, email) {
    const { rows: [row] } = await db.query(
      `INSERT INTO users (full_name, email, password_hash, role, student_number)
       VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), 'student', $4) RETURNING id`,
      [name, email, PASSWORD, String(Math.floor(100000 + Math.random() * 800000))],
    );
    return { id: row.id, email, password: PASSWORD, fullName: name };
  }
  async function seed(userId, date, startTime, endTime, status = 'pending') {
    const decided = status === 'approved';
    const { rows } = await db.query(
      `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status, decided_by, decided_at)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 4, 'Profile check: pendulum experiment', $5, $6, $7) RETURNING id`,
      [userId, roomId, `${date}T${startTime}:00+09:00`, `${date}T${endTime}:00+09:00`, status, decided ? adminId : null, decided ? new Date() : null],
    );
    return rows[0].id;
  }

  const student = await newStudent('Profile Theta', 'profile.theta@kdu.example');
  const other = await newStudent('Profile Iota', 'profile.iota@kdu.example');
  const day = campusWeekday(90);
  const approvedId = await seed(student.id, day, '09:00', '10:00', 'approved');
  const pendingId = await seed(student.id, day, '11:00', '12:00');
  const othersId = await seed(other.id, day, '15:00', '16:00', 'approved');

  // ---- The profile page --------------------------------------------------------------------
  const { page } = await t.newPage({ width: 1280 });
  await t.signIn(page, student, '/pages/profile.html');
  await page.waitForSelector('#details-form');
  t.check('profile: the header links to it, with the initials as the picture',
    (await page.getAttribute('.user-menu__profile', 'aria-current')) === 'page'
      && (await page.textContent('.user-menu__profile .avatar')).trim() === 'PT');
  t.check('profile: email and student number are shown, not editable',
    (await page.textContent('#profile')).includes(student.email) && (await page.locator('#profile input[name=email]').count()) === 0);
  await t.axe(page, 'profile page');
  await t.noHorizontalOverflow(page, 'profile page @ 1280px');
  await t.screenshot(page, 'profile-1280');

  await page.fill('#profile-name', '  Profile   Theta-Kim ');
  await page.click('#details-form button[type=submit]');
  await page.waitForSelector('#details-form .alert--success');
  t.check('profile: a new name is saved and shown in the header at once',
    (await page.textContent('.user-menu__name')) === 'Profile Theta-Kim'
      && (await db.query('SELECT full_name FROM users WHERE id = $1', [student.id])).rows[0].full_name === 'Profile Theta-Kim');

  // Photo: a renamed program is refused by the server; a real image is shown.
  t.expectConsoleError(/status of 400/);
  await page.setInputFiles('#photo-file', { name: 'holiday.png', mimeType: 'image/png', buffer: Buffer.from('MZ not really an image') });
  await page.waitForSelector('#profile .alert--danger');
  t.check('photo: a file that is not really an image is refused, saying why',
    (await page.textContent('#profile .alert--danger')).includes('JPEG, PNG or WebP'));
  await page.setInputFiles('#photo-file', { name: 'me.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForFunction(() => document.querySelector('.profile-photo .avatar__img')?.naturalWidth > 0);
  await page.waitForFunction(() => document.querySelector('.user-menu__profile .avatar__img')?.naturalWidth > 0);
  t.check('photo: an image is uploaded and shown on the page and in the header', true);
  t.check('photo: "Remove photo" appears', await page.isVisible('text=Remove photo'));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.user-menu__profile .avatar__img')?.naturalWidth > 0);
  t.check('photo: it is still there after reloading', true);
  await page.click('text=Remove photo');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog[open] .btn--danger');
  await page.waitForFunction(() => !document.querySelector('.profile-photo .avatar__img'));
  t.check('photo: removing it (after confirming) brings the initials back',
    (await db.query('SELECT photo_file FROM users WHERE id = $1', [student.id])).rows[0].photo_file === null);

  // Password: the current one is checked; another signed-in browser is signed out.
  const { page: elsewhere } = await t.newPage({ width: 1280 });
  await t.signIn(elsewhere, student, '/pages/my-bookings.html');
  await page.fill('#password-current', 'not my password');
  await page.fill('#password-new', NEW_PASSWORD);
  await page.fill('#password-confirm', 'something else');
  await page.click('#password-form button[type=submit]');
  t.check('password: confirming with a different password is caught in the browser',
    (await page.textContent('#password-form')).includes('The two new passwords do not match.'));
  await page.fill('#password-confirm', NEW_PASSWORD);
  await page.click('#password-form button[type=submit]');
  await page.waitForSelector('#password-current[aria-invalid="true"]');
  t.check('password: a wrong current password is shown under that field',
    (await page.textContent('#password-form')).includes('Your current password is not correct.'));
  await page.fill('#password-current', PASSWORD);
  await page.fill('#password-new', NEW_PASSWORD);
  await page.fill('#password-confirm', NEW_PASSWORD);
  await page.click('#password-form button[type=submit]');
  await page.waitForSelector('#password-form .alert--success');
  t.check('password: changed, and it says other sign-ins were signed out',
    (await page.textContent('#password-form .alert--success')).includes('other sign-ins'));
  await elsewhere.reload();
  await elsewhere.waitForURL((url) => url.pathname.endsWith('/login.html'));
  t.check('password: the other browser has to sign in again', true);
  await t.signIn(elsewhere, { email: student.email, password: NEW_PASSWORD });
  t.check('password: the new password works', !elsewhere.url().endsWith('/login.html'));

  // ---- References and the printable record ---------------------------------------------------
  await page.goto(`${t.baseUrl}/pages/my-bookings.html?tab=upcoming`);
  await page.waitForSelector(`tr[data-booking-id="${approvedId}"]`);
  t.check('my bookings: each booking shows its reference',
    (await page.textContent(`tr[data-booking-id="${approvedId}"]`)).includes(reference(approvedId)));
  await page.click(`tr[data-booking-id="${approvedId}"] >> text=Print confirmation`);
  await page.waitForSelector('.print-record');
  t.check('print: an approved booking is a confirmation, with its reference',
    (await page.textContent('#print-title')) === 'Reservation confirmation'
      && (await page.textContent('.print-record__reference-value')) === reference(approvedId));
  await t.axe(page, 'printable confirmation');
  await page.emulateMedia({ media: 'print' });
  t.check('print: printing leaves out the menu and the buttons',
    !(await page.isVisible('.app-header')) && !(await page.isVisible('.print-actions')) && await page.isVisible('.print-record'));
  await t.screenshot(page, 'print-confirmation');
  await page.emulateMedia({ media: 'screen' });

  await page.goto(`${t.baseUrl}/pages/booking-print.html?id=${pendingId}`);
  await page.waitForSelector('.print-record');
  t.check('print: a pending request is a request record that says it is not confirmed',
    (await page.textContent('#print-title')) === 'Reservation request record'
      && (await page.textContent('.print-record__notice')).startsWith('NOT CONFIRMED'));

  await page.goto(`${t.baseUrl}/pages/booking-print.html?id=${othersId}`);
  await page.waitForSelector('.state--error');
  t.check('print: another student\'s booking is not shown', (await page.textContent('main h1')) === 'Booking not found');

  // ---- Deciding from the administrators' day schedule ------------------------------------------
  const first = await seed(student.id, day, '13:00', '14:00');
  const clashing = await seed(other.id, day, '13:30', '14:30');
  const later = await seed(other.id, day, '17:00', '18:00');
  const { page: admin } = await t.newPage({ width: 1280 });
  await t.signIn(admin, ACCOUNTS.admin, `/pages/admin/schedule.html?date=${day}&type=laboratory`);
  await admin.waitForSelector(`[data-booking-id="${first}"] button`);
  await admin.click(`[data-booking-id="${first}"] button`);
  await admin.waitForSelector('dialog[open]');
  const dialogText = await admin.textContent('dialog[open]');
  t.check('schedule: a request\'s details show its reference and the request it overlaps',
    dialogText.includes(reference(first)) && dialogText.includes('Profile Iota, 13:30–14:30'));
  await t.axe(admin, 'admin schedule, request with Approve and Reject');
  await admin.click('dialog[open] .dialog__actions >> text="Approve"');
  await admin.waitForSelector('dialog[open] >> text=Approve this request?');
  t.check('schedule: approving asks first, and says the overlapping request will be rejected',
    (await admin.textContent('dialog[open]')).includes('also rejects this overlapping request'));
  await admin.click('dialog[open] >> text=Approve request');
  await admin.waitForSelector('.toast >> text=Request approved. 1 overlapping request rejected.');
  const statuses = (await db.query('SELECT id, status FROM bookings WHERE id = ANY($1) ORDER BY id', [[first, clashing]])).rows;
  t.check('schedule: approved, and the overlapping request rejected',
    JSON.stringify(statuses.map((row) => row.status)) === '["approved","rejected"]', JSON.stringify(statuses));
  await admin.waitForSelector(`.slot--approved[data-booking-id="${first}"]`);
  t.check('schedule: the day reloads, showing the booking as approved, with focus on it',
    await admin.evaluate((id) => document.activeElement.closest(`[data-booking-id="${id}"]`) !== null, first));

  await admin.click(`[data-booking-id="${later}"] button`);
  await admin.click('dialog[open] .dialog__actions >> text="Reject"');
  await admin.click('dialog[open] >> text=Reject request');
  t.check('schedule: rejecting needs a reason', (await admin.textContent('dialog[open]')).includes('Reason is required.'));
  await admin.fill('dialog[open] textarea', 'The lab is reserved for an exam that afternoon.');
  await admin.click('dialog[open] >> text=Reject request');
  await admin.waitForSelector('.toast >> text=Request rejected.');
  t.check('schedule: rejected with the reason',
    (await db.query('SELECT status, decision_note FROM bookings WHERE id = $1', [later])).rows[0].decision_note
      === 'The lab is reserved for an exam that afternoon.');

  // An approved booking only has Close: nothing to decide.
  await admin.click(`[data-booking-id="${approvedId}"] button`);
  await admin.waitForSelector('dialog[open]');
  t.check('schedule: an approved booking offers no Approve or Reject',
    (await admin.locator('dialog[open] .dialog__actions button').allTextContents()).join() === 'Close');
  await admin.keyboard.press('Escape');

  // The administrators' booking search finds a booking by reference.
  await admin.goto(`${t.baseUrl}/pages/admin/bookings.html?q=${encodeURIComponent(reference(othersId))}`);
  await admin.waitForSelector(`tr[data-booking-id="${othersId}"]`);
  t.check('bookings: searching by reference finds that booking',
    (await admin.locator('tbody tr').count()) === 1);
}
