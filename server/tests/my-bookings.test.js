// GET /api/bookings/mine and POST /api/bookings/:id/cancel through the real app, and the
// table of allowed status changes.
//
// The campus clock is frozen in 2035, so the sample bookings (dated relative to the real
// today) are all in the past, and "started" and "ended" are exact. Every test gets new
// students of its own, so the lists contain exactly what the test put there.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

const NOW = new Date('2035-03-07T05:00:00Z'); // Wednesday 7 March 2035, 14:00 in Korea
const TODAY = '2035-03-07';
const YESTERDAY = '2035-03-06';
const TOMORROW = '2035-03-08';
const PASSWORD = 'Student@2026';
const DAY_MS = 24 * 60 * 60 * 1000;

let server;
let admin; // session cookie
let adminId;
let service; // ../src/services/booking.service.js, imported once the test environment is set
const facilityIds = {};

before(async () => {
  server = await startTestServer();
  server.setClock(() => NOW);
  service = await import('../src/services/booking.service.js');
  admin = await server.login('admin@kdu.example', 'Admin@2026');
  adminId = (await server.db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;
  for (const row of (await server.db.query('SELECT id, name FROM facilities')).rows) facilityIds[row.name] = row.id;
});

after(async () => {
  await server?.close();
});

const lab = () => facilityIds['Computer Lab A'];

let studentCount = 0;
/** A new student account with no bookings, signed in: { id, cookie }. */
async function newStudent() {
  studentCount += 1;
  const email = `my.bookings.${studentCount}@kdu.example`;
  const { rows } = await server.db.query(
    `INSERT INTO users (full_name, email, password_hash, role)
     VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), 'student')
     RETURNING id`,
    [`Test Student ${studentCount}`, email, PASSWORD],
  );
  return { id: rows[0].id, cookie: await server.login(email, PASSWORD) };
}

// Approved bookings in the same room must not overlap, so tests that need a free slot
// each take a weekday of their own, well after the frozen today.
let cursor = Date.parse('2035-05-01T00:00:00Z');
function freshWeekday() {
  do cursor += DAY_MS; while ([0, 6].includes(new Date(cursor).getUTCDay()));
  return new Date(cursor).toISOString().slice(0, 10);
}

// Approved and completed bookings may not overlap in one room (bookings_no_overlap), and
// several tests need one at the same time today. Unless a test names a room, each gets
// the next room in turn; there are more rooms than such bookings in this file.
let roomTurn = 0;
function nextRoom() {
  const ids = Object.values(facilityIds).sort((a, b) => a - b);
  roomTurn += 1;
  return ids[roomTurn % ids.length];
}

/**
 * Puts a booking straight into the test database, with the audit fields its status
 * requires, and returns its id. cancelledBy: 'owner' or 'admin'. Pending, rejected and
 * cancelled bookings go in Computer Lab A unless facilityId says otherwise.
 */
async function seedBooking(owner, {
  date = TOMORROW, startTime = '10:00', endTime = '11:00', status = 'pending', facilityId,
  purpose = 'Seeded by a test', notes = null, decisionNote = null, cancelledBy = 'owner', reason = null,
} = {}) {
  facilityId ??= ['approved', 'completed'].includes(status) ? nextRoom() : lab();
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
    `SELECT status, cancelled_by, cancelled_at, cancellation_reason, decided_by, decided_at, updated_at
     FROM bookings WHERE id = $1`,
    [id],
  );
  return rows[0];
}

const mine = (cookie) => server.request('/bookings/mine', { cookie });
const cancel = (id, cookie, body = {}) => server.request(`/bookings/${id}/cancel`, { method: 'POST', body, cookie });

describe('status changes', () => {
  test('one table lists every allowed change; cancelled, rejected and completed are final', () => {
    assert.deepEqual(service.STATUS_TRANSITIONS, {
      pending: ['approved', 'rejected', 'cancelled'],
      approved: ['completed', 'cancelled'],
      rejected: [],
      cancelled: [],
      completed: [],
    });
    assert.deepEqual(service.statusesLeadingTo('cancelled'), ['pending', 'approved']);
    assert.deepEqual(service.statusesLeadingTo('completed'), ['approved']);
    assert.deepEqual(service.statusesLeadingTo('pending'), [], 'nothing goes back to pending');
  });

  test('the table cannot be changed at run time', () => {
    assert.throws(() => { service.STATUS_TRANSITIONS.rejected.push('approved'); }, TypeError);
  });
});

describe('GET /api/bookings/mine', () => {
  test('lists only the signed-in student\'s bookings, latest start first, in Korea time', async () => {
    const student = await newStudent();
    const other = await newStudent();
    const later = await seedBooking(student, { date: '2035-03-09', startTime: '13:00', endTime: '14:30', notes: 'Bring a projector adapter.' });
    const earlier = await seedBooking(student, { date: TOMORROW, startTime: '09:00', endTime: '10:00', status: 'approved' });
    const sameDayLater = await seedBooking(student, { date: TOMORROW, startTime: '16:00', endTime: '17:00', status: 'rejected' });
    await seedBooking(other, { date: TOMORROW });

    const response = await mine(student.cookie);
    assert.equal(response.status, 200);
    const { bookings } = response.body.data;
    assert.deepEqual(bookings.map((booking) => booking.id), [later, sameDayLater, earlier]);

    const { createdAt, ...rest } = bookings[0];
    assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(rest, {
      id: later,
      status: 'pending',
      facility: { id: lab(), name: 'Computer Lab A', roomNumber: '310', building: { code: 'ENG', name: 'Engineering Hall' } },
      date: '2035-03-09',
      startTime: '13:00',
      endTime: '14:30',
      participantCount: 4,
      purpose: 'Seeded by a test',
      notes: 'Bring a projector adapter.',
      hasStarted: false,
      canCancel: true,
      decision: null,
      cancellation: null,
    });
  });

  test('a student with no bookings gets an empty list', async () => {
    const response = await mine((await newStudent()).cookie);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.bookings, []);
  });

  test('shows decision notes and who cancelled, without naming the administrator', async () => {
    const student = await newStudent();
    const rejected = await seedBooking(student, { status: 'rejected', decisionNote: 'Please use the seminar room instead.' });
    const byAdmin = await seedBooking(student, { status: 'cancelled', cancelledBy: 'admin', reason: 'Needed for an exam.', startTime: '12:00', endTime: '13:00' });
    const byOwner = await seedBooking(student, { status: 'cancelled', cancelledBy: 'owner', startTime: '14:00', endTime: '15:00' });

    const response = await mine(student.cookie);
    const byId = Object.fromEntries(response.body.data.bookings.map((booking) => [booking.id, booking]));
    assert.equal(byId[rejected].decision.note, 'Please use the seminar room instead.');
    assert.match(byId[rejected].decision.decidedAt, /^2035-03-07T05:00:00/);
    assert.deepEqual({ ...byId[byAdmin].cancellation, cancelledAt: undefined }, { cancelledAt: undefined, byYou: false, reason: 'Needed for an exam.' });
    assert.deepEqual({ ...byId[byOwner].cancellation, cancelledAt: undefined }, { cancelledAt: undefined, byYou: true, reason: null });

    const text = JSON.stringify(response.body);
    assert.ok(!text.includes('Facilities Administrator') && !text.includes('admin@kdu.example'), 'no administrator name or email');
    assert.ok(!/decidedBy|cancelledBy|userId/.test(text), 'no user ids');
  });

  test('canCancel: pending at any time; approved only until it starts; never once final', async () => {
    const student = await newStudent();
    const date = freshWeekday();
    const cases = {
      'pending, later': [{ status: 'pending' }, true, false],
      'pending, start time passed': [{ status: 'pending', date: YESTERDAY }, true, true],
      'approved, later': [{ status: 'approved', date }, true, false],
      'approved, in progress': [{ status: 'approved', date: TODAY, startTime: '13:00', endTime: '15:00' }, false, true],
      rejected: [{ status: 'rejected' }, false, false],
      cancelled: [{ status: 'cancelled' }, false, false],
      completed: [{ status: 'completed', date: YESTERDAY }, false, true],
    };
    const ids = {};
    for (const [name, [fields]] of Object.entries(cases)) ids[name] = await seedBooking(student, fields);

    const byId = Object.fromEntries((await mine(student.cookie)).body.data.bookings.map((booking) => [booking.id, booking]));
    for (const [name, [, canCancel, hasStarted]] of Object.entries(cases)) {
      assert.equal(byId[ids[name]].canCancel, canCancel, `${name}: canCancel`);
      assert.equal(byId[ids[name]].hasStarted, hasStarted, `${name}: hasStarted`);
    }
    assert.equal(byId[ids['approved, in progress']].status, 'approved', 'not completed before it ends');
  });

  test('an approved booking that has ended is marked completed when listed; listing again changes nothing', async () => {
    const student = await newStudent();
    const ended = await seedBooking(student, { status: 'approved', date: YESTERDAY });
    const endsNow = await seedBooking(student, { status: 'approved', date: TODAY, startTime: '13:00', endTime: '14:00' });
    const before = await row(ended);

    const first = await mine(student.cookie);
    const statuses = Object.fromEntries(first.body.data.bookings.map((booking) => [booking.id, booking.status]));
    assert.equal(statuses[ended], 'completed');
    assert.equal(statuses[endsNow], 'completed', 'a booking ending exactly now is over');

    const after = await row(ended);
    assert.equal(after.status, 'completed');
    assert.equal(after.decided_by, before.decided_by, 'the approval is still recorded');
    assert.equal(after.decided_at.getTime(), before.decided_at.getTime());

    await mine(student.cookie);
    assert.equal((await row(ended)).updated_at.getTime(), after.updated_at.getTime(), 'the second listing wrote nothing');
  });

  test('another student\'s ended booking is left for their own listing', async () => {
    const student = await newStudent();
    const other = await newStudent();
    const theirs = await seedBooking(other, { status: 'approved', date: YESTERDAY, startTime: '16:00', endTime: '17:00' });
    await mine(student.cookie);
    assert.equal((await row(theirs)).status, 'approved');
  });

  test('401 without a session, 403 for an administrator', async () => {
    assert.equal((await server.request('/bookings/mine')).status, 401);
    const response = await mine(admin);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FORBIDDEN');
  });
});

describe('POST /api/bookings/:id/cancel: allowed', () => {
  test('a pending request is cancelled, recording who, when and why', async () => {
    const student = await newStudent();
    const id = await seedBooking(student);
    const response = await cancel(id, student.cookie, { reason: '  Our meeting moved online.  ' });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const { booking } = response.body.data;
    assert.equal(booking.id, id);
    assert.equal(booking.status, 'cancelled');
    assert.equal(booking.canCancel, false);
    assert.equal(booking.cancellation.byYou, true);
    assert.equal(booking.cancellation.reason, 'Our meeting moved online.');

    const stored = await row(id);
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.cancelled_by, student.id);
    assert.ok(stored.cancelled_at instanceof Date);
    assert.equal(stored.cancellation_reason, 'Our meeting moved online.');
    assert.equal(stored.decided_by, null, 'no decision is invented');
  });

  test('a pending request can still be cancelled after its start time has passed', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: YESTERDAY });
    assert.equal((await cancel(id, student.cookie)).status, 200);
    assert.equal((await row(id)).status, 'cancelled');
  });

  test('an approved booking that has not started is cancelled, keeps its approval record, and frees the time', async () => {
    const student = await newStudent();
    const other = await newStudent();
    const date = freshWeekday();
    const id = await seedBooking(student, { status: 'approved', date, startTime: '10:00', endTime: '12:00', facilityId: lab() });
    const request = { facilityId: lab(), date, startTime: '10:30', endTime: '11:30', participantCount: 3, purpose: 'Wants the same time' };

    assert.equal((await server.request('/bookings', { method: 'POST', body: request, cookie: other.cookie })).status, 409, 'taken before');
    assert.equal((await cancel(id, student.cookie)).status, 200);
    const stored = await row(id);
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.decided_by, adminId, 'the approval stays on record');
    assert.equal((await server.request('/bookings', { method: 'POST', body: request, cookie: other.cookie })).status, 201, 'free after');
  });

  test('an approved booking can be cancelled up to its start time', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { status: 'approved', date: TODAY, startTime: '14:01', endTime: '15:00' });
    assert.equal((await cancel(id, student.cookie)).status, 200);
  });

  for (const [name, body] of [['no body at all', undefined], ['an empty body', {}], ['a reason of only spaces', { reason: '   ' }], ['a null reason', { reason: null }]]) {
    test(`the reason is optional: ${name}`, async () => {
      const student = await newStudent();
      const id = await seedBooking(student);
      const response = await cancel(id, student.cookie, body);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal((await row(id)).cancellation_reason, null);
    });
  }

  test('a reason of exactly 500 characters is accepted', async () => {
    const student = await newStudent();
    const id = await seedBooking(student);
    assert.equal((await cancel(id, student.cookie, { reason: 'x'.repeat(500) })).status, 200);
  });

  test('status, owner and other fields in the body are ignored', async () => {
    const student = await newStudent();
    const id = await seedBooking(student);
    const response = await cancel(id, student.cookie, { status: 'approved', cancelledBy: adminId, userId: adminId });
    assert.equal(response.status, 200);
    const stored = await row(id);
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.cancelled_by, student.id);
  });
});

describe('POST /api/bookings/:id/cancel: refused', () => {
  const refusals = [
    ['an approved booking that has started', { status: 'approved', date: TODAY, startTime: '13:00', endTime: '15:00' },
      'This booking has already started, so it can no longer be cancelled.'],
    ['an approved booking starting this very minute', { status: 'approved', date: TODAY, startTime: '14:00', endTime: '15:00' },
      'This booking has already started, so it can no longer be cancelled.'],
    ['a rejected request', { status: 'rejected' }, 'This request was rejected, so there is nothing to cancel.'],
    ['a cancelled booking', { status: 'cancelled' }, 'This booking has already been cancelled.'],
    ['a completed booking', { status: 'completed', date: YESTERDAY }, 'This booking is over, so it can no longer be cancelled.'],
  ];
  for (const [name, fields, message] of refusals) {
    test(`409 for ${name}, and nothing changes`, async () => {
      const student = await newStudent();
      const id = await seedBooking(student, fields);
      const before = await row(id);

      const response = await cancel(id, student.cookie, { reason: 'Trying anyway' });
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'BOOKING_NOT_CANCELLABLE');
      assert.equal(response.body.error.message, message);
      assert.deepEqual(await row(id), before);
    });
  }

  test('another student\'s booking is a 404, exactly like one that does not exist, and is left alone', async () => {
    const owner = await newStudent();
    const intruder = await newStudent();
    const id = await seedBooking(owner);

    const theirs = await cancel(id, intruder.cookie);
    const missing = await cancel(2_000_000_000, intruder.cookie);
    assert.equal(theirs.status, 404);
    assert.deepEqual(theirs.body, missing.body);
    assert.equal(theirs.body.error.code, 'BOOKING_NOT_FOUND');
    assert.equal((await row(id)).status, 'pending');
  });

  for (const [name, id, message] of [
    ['a text id', 'abc', 'Booking id must be a whole number.'],
    ['id 0', '0', 'Booking id must be between 1 and 2147483647.'],
    ['an id larger than PostgreSQL integers', '2147483648', 'Booking id must be between 1 and 2147483647.'],
  ]) {
    test(`400 for ${name}`, async () => {
      const response = await cancel(id, (await newStudent()).cookie);
      assert.equal(response.status, 400);
      assert.deepEqual(response.body.error.details, { id: message });
    });
  }

  for (const [name, reason, message] of [
    ['a reason over 500 characters', 'x'.repeat(501), 'Reason must be at most 500 characters.'],
    ['a reason that is not text', 42, 'Reason must be text.'],
  ]) {
    test(`400 for ${name}, and nothing changes`, async () => {
      const student = await newStudent();
      const id = await seedBooking(student);
      const response = await cancel(id, student.cookie, { reason });
      assert.equal(response.status, 400);
      assert.deepEqual(response.body.error.details, { reason: message });
      assert.equal((await row(id)).status, 'pending');
    });
  }

  test('400 for a body that is not a JSON object', async () => {
    const student = await newStudent();
    const id = await seedBooking(student);
    const response = await cancel(id, student.cookie, ['not', 'an', 'object']);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_BODY');
  });

  test('401 without a session, 403 for an administrator, even for a pending request', async () => {
    const student = await newStudent();
    const id = await seedBooking(student);
    assert.equal((await cancel(id, undefined)).status, 401);
    const response = await cancel(id, admin);
    assert.equal(response.status, 403);
    assert.equal((await row(id)).status, 'pending');
  });
});

describe('POST /api/bookings/:id/cancel: simultaneous requests through the real API', () => {
  const CANCEL = /SET status = 'cancelled'/;

  test('two cancellations of one booking in flight at once: exactly one succeeds', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { status: 'approved', date: freshWeekday() });
    const together = server.holdUntilSimultaneous(CANCEL, 2);
    const responses = await Promise.all([
      cancel(id, student.cookie, { reason: 'First' }),
      cancel(id, student.cookie, { reason: 'Second' }),
    ]);
    await together; // rejects unless both UPDATEs were waiting at the same moment

    const statuses = responses.map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify(responses.map((response) => response.body)));
    const refused = responses.find((response) => response.status === 409);
    assert.equal(refused.body.error.message, 'This booking has already been cancelled.');
    const winner = responses.find((response) => response.status === 200).body.data.booking.cancellation.reason;
    assert.equal((await row(id)).cancellation_reason, winner, 'the stored reason is the one that succeeded');
  });

  test('the owner and another student at once: only the owner\'s cancellation counts', async () => {
    const owner = await newStudent();
    const intruder = await newStudent();
    const id = await seedBooking(owner);
    const together = server.holdUntilSimultaneous(CANCEL, 2);
    const [own, other] = await Promise.all([cancel(id, owner.cookie), cancel(id, intruder.cookie)]);
    await together;

    assert.equal(own.status, 200);
    assert.equal(other.status, 404);
    assert.equal((await row(id)).cancelled_by, owner.id);
  });
});
