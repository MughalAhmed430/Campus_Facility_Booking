// Managing facilities and users as an administrator.
//
// Facilities: the list, creating one (field errors from the server, a room number already
// taken, equipment with quantities), editing it, and closing it while it has bookings: the
// count-and-link warning in the dialog and on the page, with the bookings left in place.
// Users: the list and its filters, deactivating an account (signed out at once, bookings
// left in place, the same warning), activating it again, and no button for your own account.
//
// It makes a facility and accounts of its own, so the other groups' data does not matter.
import { ACCOUNTS } from '../harness.js';

const PASSWORD = 'Student@2026';
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const LIST = '/pages/admin/facilities.html';
const FORM = '/pages/admin/facility-form.html';
const USERS = '/pages/admin/users.html';
const NAME = 'Media Studio';
const RENAMED = 'Media Studio B';

/** A date `daysAhead` from today in Korea, YYYY-MM-DD. */
function campusDate(daysAhead) {
  return new Date(Date.now() + KST_MS + daysAhead * DAY_MS).toISOString().slice(0, 10);
}

/** @param {import('../harness.js').Harness} t */
export default async function adminManage(t) {
  const db = t.db;
  const adminId = (await db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;
  const facilityRow = async (name) => (await db.query(
    `SELECT f.id, f.status, f.capacity, f.room_number, f.is_open_weekends, to_char(f.closes_at, 'HH24:MI') AS closes_at,
            (SELECT json_agg(json_build_object('name', e.name, 'quantity', fe.quantity) ORDER BY e.name)
               FROM facility_equipment fe JOIN equipment e ON e.id = fe.equipment_id WHERE fe.facility_id = f.id) AS equipment
     FROM facilities f WHERE f.name = $1`, [name],
  )).rows[0];

  async function newStudent(name, email) {
    const { rows } = await db.query(
      `INSERT INTO users (full_name, email, password_hash, role)
       VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), 'student') RETURNING id`,
      [name, email, PASSWORD],
    );
    return { id: rows[0].id, name, email, password: PASSWORD };
  }
  async function seedBooking(userId, facilityId, daysAhead, status) {
    const date = campusDate(daysAhead);
    await db.query(
      `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status, decided_by, decided_at)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 4, 'Manage check: studio session', $5, $6, $7)`,
      [userId, facilityId, `${date}T10:00:00+09:00`, `${date}T11:00:00+09:00`, status,
        status === 'approved' ? adminId : null, status === 'approved' ? new Date() : null],
    );
  }
  const delta = await newStudent('Manage Delta', 'manage.delta@kdu.example');

  // ---- Facilities: the list -------------------------------------------------------------
  const { context, page } = await t.newPage({ width: 1280 });
  await t.signIn(page, ACCOUNTS.admin, LIST);
  await waitFor(page, '#facilities');
  t.check('facilities: the menu has a Facilities link, marked as the current page',
    (await page.getAttribute(`.nav a[href="${LIST}"]`, 'aria-current')) === 'page');
  const seeded = (await db.query('SELECT count(*)::int AS n FROM facilities')).rows[0].n;
  t.check('facilities: every facility is listed, with how many take requests',
    (await page.locator('#facilities tbody tr').count()) === seeded && (await page.textContent('#facilities-count')).startsWith(`${seeded} facilities, `),
    await page.textContent('#facilities-count'));
  const labRow = await row(page, '#facilities', 'Computer Lab A').textContent();
  t.check('facilities: a row shows room, type, seats, hours and status',
    labRow.includes('ENG 310') && labRow.includes('Laboratory') && labRow.includes('30 seats') && labRow.includes('09:00–21:00') && labRow.includes('Bookable'), labRow);
  t.check('facilities: the changes offered depend on the status',
    (await row(page, '#facilities', 'Computer Lab A').getByRole('button').count()) === 2
    && (await row(page, '#facilities', 'Lecture Room 110').getByRole('button', { name: /^Reopen/ }).count()) === 1);
  await t.noHorizontalOverflow(page, 'admin facilities @ 1280px');
  await t.axe(page, 'admin facilities @ 1280px');
  await t.screenshot(page, 'admin-facilities-1280');

  // ---- Facilities: creating ---------------------------------------------------------------
  await page.getByRole('link', { name: 'New facility' }).click();
  await page.waitForSelector('#facility-form');
  t.check('new: the menu still marks Facilities as the current page',
    (await page.getAttribute(`.nav a[href="${LIST}"]`, 'aria-current')) === 'page');
  t.check('new: the hours start at 09:00 to 21:00, and quantities are off until an item is ticked',
    (await page.inputValue('[name=opensAt]')) === '09:00' && (await page.inputValue('[name=closesAt]')) === '21:00'
    && (await page.locator('.quantity-list__quantity:enabled').count()) === 0);
  await t.axe(page, 'new facility form @ 1280px');
  await page.click('#facility-form button[type=submit]');
  await page.waitForSelector('#facility-form [aria-invalid="true"]');
  const invalid = await page.$$eval('#facility-form [aria-invalid="true"]', (inputs) => inputs.map((input) => input.name));
  t.check('new: an empty form marks every required field, from the server\'s answer',
    JSON.stringify(invalid) === JSON.stringify(['name', 'buildingId', 'roomNumber', 'type', 'capacity', 'floor']), JSON.stringify(invalid));
  t.check('new: focus moves to the first invalid field', await page.evaluate(() => document.activeElement.name === 'name'));
  await t.axe(page, 'new facility form with field errors @ 1280px');
  await t.screenshot(page, 'admin-facility-form-1280-errors');

  await page.fill('[name=name]', NAME);
  await page.selectOption('[name=buildingId]', { label: 'Engineering Hall (ENG)' });
  await page.fill('[name=roomNumber]', '310'); // Computer Lab A's room
  await page.selectOption('[name=type]', 'meeting_room');
  await page.fill('[name=capacity]', '8');
  await page.fill('[name=floor]', '4');
  await page.fill('[name=closesAt]', '18:00');
  await page.fill('[name=description]', 'Recording desk and green screen.');
  await page.getByLabel('Projector', { exact: true }).check();
  await page.getByLabel('Whiteboard', { exact: true }).check();
  await page.fill('[name^="quantity-"]:enabled >> nth=1', '2');
  await page.click('#facility-form button[type=submit]');
  await page.waitForSelector('[name=roomNumber][aria-invalid="true"]');
  t.check('new: a room number already used in the building is refused under that field',
    (await page.textContent('#facility-form .field-error:not(:empty)')) === 'This building already has a facility with this room number.'
    && (await page.inputValue('[name=name]')) === NAME);
  await page.fill('[name=roomNumber]', '410');
  await Promise.all([page.waitForURL((url) => url.pathname === LIST), page.click('#facility-form button[type=submit]')]);
  await waitFor(page, '#facilities');
  t.check('new: back on the list, a toast confirms it and the address bar is clean',
    (await page.textContent('.toast-region')).includes('Facility created.') && new URL(page.url()).search === '');
  const created = await facilityRow(NAME);
  t.check('new: stored with its hours and its equipment quantities',
    created.status === 'active' && created.capacity === 8 && created.closes_at === '18:00' && created.is_open_weekends === false
    && JSON.stringify(created.equipment) === JSON.stringify([{ name: 'Projector', quantity: 1 }, { name: 'Whiteboard', quantity: 2 }]), JSON.stringify(created));
  t.check('new: it is in the list', (await row(page, '#facilities', NAME).textContent()).includes('ENG 410'));

  // ---- Facilities: editing ------------------------------------------------------------------
  await seedBooking(delta.id, created.id, 20, 'approved');
  await seedBooking(delta.id, created.id, 21, 'approved');
  await seedBooking(delta.id, created.id, 22, 'pending');
  await row(page, '#facilities', NAME).getByRole('link', { name: /^Edit/ }).click();
  await page.waitForSelector('#facility-form');
  t.check('edit: the form arrives filled in, equipment and quantities included',
    (await page.inputValue('[name=name]')) === NAME && (await page.inputValue('[name=roomNumber]')) === '410'
    && (await page.locator('.quantity-list__quantity:enabled').count()) === 2 && (await page.inputValue('[name^="quantity-"]:enabled >> nth=1')) === '2');
  const note = await page.textContent('.page-alert');
  t.check('edit: says the facility has upcoming approved bookings that an edit will not change, with a link to them',
    note.includes('This facility has 2 upcoming approved bookings') && (await page.locator('.page-alert a').getAttribute('href')).includes(`facility=${created.id}`), note);
  t.check('edit: the status is shown, not edited here', (await page.locator('#facility-form [name=status]').count()) === 0
    && (await page.textContent('#facility-form')).includes('from the facilities list'));
  await t.noHorizontalOverflow(page, 'edit facility form @ 1280px');
  await t.axe(page, 'edit facility form @ 1280px');
  await t.screenshot(page, 'admin-facility-form-1280-edit');
  await page.fill('[name=name]', RENAMED);
  await page.fill('[name=capacity]', '10');
  await page.getByLabel('Whiteboard', { exact: true }).uncheck();
  await page.getByLabel('Open on Saturdays and Sundays').check();
  await Promise.all([page.waitForURL((url) => url.pathname === LIST), page.click('#facility-form button[type=submit]')]);
  await waitFor(page, '#facilities');
  const edited = await facilityRow(RENAMED);
  t.check('edit: the changes are stored, and removed equipment is gone',
    edited.id === created.id && edited.capacity === 10 && edited.is_open_weekends === true
    && JSON.stringify(edited.equipment) === JSON.stringify([{ name: 'Projector', quantity: 1 }]), JSON.stringify(edited));
  t.check('edit: a toast confirms it', (await page.textContent('.toast-region')).includes('Facility saved.'));

  // ---- Facilities: closing one that has bookings -----------------------------------------------
  const dialog = page.locator('dialog[open]');
  const deactivateButton = row(page, '#facilities', RENAMED).getByRole('button', { name: /^Deactivate/ });
  await deactivateButton.click();
  await dialog.waitFor();
  const dialogText = await dialog.textContent();
  t.check('deactivate: the dialog says how many approved bookings remain and that they are not cancelled',
    dialogText.includes('It has 2 upcoming approved bookings.') && dialogText.includes('not cancelled automatically'), dialogText);
  t.check('deactivate: it says pending requests cannot be approved meanwhile', dialogText.includes('1 pending request for it cannot be approved while it is closed.'), dialogText);
  const dialogLink = await dialog.getByRole('link', { name: 'View these bookings' }).getAttribute('href');
  t.check('deactivate: the dialog links to those bookings on the Bookings page',
    dialogLink.startsWith('/pages/admin/bookings.html?') && dialogLink.includes(`facility=${created.id}`) && dialogLink.includes('status=approved'), dialogLink);
  await t.axe(page, 'deactivate facility dialog @ 1280px');
  await t.screenshot(page, 'admin-facilities-1280-deactivate');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  t.check('deactivate: Escape changes nothing, and focus returns to the button',
    (await facilityRow(RENAMED)).status === 'active' && (await deactivateButton.evaluate((button) => button === document.activeElement)));

  await deactivateButton.click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Deactivate facility', exact: true }).click();
  await page.waitForSelector('#facilities-alert .alert--warning');
  t.check('deactivate: the facility is inactive, and its bookings are all still there',
    (await facilityRow(RENAMED)).status === 'inactive'
    && (await db.query("SELECT count(*)::int AS n FROM bookings WHERE facility_id = $1 AND status IN ('approved', 'pending')", [created.id])).rows[0].n === 3);
  const warning = await page.textContent('#facilities-alert');
  t.check('deactivate: the page says the bookings were left in place, with a link to review them',
    warning.includes(`${RENAMED} still has 2 upcoming approved bookings`) && warning.includes('left in place')
    && (await page.locator('#facilities-alert a').getAttribute('href')) === dialogLink, warning);
  t.check('deactivate: the row shows Inactive and offers only Reactivate',
    (await row(page, '#facilities', RENAMED).textContent()).includes('Inactive')
    && (await row(page, '#facilities', RENAMED).getByRole('button').count()) === 1);
  t.check('deactivate: focus stays on the facility\'s row', await page.evaluate((name) => document.activeElement.closest('tr')?.textContent.includes(name) ?? false, RENAMED));
  await t.noHorizontalOverflow(page, 'admin facilities with a warning @ 1280px');
  await t.axe(page, 'admin facilities with a warning @ 1280px');
  await t.screenshot(page, 'admin-facilities-1280-warning');

  await page.click('#facilities-alert a');
  await page.waitForFunction(() => document.getElementById('result-count')?.textContent.includes('match your filters'));
  t.check('deactivate: the link opens Bookings showing exactly those bookings',
    (await page.textContent('#result-count')) === '2 bookings match your filters' && (await page.locator('#bookings tbody tr', { hasText: RENAMED }).count()) === 2,
    await page.textContent('#result-count'));

  await page.goto(`${t.baseUrl}${LIST}`);
  await waitFor(page, '#facilities');
  await row(page, '#facilities', RENAMED).getByRole('button', { name: /^Reactivate/ }).click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Open for bookings', exact: true }).click();
  await row(page, '#facilities', RENAMED).getByRole('button', { name: /^Deactivate/ }).waitFor();
  t.check('reactivate: the facility takes requests again, with no warning', (await facilityRow(RENAMED)).status === 'active'
    && (await page.locator('#facilities-alert .alert').count()) === 0);

  // ---- Users --------------------------------------------------------------------------------------
  await page.goto(`${t.baseUrl}${USERS}`);
  await waitFor(page, '#users');
  t.check('users: the menu has a Users link, marked as the current page', (await page.getAttribute(`.nav a[href="${USERS}"]`, 'aria-current')) === 'page');
  const accounts = (await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  t.check('users: the count is every account', (await page.textContent('#result-count')).startsWith(`${accounts} users`), await page.textContent('#result-count'));
  t.check('users: your own account has no button', (await row(page, '#users', 'admin@kdu.example').textContent()).includes('Your account')
    && (await row(page, '#users', 'admin@kdu.example').getByRole('button').count()) === 0);
  await t.noHorizontalOverflow(page, 'admin users @ 1280px');
  await t.axe(page, 'admin users @ 1280px');
  await t.screenshot(page, 'admin-users-1280');

  await page.selectOption('#filter-role', 'admin');
  await page.waitForFunction(() => document.getElementById('result-count').textContent.includes('your filters'));
  t.check('users: the role filter leaves administrators only, and is kept in the address bar',
    (await page.locator('#users tbody tr').count()) === (await db.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin'")).rows[0].n
    && new URL(page.url()).searchParams.get('role') === 'admin', page.url());
  await page.click('#filter-clear');
  await page.fill('#filter-q', 'manage delta');
  await page.waitForFunction(() => document.getElementById('result-count').textContent === '1 user matches your filters');
  const deltaRow = await row(page, '#users', delta.email).textContent();
  t.check('users: search finds a person; the row shows their role, account state and upcoming bookings',
    deltaRow.includes('Student') && deltaRow.includes('Active') && deltaRow.includes('2 approved, 1 pending'), deltaRow);

  // Deactivating: signed out at once, bookings left in place
  const { page: deltaPage } = await t.newPage({ width: 1280 });
  await t.signIn(deltaPage, delta, '/pages/my-bookings.html');
  await deltaPage.waitForSelector('.tabs__panel:not([aria-busy]) > *');

  await row(page, '#users', delta.email).getByRole('button', { name: /^Deactivate/ }).click();
  await dialog.waitFor();
  const userDialog = await dialog.textContent();
  t.check('deactivate user: the dialog says what happens and which bookings remain',
    userDialog.includes('signed out everywhere') && userDialog.includes('Upcoming bookings: 2 approved, 1 pending.') && userDialog.includes('not cancelled automatically'), userDialog);
  await t.axe(page, 'deactivate user dialog @ 1280px');
  await dialog.getByRole('button', { name: 'Deactivate account', exact: true }).click();
  await page.waitForSelector('#users-alert .alert--warning');
  t.check('deactivate user: the account is deactivated, and its bookings are still there',
    (await db.query('SELECT is_active FROM users WHERE id = $1', [delta.id])).rows[0].is_active === false
    && (await db.query("SELECT count(*)::int AS n FROM bookings WHERE user_id = $1 AND status IN ('approved', 'pending')", [delta.id])).rows[0].n === 3);
  t.check('deactivate user: the row says Deactivated and offers Activate; the page links to the bookings left',
    (await row(page, '#users', delta.email).textContent()).includes('Deactivated')
    && (await row(page, '#users', delta.email).getByRole('button', { name: /^Activate/ }).count()) === 1
    && (await page.locator('#users-alert a').getAttribute('href')).includes('manage.delta'));
  await t.axe(page, 'admin users with a warning @ 1280px');

  await deltaPage.reload();
  await deltaPage.waitForURL((url) => url.pathname === '/pages/login.html');
  t.check('deactivate user: their open session ends, and they are sent to sign in', true);
  await deltaPage.fill('#login-email', delta.email);
  await deltaPage.fill('#login-password', PASSWORD);
  await deltaPage.click('#login-form button[type=submit]');
  await deltaPage.waitForSelector('.alert--danger');
  t.check('deactivate user: signing in again is refused like a wrong password', (await deltaPage.textContent('.alert--danger')).includes('Invalid email or password.'));

  await page.selectOption('#filter-status', 'inactive');
  await page.waitForFunction(() => document.querySelectorAll('#users tbody tr').length === 1 && !document.getElementById('users').hasAttribute('aria-busy'));
  await row(page, '#users', delta.email).getByRole('button', { name: /^Activate/ }).click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Activate account', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('result-count').textContent === 'No users match your filters');
  t.check('activate: the account is active again and leaves the "Deactivated" list',
    (await db.query('SELECT is_active FROM users WHERE id = $1', [delta.id])).rows[0].is_active === true
    && (await page.textContent('#users')).includes('No users match these filters'));
  await t.axe(page, 'admin users, no matches @ 1280px');
  const adminCookies = await context.cookies();
  await context.close();

  // ---- Phone ----------------------------------------------------------------------------------------
  const { page: phone } = await t.newPage({ width: 320, height: 800, cookies: adminCookies });
  await phone.goto(`${t.baseUrl}${LIST}`);
  await waitFor(phone, '#facilities');
  t.check('320px: each facility is a card', await phone.evaluate(() => getComputedStyle(document.querySelector('#facilities tbody tr')).display === 'block'));
  await t.noHorizontalOverflow(phone, 'admin facilities @ 320px');
  await row(phone, '#facilities', RENAMED).getByRole('button', { name: /^Deactivate/ }).click();
  const phoneDialog = phone.locator('dialog[open]');
  await phoneDialog.waitFor();
  t.check('320px: the deactivate dialog fits', await phoneDialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.left > 0 && box.right < window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight;
  }));
  await t.axe(phone, 'deactivate facility dialog @ 320px');
  await phoneDialog.getByRole('button', { name: 'Go back' }).click();
  await phone.goto(`${t.baseUrl}${FORM}?id=${created.id}`);
  await phone.waitForSelector('#facility-form');
  await t.noHorizontalOverflow(phone, 'edit facility form @ 320px');
  await t.axe(phone, 'edit facility form @ 320px');
  await t.screenshot(phone, 'admin-facility-form-320');
  await phone.goto(`${t.baseUrl}${FORM}?id=999999`);
  await phone.waitForSelector('main .state');
  t.check('form: a facility that does not exist says so, with a way back', (await phone.textContent('main')).includes('Facility not found')
    && (await phone.getByRole('link', { name: 'Back to facilities' }).getAttribute('href')) === LIST);

  // ---- Who may open these pages -------------------------------------------------------------------------
  const { page: studentPage } = await t.newPage({ width: 1280 });
  await t.signIn(studentPage, ACCOUNTS.student);
  for (const path of [LIST, FORM, USERS]) {
    await studentPage.goto(`${t.baseUrl}${path}`);
    await studentPage.waitForSelector('main .state');
    t.check(`access: a student cannot open ${path}`, (await studentPage.textContent('main')).includes('This page is not available to your account'));
  }
  t.check('access: students have no admin Facilities or Users menu links',
    (await studentPage.locator(`.nav a[href="${LIST}"], .nav a[href="${USERS}"]`).count()) === 0);
}

/** Waits until the list in `selector` has finished loading and shows something. */
function waitFor(page, selector) {
  return page.waitForSelector(`${selector}:not([aria-busy]) > *`);
}

function row(page, scope, text) {
  return page.locator(`${scope} tbody tr`, { hasText: text });
}
