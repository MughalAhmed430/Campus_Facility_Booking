// GET /api/bookings (every booking, for administrators) and an administrator's
// POST /api/bookings/:id/cancel, through the real app.
//
// The campus clock is frozen in 2035, so the sample bookings (dated relative to the real
// today) are all in the past. The tests use students of their own, in April to June 2035,
// and find their bookings with filters, so the sample data never gets in the way.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

const NOW = new Date('2035-03-07T05:00:00Z'); // Wednesday 7 March 2035, 14:00 in Korea
const TODAY = '2035-03-07';
const PASSWORD = 'Student@2026';
const DAY_MS = 24 * 60 * 60 * 1000;
const REASON = 'The room is needed for a make-up examination.';

let server;
let admin; // session cookie
let adminId;
const facilityIds = {};

before(async () => {
  server = await startTestServer();
  server.setClock(() => NOW);
  admin = await server.login('admin@kdu.example', 'Admin@2026');
  adminId = (await server.db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;
  for (const row of (await server.db.query('SELECT id, name FROM facilities')).rows) facilityIds[row.name] = row.id;
});

after(async () => {
  await server?.close();
});

const lab = () => facilityIds['Computer Lab A'];
const physics = () => facilityIds['Physics Lab'];

let studentCount = 0;
/** A new student account with no bookings, signed in: { id, name, email, cookie }. */
async function newStudent({ name, studentNumber = null } = {}) {
  studentCount += 1;
  const fullName = name ?? `Admin List Student ${studentCount}`;
  const email = `admin.list.${studentCount}@kdu.example`;
  const { rows } = await server.db.query(
    `INSERT INTO users (full_name, email, password_hash, role, student_number)
     VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), 'student', $4)
     RETURNING id`,
    [fullName, email, PASSWORD, studentNumber],
  );
  return { id: rows[0].id, name: fullName, email, cookie: await server.login(email, PASSWORD) };
}

// Approved bookings in one room must not overlap, so each test that needs free time takes
// a weekday of its own, well after the frozen today.
let cursor = Date.parse('2035-05-01T00:00:00Z');
function freshWeekday() {
  do cursor += DAY_MS; while ([0, 6].includes(new Date(cursor).getUTCDay()));
  return new Date(cursor).toISOString().slice(0, 10);
}

/** Puts a booking straight into the test database, with the audit fields its status requires. Returns its id. */
async function seedBooking(owner, {
  date, startTime = '10:00', endTime = '11:00', status = 'pending', facilityId = lab(),
  purpose = 'Seeded by a test', notes = null, decisionNote = null, cancelledBy = 'owner', reason = null,
} = {}) {
  const decided = ['approved', 'rejected', 'completed'].includes(status);
  const cancelled = status === 'cancelled';
  const { rows } = await server.db.query(
    `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, notes, status,
                           decided_by, decided_at, decision_note, cancelled_by, cancelled_at, cancellation_reason)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 4, $5, $6, $7,
             $8, $9::timestamptz, $10, $11, $12::timestamptz, $13)
     RETURNING id`,
    [owner.id, facilityId, `${date}T${startTime}:00+09:00`, `${date}T${endTime}:00+09:00`, purpose, notes, status,
      decided ? adminId : null, decided ? NOW : null, decisionNote,
      cancelled ? (cancelledBy === 'admin' ? adminId : owner.id) : null, cancelled ? NOW : null, reason],
  );
  return rows[0].id;
}

async function row(id) {
  const { rows } = await server.db.query(
    'SELECT status, cancelled_by, cancelled_at, cancellation_reason, decided_by, decided_at FROM bookings WHERE id = $1',
    [id],
  );
  return rows[0];
}

/** GET /api/bookings with these query parameters, as the administrator unless a cookie is given. */
function list(params = {}, cookie = admin) {
  const query = new URLSearchParams(params).toString();
  return server.request(`/bookings${query ? `?${query}` : ''}`, { cookie });
}
const cancel = (id, cookie, body) => server.request(`/bookings/${id}/cancel`, { method: 'POST', body, cookie });
const ids = (response) => response.body.data.bookings.map((booking) => booking.id);

describe('GET /api/bookings', () => {
  test('lists every student\'s bookings, latest start first, with the whole record', async () => {
    const student = await newStudent({ name: 'Whole Record Student', studentNumber: '777001' });
    const other = await newStudent();
    const day = freshWeekday();
    const early = await seedBooking(student, { date: day, startTime: '09:00', endTime: '10:30', notes: 'Bring an adapter.' });
    const late = await seedBooking(other, { date: day, startTime: '15:00', endTime: '16:00', status: 'approved', decisionNote: 'Key at the office.' });

    const response = await list({ from: day, to: day });
    assert.equal(response.status, 200);
    const { bookings, total, page, pageSize, totalPages } = response.body.data;
    assert.deepEqual({ total, page, pageSize, totalPages }, { total: 2, page: 1, pageSize: 20, totalPages: 1 });
    assert.deepEqual(bookings.map((booking) => booking.id), [late, early]);

    assert.deepEqual(bookings[1], {
      id: early,
      status: 'pending',
      date: day,
      startTime: '09:00',
      endTime: '10:30',
      participantCount: 4,
      purpose: 'Seeded by a test',
      notes: 'Bring an adapter.',
      createdAt: bookings[1].createdAt,
      hasStarted: false,
      canCancel: false,
      student: { id: student.id, fullName: 'Whole Record Student', email: student.email, studentNumber: '777001' },
      facility: {
        id: lab(), name: 'Computer Lab A', roomNumber: bookings[1].facility.roomNumber, capacity: bookings[1].facility.capacity,
        building: bookings[1].facility.building,
      },
      decision: null,
      cancellation: null,
    });
    assert.deepEqual(bookings[0].decision, {
      decidedAt: NOW.toISOString(), note: 'Key at the office.', by: { id: adminId, fullName: 'Facilities Administrator' },
    });
    assert.equal(bookings[0].canCancel, true);
  });

  test('a cancelled booking says who cancelled it: the student, or an administrator by name', async () => {
    const student = await newStudent();
    const day = freshWeekday();
    const byStudent = await seedBooking(student, { date: day, startTime: '09:00', status: 'cancelled', reason: 'Plans changed.' });
    const byAdmin = await seedBooking(student, { date: day, startTime: '13:00', endTime: '14:00', status: 'cancelled', cancelledBy: 'admin', reason: REASON });

    const { bookings } = (await list({ from: day, to: day })).body.data;
    const find = (id) => bookings.find((booking) => booking.id === id).cancellation;
    assert.deepEqual(find(byStudent), {
      cancelledAt: NOW.toISOString(), reason: 'Plans changed.', byStudent: true, by: { id: student.id, fullName: student.name },
    });
    assert.deepEqual(find(byAdmin), {
      cancelledAt: NOW.toISOString(), reason: REASON, byStudent: false, by: { id: adminId, fullName: 'Facilities Administrator' },
    });
  });

  test('filters by status (one or several), facility, dates and student, combined with AND', async () => {
    const kim = await newStudent({ name: 'Filter Kim', studentNumber: '777002' });
    const lee = await newStudent({ name: 'Filter Lee' });
    const first = freshWeekday();
    const second = freshWeekday();
    const pending = await seedBooking(kim, { date: first });
    const approved = await seedBooking(kim, { date: first, startTime: '13:00', endTime: '14:00', status: 'approved' });
    const rejected = await seedBooking(lee, { date: second, status: 'rejected' });
    const inPhysics = await seedBooking(lee, { date: second, startTime: '13:00', endTime: '14:00', facilityId: physics() });
    const range = { from: first, to: second };

    assert.deepEqual(ids(await list({ ...range, status: 'approved' })), [approved]);
    assert.deepEqual(ids(await list({ ...range, status: 'approved,rejected' })), [rejected, approved]);
    assert.deepEqual(ids(await list({ ...range, facility: physics() })), [inPhysics]);
    assert.deepEqual(ids(await list({ from: second, to: second })), [inPhysics, rejected]);
    assert.deepEqual(ids(await list({ from: second })).slice(-2), [inPhysics, rejected], 'from alone: that day and later');
    assert.deepEqual(ids(await list({ ...range, q: 'filter kim' })), [approved, pending], 'name, any capitals');
    assert.deepEqual(ids(await list({ ...range, q: lee.email })), [inPhysics, rejected], 'email');
    assert.deepEqual(ids(await list({ ...range, q: '777002' })), [approved, pending], 'student number');
    assert.deepEqual(ids(await list({ ...range, q: 'Filter', status: 'pending', facility: lab() })), [pending]);
    assert.deepEqual(ids(await list({ ...range, q: 'nobody by this name' })), []);
  });

  test('dates are Korea dates: a booking at 00:30 belongs to that day, not the day before', async () => {
    const student = await newStudent();
    const day = freshWeekday();
    const id = await seedBooking(student, { date: day, startTime: '00:30', endTime: '01:30' });
    assert.deepEqual(ids(await list({ from: day, to: day })), [id]);
  });

  test('% and _ in the search are plain text, not wildcards', async () => {
    const student = await newStudent({ name: 'Percent 100% Sure' });
    const day = freshWeekday();
    const id = await seedBooking(student, { date: day });
    assert.deepEqual(ids(await list({ from: day, to: day, q: '100%' })), [id]);
    assert.deepEqual(ids(await list({ from: day, to: day, q: '1_0%' })), []);
    assert.deepEqual(ids(await list({ from: day, to: day, q: '%' })), [id]);
  });

  test('20 to a page; total and totalPages count them all; a page past the end is empty', async () => {
    const student = await newStudent({ name: 'Paging Student' });
    const seeded = [];
    for (let i = 0; i < 45; i += 1) {
      seeded.push(await seedBooking(student, { date: '2035-04-02', startTime: '09:00', endTime: '10:00', purpose: `Paging ${i}` }));
    }
    const newestFirst = seeded.toReversed(); // the same start time: the higher id first

    const one = (await list({ q: 'Paging Student' })).body.data;
    assert.deepEqual({ total: one.total, page: one.page, totalPages: one.totalPages }, { total: 45, page: 1, totalPages: 3 });
    assert.deepEqual(one.bookings.map((booking) => booking.id), newestFirst.slice(0, 20));
    const three = (await list({ q: 'Paging Student', page: 3 })).body.data;
    assert.deepEqual(three.bookings.map((booking) => booking.id), newestFirst.slice(40));
    const beyond = (await list({ q: 'Paging Student', page: 9 })).body.data;
    assert.deepEqual({ bookings: beyond.bookings, total: beyond.total, page: beyond.page, totalPages: beyond.totalPages },
      { bookings: [], total: 45, page: 9, totalPages: 3 });
  });

  test('no matches: an empty first page', async () => {
    const { bookings, total, totalPages } = (await list({ from: '2036-01-01', to: '2036-01-01' })).body.data;
    assert.deepEqual({ bookings, total, totalPages }, { bookings: [], total: 0, totalPages: 1 });
  });

  test('an approved booking that has ended is listed as completed', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: '2035-03-06', status: 'approved', facilityId: physics() });
    const { bookings } = (await list({ from: '2035-03-06', to: '2035-03-06', q: student.email })).body.data;
    assert.equal(bookings[0].status, 'completed');
    assert.equal(bookings[0].canCancel, false);
    assert.equal((await row(id)).status, 'completed');
  });

  for (const [name, params, field] of [
    ['an unknown status', { status: 'approved,deleted' }, 'status'],
    ['a facility that is not a number', { facility: 'lab' }, 'facility'],
    ['an impossible from date', { from: '2035-02-30' }, 'from'],
    ['a to date in another format', { to: '07/03/2035' }, 'to'],
    ['a to date before the from date', { from: '2035-03-08', to: '2035-03-07' }, 'to'],
    ['page 0', { page: '0' }, 'page'],
    ['a page that is not a number', { page: 'two' }, 'page'],
    ['a search over 100 characters', { q: 'x'.repeat(101) }, 'q'],
  ]) {
    test(`400 for ${name}`, async () => {
      const response = await list(params);
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      assert.deepEqual(Object.keys(response.body.error.details), [field]);
    });
  }

  test('every problem is listed in one 400', async () => {
    const response = await list({ status: 'x', facility: '0', from: 'soon' });
    assert.deepEqual(Object.keys(response.body.error.details).sort(), ['facility', 'from', 'status']);
  });

  test('401 without a session, 403 for a student', async () => {
    const student = await newStudent();
    assert.equal((await list({}, null)).status, 401);
    const response = await list({}, student.cookie);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FORBIDDEN');
  });
});

describe('POST /api/bookings/:id/cancel as an administrator', () => {
  test('cancels an approved booking, recording who, when and why, and keeps the approval record', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: freshWeekday(), status: 'approved' });

    const response = await cancel(id, admin, { reason: `  ${REASON}  ` });
    assert.equal(response.status, 200);
    const { booking } = response.body.data;
    assert.equal(booking.id, id);
    assert.equal(booking.status, 'cancelled');
    assert.equal(booking.canCancel, false);
    assert.deepEqual(booking.cancellation, {
      cancelledAt: booking.cancellation.cancelledAt, reason: REASON, byStudent: false, by: { id: adminId, fullName: 'Facilities Administrator' },
    });
    assert.equal(booking.decision.by.id, adminId, 'the approval is still on record');

    const stored = await row(id);
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.cancelled_by, adminId);
    assert.equal(stored.cancellation_reason, REASON);
    assert.ok(stored.cancelled_at instanceof Date);
    assert.equal(stored.decided_by, adminId);
  });

  test('the student sees it on My bookings, with the reason and without the administrator\'s name', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: freshWeekday(), status: 'approved' });
    await cancel(id, admin, { reason: REASON });

    const { bookings } = (await server.request('/bookings/mine', { cookie: student.cookie })).body.data;
    assert.equal(bookings[0].status, 'cancelled');
    assert.deepEqual(bookings[0].cancellation, { cancelledAt: bookings[0].cancellation.cancelledAt, byYou: false, reason: REASON });
    assert.ok(!JSON.stringify(bookings[0]).includes('Facilities Administrator'));
  });

  test('the time is free again: another request for it can be approved', async () => {
    const student = await newStudent();
    const other = await newStudent();
    const date = freshWeekday();
    const id = await seedBooking(student, { date, status: 'approved' });
    const waiting = await seedBooking(other, { date });

    assert.equal((await server.request(`/bookings/${waiting}/approve`, { method: 'POST', body: {}, cookie: admin })).status, 409);
    assert.equal((await cancel(id, admin, { reason: REASON })).status, 200);
    assert.equal((await server.request(`/bookings/${waiting}/approve`, { method: 'POST', body: {}, cookie: admin })).status, 200);
  });

  test('a booking in progress can still be cancelled, until it ends', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: TODAY, startTime: '13:00', endTime: '15:00', status: 'approved', facilityId: physics() });
    const response = await cancel(id, admin, { reason: REASON });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.booking.hasStarted, true);
    assert.equal((await row(id)).status, 'cancelled');
  });

  test('409 for an approved booking ending this very minute; nothing changes', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: TODAY, startTime: '12:00', endTime: '14:00', status: 'approved', facilityId: facilityIds['Chemistry Lab'] });
    const response = await cancel(id, admin, { reason: REASON });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'BOOKING_NOT_CANCELLABLE');
    assert.equal(response.body.error.message, 'This booking is already over, so it can no longer be cancelled.');
    assert.equal((await row(id)).status, 'approved');
  });

  for (const [status, message] of [
    ['pending', 'This request is still waiting for a decision. Reject it on the Requests page instead.'],
    ['rejected', 'This request was rejected, so there is nothing to cancel.'],
    ['cancelled', 'This booking has already been cancelled.'],
    ['completed', 'This booking is already over, so it can no longer be cancelled.'],
  ]) {
    test(`409 for a ${status} booking, saying why; nothing changes`, async () => {
      const student = await newStudent();
      const date = status === 'completed' ? '2035-03-05' : freshWeekday();
      const id = await seedBooking(student, { date, status, startTime: '16:00', endTime: '17:00', reason: status === 'cancelled' ? 'Plans changed.' : null });
      const before = await row(id);

      const response = await cancel(id, admin, { reason: REASON });
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'BOOKING_NOT_CANCELLABLE');
      assert.equal(response.body.error.message, message);
      assert.deepEqual(await row(id), before);
    });
  }

  for (const [name, body, message] of [
    ['no reason', {}, 'Reason is required.'],
    ['no body at all', undefined, 'Reason is required.'],
    ['a reason of only spaces', { reason: '    ' }, 'Reason is required.'],
    ['a reason under 5 characters', { reason: 'No.' }, 'Reason must be at least 5 characters.'],
    ['a reason over 500 characters', { reason: 'x'.repeat(501) }, 'Reason must be at most 500 characters.'],
    ['a reason that is not text', { reason: 42 }, 'Reason must be text.'],
  ]) {
    test(`400 for ${name}; nothing changes`, async () => {
      const student = await newStudent();
      const id = await seedBooking(student, { date: freshWeekday(), status: 'approved' });
      const response = await cancel(id, admin, body);
      assert.equal(response.status, 400);
      assert.equal(response.body.error.details.reason, message);
      assert.equal((await row(id)).status, 'approved');
    });
  }

  test('404 for a booking that does not exist, 400 for an invalid id', async () => {
    const missing = await cancel(999999, admin, { reason: REASON });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'BOOKING_NOT_FOUND');
    assert.equal((await cancel('abc', admin, { reason: REASON })).status, 400);
  });

  test('status, owner and other fields in the body are ignored', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: freshWeekday(), status: 'approved' });
    await cancel(id, admin, { reason: REASON, status: 'completed', cancelledBy: student.id, userId: adminId });
    const stored = await row(id);
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.cancelled_by, adminId);
  });

  test('a student still cannot cancel another student\'s booking through this address', async () => {
    const owner = await newStudent();
    const intruder = await newStudent();
    const id = await seedBooking(owner, { date: freshWeekday(), status: 'approved' });
    assert.equal((await cancel(id, intruder.cookie, { reason: REASON })).status, 404);
    assert.equal((await row(id)).status, 'approved');
  });
});

describe('POST /api/bookings/:id/cancel: an administrator and others at once, through the real API', () => {
  const CANCEL = /SET status = 'cancelled'/;

  test('the administrator and the student cancel at once: exactly one cancellation is stored', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: freshWeekday(), status: 'approved' });
    const together = server.holdUntilSimultaneous(CANCEL, 2);
    const responses = await Promise.all([
      cancel(id, admin, { reason: REASON }),
      cancel(id, student.cookie, { reason: 'Plans changed.' }),
    ]);
    await together; // rejects unless both UPDATEs were waiting at the same moment

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const stored = await row(id);
    const winner = responses[0].status === 200 ? { by: adminId, reason: REASON } : { by: student.id, reason: 'Plans changed.' };
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.cancelled_by, winner.by);
    assert.equal(stored.cancellation_reason, winner.reason, 'the loser did not overwrite the reason');
  });

  test('two administrators cancel the same booking at once: one succeeds', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: freshWeekday(), status: 'approved' });
    const secondAdmin = await server.login('admin@kdu.example', 'Admin@2026'); // a second session
    const together = server.holdUntilSimultaneous(CANCEL, 2);
    const responses = await Promise.all([
      cancel(id, admin, { reason: 'First administrator.' }),
      cancel(id, secondAdmin, { reason: 'Second administrator.' }),
    ]);
    await together;
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const loser = responses.find((response) => response.status === 409);
    assert.equal(loser.body.error.message, 'This booking has already been cancelled.');
  });
});
