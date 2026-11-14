// Managing accounts as an administrator, through the real app: GET /api/users and
// PATCH /api/users/:id/status. Each test makes accounts of its own.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

const NOW = new Date('2035-03-07T05:00:00Z'); // Wednesday 7 March 2035, 14:00 in Korea
const PASSWORD = 'Student@2026';

let server;
let admin; // session cookie
let adminId;
let labId;

before(async () => {
  server = await startTestServer();
  server.setClock(() => NOW);
  admin = await server.login('admin@kdu.example', 'Admin@2026');
  adminId = (await server.db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;
  labId = (await server.db.query("SELECT id FROM facilities WHERE name = 'Computer Lab A'")).rows[0].id;
});

after(async () => {
  await server?.close();
});

let accountCount = 0;
/** A new account: { id, name, email }. Not signed in. */
async function newAccount({ name, role = 'student', studentNumber = null, active = true } = {}) {
  accountCount += 1;
  const fullName = name ?? `Users Test ${String(accountCount).padStart(3, '0')}`;
  const email = `users.test.${accountCount}@kdu.example`;
  const { rows } = await server.db.query(
    `INSERT INTO users (full_name, email, password_hash, role, student_number, is_active)
     VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), $4, $5, $6)
     RETURNING id`,
    [fullName, email, PASSWORD, role, studentNumber, active],
  );
  return { id: rows[0].id, name: fullName, email };
}

async function seedBooking(userId, { date, status, startTime = '10:00', endTime = '11:00' }) {
  const decided = status !== 'pending';
  await server.db.query(
    `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status, decided_by, decided_at)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 4, 'Seeded by a test', $5, $6, $7::timestamptz)`,
    [userId, labId, `${date}T${startTime}:00+09:00`, `${date}T${endTime}:00+09:00`, status, decided ? adminId : null, decided ? NOW : null],
  );
}

function list(params = {}, cookie = admin) {
  const query = new URLSearchParams(params).toString();
  return server.request(`/users${query ? `?${query}` : ''}`, { cookie });
}
const setActive = (id, active, cookie = admin) => server.request(`/users/${id}/status`, { method: 'PATCH', body: { active }, cookie });
const isActive = async (id) => (await server.db.query('SELECT is_active FROM users WHERE id = $1', [id])).rows[0].is_active;
const names = (response) => response.body.data.users.map((user) => user.fullName);

describe('GET /api/users', () => {
  test('lists every account by name, with what an administrator needs and no password hash', async () => {
    const response = await list();
    assert.equal(response.status, 200);
    const { users, total, page, pageSize } = response.body.data;
    assert.deepEqual({ page, pageSize }, { page: 1, pageSize: 20 });
    assert.ok(total >= 5);
    assert.deepEqual(names(response), names(response).toSorted((a, b) => a.localeCompare(b)));

    const minjun = users.find((user) => user.email === 'minjun.kim@kdu.example');
    assert.deepEqual(Object.keys(minjun).sort(), [
      'createdAt', 'email', 'fullName', 'id', 'isActive', 'pendingRequests', 'role', 'studentNumber', 'upcomingApprovedBookings',
    ]);
    assert.deepEqual({ fullName: minjun.fullName, role: minjun.role, studentNumber: minjun.studentNumber, isActive: minjun.isActive },
      { fullName: 'Kim Min-jun', role: 'student', studentNumber: '231001', isActive: true });
    assert.ok(!JSON.stringify(response.body).includes('$2'), 'no bcrypt hash anywhere in the response');
  });

  test('counts each account\'s upcoming approved bookings and pending requests', async () => {
    const account = await newAccount({ name: 'Counted Student' });
    await seedBooking(account.id, { date: '2035-04-02', status: 'approved' });
    await seedBooking(account.id, { date: '2035-04-03', status: 'pending' });
    await seedBooking(account.id, { date: '2035-04-03', status: 'pending', startTime: '13:00', endTime: '14:00' });
    await seedBooking(account.id, { date: '2035-03-01', status: 'completed' });
    const [user] = (await list({ q: 'Counted Student' })).body.data.users;
    assert.deepEqual({ approved: user.upcomingApprovedBookings, pending: user.pendingRequests }, { approved: 1, pending: 2 });
  });

  test('filters by search (name, email, student number), role and status, combined with AND', async () => {
    const active = await newAccount({ name: 'Filter Alpha', studentNumber: '880001' });
    const inactive = await newAccount({ name: 'Filter Beta', active: false });
    const otherAdmin = await newAccount({ name: 'Filter Gamma', role: 'admin' });

    assert.deepEqual(names(await list({ q: 'filter' })), ['Filter Alpha', 'Filter Beta', 'Filter Gamma']);
    assert.deepEqual(names(await list({ q: 'FILTER al' })), ['Filter Alpha'], 'any capitals');
    assert.deepEqual(names(await list({ q: inactive.email })), ['Filter Beta']);
    assert.deepEqual(names(await list({ q: '880001' })), ['Filter Alpha']);
    assert.deepEqual(names(await list({ q: 'filter', role: 'admin' })), [otherAdmin.name]);
    assert.deepEqual(names(await list({ q: 'filter', status: 'inactive' })), ['Filter Beta']);
    assert.deepEqual(names(await list({ q: 'filter', role: 'student', status: 'active' })), [active.name]);
    assert.deepEqual(names(await list({ q: 'fil_er' })), [], '_ is plain text, not a wildcard');
  });

  test('20 to a page, with the total', async () => {
    for (let i = 0; i < 25; i += 1) await newAccount({ name: `Paging Person ${String(i).padStart(2, '0')}` });
    const one = (await list({ q: 'Paging Person' })).body.data;
    assert.deepEqual({ shown: one.users.length, total: one.total, totalPages: one.totalPages }, { shown: 20, total: 25, totalPages: 2 });
    const two = (await list({ q: 'Paging Person', page: 2 })).body.data;
    assert.deepEqual(two.users.map((user) => user.fullName), ['Paging Person 20', 'Paging Person 21', 'Paging Person 22', 'Paging Person 23', 'Paging Person 24']);
  });

  test('400 for an unknown role, status or page, all in one answer', async () => {
    const response = await list({ role: 'teacher', status: 'banned', page: '0' });
    assert.equal(response.status, 400);
    assert.deepEqual(Object.keys(response.body.error.details).sort(), ['page', 'role', 'status']);
  });

  test('401 without a session, 403 for a student', async () => {
    const student = await server.login('minjun.kim@kdu.example', PASSWORD);
    assert.equal((await list({}, null)).status, 401);
    assert.equal((await list({}, student)).status, 403);
  });
});

describe('PATCH /api/users/:id/status', () => {
  test('deactivating signs the person out at once and stops them signing in; their bookings stay', async () => {
    const account = await newAccount();
    await seedBooking(account.id, { date: '2035-04-06', status: 'approved' });
    const cookie = await server.login(account.email, PASSWORD);
    assert.equal((await server.request('/bookings/mine', { cookie })).status, 200);

    const response = await setActive(account.id, false);
    assert.equal(response.status, 200);
    assert.deepEqual(
      { id: response.body.data.user.id, isActive: response.body.data.user.isActive, left: response.body.data.user.upcomingApprovedBookings },
      { id: account.id, isActive: false, left: 1 },
    );
    assert.equal((await server.request('/bookings/mine', { cookie })).status, 401, 'the open session stops working');
    assert.equal((await server.db.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [account.id])).rows[0].n, 0);
    await assert.rejects(server.login(account.email, PASSWORD), /HTTP 401/);
    assert.equal((await server.db.query('SELECT status FROM bookings WHERE user_id = $1', [account.id])).rows[0].status, 'approved');
  });

  test('reactivating lets them sign in again; the old session stays ended', async () => {
    const account = await newAccount();
    const oldCookie = await server.login(account.email, PASSWORD);
    await setActive(account.id, false);
    const response = await setActive(account.id, true);
    assert.equal(response.body.data.user.isActive, true);
    assert.equal((await server.request('/bookings/mine', { cookie: oldCookie })).status, 401);
    const cookie = await server.login(account.email, PASSWORD);
    assert.equal((await server.request('/bookings/mine', { cookie })).status, 200);
  });

  test('setting the state an account already has changes nothing and succeeds', async () => {
    const account = await newAccount();
    assert.equal((await setActive(account.id, true)).status, 200);
    assert.equal(await isActive(account.id), true);
  });

  test('409 CANNOT_DEACTIVATE_SELF for your own account; activating yourself is harmless', async () => {
    const response = await setActive(adminId, false);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'CANNOT_DEACTIVATE_SELF');
    assert.equal(await isActive(adminId), true);
    assert.equal((await setActive(adminId, true)).status, 200);
  });

  test('another administrator can be deactivated', async () => {
    const other = await newAccount({ role: 'admin' });
    assert.equal((await setActive(other.id, false)).status, 200);
    assert.equal(await isActive(other.id), false);
  });

  test('400 when active is missing or not true/false, 400 for an invalid id, 404 for an account that does not exist', async () => {
    const account = await newAccount();
    for (const body of [{}, { active: 'false' }, { active: 0 }]) {
      const response = await server.request(`/users/${account.id}/status`, { method: 'PATCH', body, cookie: admin });
      assert.equal(response.status, 400);
      assert.deepEqual(Object.keys(response.body.error.details), ['active']);
    }
    assert.equal(await isActive(account.id), true);
    assert.equal((await setActive('abc', false)).status, 400);
    const missing = await setActive(999999, false);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'USER_NOT_FOUND');
  });

  test('401 without a session, 403 for a student, even for their own account; nothing changes', async () => {
    const account = await newAccount();
    const cookie = await server.login(account.email, PASSWORD);
    assert.equal((await setActive(account.id, false, null)).status, 401);
    assert.equal((await setActive(account.id, false, cookie)).status, 403);
    assert.equal(await isActive(account.id), true);
  });
});

describe('two administrators deactivating each other at once, through the real API', () => {
  test('exactly one succeeds, so an active administrator always remains', async () => {
    const first = await newAccount({ role: 'admin' });
    const second = await newAccount({ role: 'admin' });
    const firstCookie = await server.login(first.email, PASSWORD);
    const secondCookie = await server.login(second.email, PASSWORD);

    const together = server.holdUntilSimultaneous(/^BEGIN$/, 2);
    const responses = await Promise.all([setActive(second.id, false, firstCookie), setActive(first.id, false, secondCookie)]);
    await together; // rejects unless both transactions were waiting to start at the same moment

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
    assert.deepEqual([await isActive(first.id), await isActive(second.id)].sort(), [false, true]);
  });
});
