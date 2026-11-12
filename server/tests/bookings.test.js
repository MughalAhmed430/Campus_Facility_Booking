// POST /api/bookings through the real app. The facility schedule is in schedule.test.js.
//
// The campus clock is frozen in 2035, so the sample bookings (dated relative to the real
// today) can never get in the way, and "today" and "already passed" are exact.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

const NOW = new Date('2035-03-07T05:00:00Z'); // Wednesday 7 March 2035, 14:00 in Korea
const TODAY = '2035-03-07';
const YESTERDAY = '2035-03-06';
const THURSDAY = '2035-03-08';
const SATURDAY = '2035-03-10';
const SUNDAY = '2035-03-11';
const CONFLICT = 'This time is already booked. Choose a different time.';
const LAB_HOURS = 'Must be inside the opening hours, 09:00–21:00.';
const DAY_MS = 24 * 60 * 60 * 1000;

let server;
let minjun; // session cookies
let seoyeon;
let admin;
const userIds = {};
const facilityIds = {};

before(async () => {
  server = await startTestServer();
  server.setClock(() => NOW);
  [minjun, seoyeon, admin] = await Promise.all([
    server.login('minjun.kim@kdu.example', 'Student@2026'),
    server.login('seoyeon.lee@kdu.example', 'Student@2026'),
    server.login('admin@kdu.example', 'Admin@2026'),
  ]);
  for (const row of (await server.db.query('SELECT id, email FROM users')).rows) userIds[row.email] = row.id;
  for (const row of (await server.db.query('SELECT id, name FROM facilities')).rows) facilityIds[row.name] = row.id;
});

after(async () => {
  await server?.close();
});

const lab = () => facilityIds['Computer Lab A']; // 09:00-21:00, 30 seats, closed at weekends

/** A valid request (Computer Lab A, Thursday 10:00-11:00), changed by `overrides`. */
function validRequest(overrides = {}) {
  return {
    facilityId: lab(), date: THURSDAY, startTime: '10:00', endTime: '11:00',
    purpose: 'Algorithms study group', participantCount: 5, ...overrides,
  };
}

const post = (body, cookie = minjun) => server.request('/bookings', { method: 'POST', body, cookie });

// Conflict tests each get a weekday of their own.
let cursor = Date.parse('2035-04-02T00:00:00Z');
function freshWeekday() {
  do cursor += DAY_MS; while ([0, 6].includes(new Date(cursor).getUTCDay()));
  return new Date(cursor).toISOString().slice(0, 10);
}

/** Puts a booking straight into the test database, with the audit fields its status requires. */
function seedBooking({ date, startTime, endTime, status = 'approved', facilityId = lab() }) {
  const decided = ['approved', 'rejected', 'completed'].includes(status);
  const cancelled = status === 'cancelled';
  const adminId = userIds['admin@kdu.example'];
  return server.db.query(
    `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status,
                           decided_by, decided_at, cancelled_by, cancelled_at)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 2, 'Seeded by a test', $5, $6, $7::timestamptz, $8, $9::timestamptz)`,
    [userIds['jiho.park@kdu.example'], facilityId, `${date}T${startTime}:00+09:00`, `${date}T${endTime}:00+09:00`, status,
      decided ? adminId : null, decided ? NOW : null, cancelled ? adminId : null, cancelled ? NOW : null],
  );
}

/** Rows on one date for the lab, oldest first: { status, user_id }. */
async function rowsOn(date, facilityId = lab()) {
  const { rows } = await server.db.query(
    `SELECT status, user_id, purpose, notes, attendees,
            to_char(start_time AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS starts,
            to_char(end_time AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS ends,
            decided_by, decided_at
     FROM bookings
     WHERE facility_id = $1 AND (start_time AT TIME ZONE 'Asia/Seoul')::date = $2::date
     ORDER BY id`,
    [facilityId, date],
  );
  return rows;
}

describe('POST /api/bookings: a valid request', () => {
  test('is created as pending, for the signed-in student, at the right moment in Korea time', async () => {
    const date = freshWeekday();
    const response = await post(validRequest({ date, notes: 'We will bring our own laptops.' }));
    assert.equal(response.status, 201);
    const { booking } = response.body.data;
    assert.equal(booking.status, 'pending');
    assert.equal(booking.startTime, '10:00');
    assert.equal(booking.participantCount, 5);

    const rows = await rowsOn(date);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].user_id, userIds['minjun.kim@kdu.example']);
    assert.equal(rows[0].starts, `${date} 10:00`);
    assert.equal(rows[0].ends, `${date} 11:00`);
    assert.equal(rows[0].attendees, 5);
    assert.equal(rows[0].notes, 'We will bring our own laptops.');
  });

  test('status, owner and decision fields in the body are ignored', async () => {
    const date = freshWeekday();
    const response = await post(validRequest({
      date, status: 'approved', userId: userIds['jiho.park@kdu.example'], user_id: userIds['jiho.park@kdu.example'],
      decidedBy: userIds['admin@kdu.example'],
    }));
    assert.equal(response.status, 201);
    assert.equal(response.body.data.booking.status, 'pending');
    const [row] = await rowsOn(date);
    assert.equal(row.status, 'pending');
    assert.equal(row.user_id, userIds['minjun.kim@kdu.example']);
    assert.equal(row.decided_by, null);
    assert.equal(row.decided_at, null);
  });

  test('notes are optional and stored as empty', async () => {
    const date = freshWeekday();
    assert.equal((await post(validRequest({ date }))).status, 201);
    assert.equal((await rowsOn(date))[0].notes, null);
  });

  const accepted = [
    ['exactly the shortest length, 30 minutes', { startTime: '10:00', endTime: '10:30' }],
    ['exactly the longest length, 4 hours', { startTime: '10:00', endTime: '14:00' }],
    ['starting the moment the facility opens', { startTime: '09:00', endTime: '10:00' }],
    ['ending the moment the facility closes', { startTime: '20:00', endTime: '21:00' }],
    ['filling the room exactly', { participantCount: 30 }],
    ['later today', { date: TODAY, startTime: '15:00', endTime: '16:00' }],
    ['today, starting right now', { date: TODAY, startTime: '14:00', endTime: '15:00' }],
    ['a Saturday, in a facility open at weekends', () => ({ facilityId: facilityIds['Group Study Room A'], date: SATURDAY })],
    ['a Sunday, in a facility open at weekends', () => ({ facilityId: facilityIds['Group Study Room A'], date: SUNDAY, participantCount: 6 })],
  ];
  for (const [name, overrides] of accepted) {
    test(`accepted: ${name}`, async () => {
      const response = await post(validRequest(typeof overrides === 'function' ? overrides() : overrides));
      assert.equal(response.status, 201, JSON.stringify(response.body));
    });
  }
});

describe('POST /api/bookings: refused with one 400', () => {
  const rejected = [
    ['a facility that does not exist', () => ({ facilityId: 999999 }), { facilityId: 'This facility does not exist.' }],
    ['an inactive facility', () => ({ facilityId: facilityIds['Conference Room 401'] }), { facilityId: 'This facility is not taking booking requests at the moment.' }],
    ['a facility under maintenance', () => ({ facilityId: facilityIds['Lecture Room 110'] }), { facilityId: 'This facility is not taking booking requests at the moment.' }],
    ['a facility id that is not a number', () => ({ facilityId: 'lab' }), { facilityId: 'Facility must be a whole number.' }],
    ['starting before opening time', () => ({ startTime: '08:30', endTime: '09:30' }), { startTime: LAB_HOURS }],
    ['ending after closing time', () => ({ startTime: '20:30', endTime: '21:30' }), { endTime: LAB_HOURS }],
    ['entirely after closing time', () => ({ startTime: '22:00', endTime: '23:00' }), { startTime: LAB_HOURS, endTime: LAB_HOURS }],
    ['a Saturday in a weekday-only facility', () => ({ date: SATURDAY }), { date: 'This facility is closed on Saturdays and Sundays.' }],
    ['a Sunday in a weekday-only facility', () => ({ date: SUNDAY }), { date: 'This facility is closed on Saturdays and Sundays.' }],
    ['more people than the facility holds', () => ({ participantCount: 31 }), { participantCount: 'This facility holds at most 30 people.' }],
    ['no participants', () => ({ participantCount: 0 }), { participantCount: 'Number of participants must be between 1 and 1000.' }],
    ['a fractional participant count', () => ({ participantCount: 2.5 }), { participantCount: 'Number of participants must be a whole number.' }],
    ['an end time equal to the start time', () => ({ endTime: '10:00' }), { endTime: 'End time must be after the start time.' }],
    ['an end time before the start time', () => ({ startTime: '12:00', endTime: '11:00' }), { endTime: 'End time must be after the start time.' }],
    ['shorter than 30 minutes', () => ({ endTime: '10:29' }), { endTime: 'A booking must last at least 30 minutes.' }],
    ['longer than 4 hours', () => ({ endTime: '14:01' }), { endTime: 'A booking can last at most 4 hours.' }],
    ['a past date', () => ({ date: YESTERDAY }), { date: 'Choose today or a later date.' }],
    ['today, at a time that has passed', () => ({ date: TODAY, startTime: '13:59', endTime: '15:00' }), { startTime: 'This start time has already passed. Choose a later time.' }],
    ['a date that does not exist', () => ({ date: '2035-02-30' }), { date: 'Date must be a real date, written YYYY-MM-DD.' }],
    ['a date in another format', () => ({ date: '08/03/2035' }), { date: 'Date must be a real date, written YYYY-MM-DD.' }],
    ['an impossible time', () => ({ startTime: '25:00' }), { startTime: 'Start time must be a valid time, written HH:MM.' }],
    ['a time without a leading zero', () => ({ endTime: '9:30' }), { endTime: 'End time must be a valid time, written HH:MM.' }],
    ['a purpose that is too short', () => ({ purpose: 'abcd' }), { purpose: 'Purpose must be at least 5 characters.' }],
    ['a purpose that is too long', () => ({ purpose: 'x'.repeat(501) }), { purpose: 'Purpose must be at most 500 characters.' }],
    ['notes that are too long', () => ({ notes: 'x'.repeat(501) }), { notes: 'Notes must be at most 500 characters.' }],
  ];
  for (const [name, overrides, details] of rejected) {
    test(name, async () => {
      const response = await post(validRequest(overrides()));
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      assert.deepEqual(response.body.error.details, details);
    });
  }

  test('every missing required field is listed at once', async () => {
    const response = await post({});
    assert.equal(response.status, 400);
    assert.deepEqual(response.body.error.details, {
      facilityId: 'Facility is required.',
      date: 'Date is required.',
      startTime: 'Start time is required.',
      endTime: 'End time is required.',
      participantCount: 'Number of participants is required.',
      purpose: 'Purpose is required.',
    });
  });

  test('format problems and facility rules arrive together in the same response', async () => {
    const response = await post(validRequest({ date: SATURDAY, startTime: '08:00', endTime: '07:00', participantCount: 31, purpose: '' }));
    assert.equal(response.status, 400);
    assert.deepEqual(response.body.error.details, {
      date: 'This facility is closed on Saturdays and Sundays.',
      startTime: LAB_HOURS,
      endTime: 'End time must be after the start time.',
      participantCount: 'This facility holds at most 30 people.',
      purpose: 'Purpose is required.',
    });
  });

  test('nothing is stored when a request is refused', async () => {
    const date = freshWeekday();
    await post(validRequest({ date, participantCount: 31 }));
    assert.deepEqual(await rowsOn(date), []);
  });
});

describe('POST /api/bookings: who may request', () => {
  test('401 without a session', async () => {
    const response = await server.request('/bookings', { method: 'POST', body: validRequest() });
    assert.equal(response.status, 401);
  });

  test('403 for an administrator, and nothing is stored', async () => {
    const date = freshWeekday();
    const response = await post(validRequest({ date }), admin);
    assert.equal(response.status, 403);
    assert.deepEqual(await rowsOn(date), []);
  });
});

describe('POST /api/bookings: conflicts', () => {
  for (const status of ['approved', 'completed']) {
    test(`an overlapping ${status} booking refuses the request with 409 and the clear message`, async () => {
      const date = freshWeekday();
      await seedBooking({ date, startTime: '10:00', endTime: '12:00', status });
      const response = await post(validRequest({ date, startTime: '11:00', endTime: '13:00' }));
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'BOOKING_CONFLICT');
      assert.equal(response.body.error.message, CONFLICT);
      assert.equal(response.body.error.details, undefined, 'not a field error');
      assert.equal((await rowsOn(date)).length, 1, 'no request was added');
    });
  }

  for (const status of ['pending', 'rejected', 'cancelled']) {
    test(`an overlapping ${status} booking does not hold the slot`, async () => {
      const date = freshWeekday();
      await seedBooking({ date, startTime: '10:00', endTime: '12:00', status });
      assert.equal((await post(validRequest({ date, startTime: '11:00', endTime: '13:00' }))).status, 201);
    });
  }

  test('back-to-back with an approved booking is allowed, on either side', async () => {
    const date = freshWeekday();
    await seedBooking({ date, startTime: '10:00', endTime: '12:00' });
    assert.equal((await post(validRequest({ date, startTime: '09:00', endTime: '10:00' }))).status, 201);
    assert.equal((await post(validRequest({ date, startTime: '12:00', endTime: '13:00' }))).status, 201);
  });

  test('an approved booking in another facility does not get in the way', async () => {
    const date = freshWeekday();
    await seedBooking({ date, startTime: '10:00', endTime: '12:00', facilityId: facilityIds['Physics Lab'] });
    assert.equal((await post(validRequest({ date, startTime: '10:00', endTime: '12:00' }))).status, 201);
  });

  test('the database guard: a pending row never trips it, a second approved booking always does', async () => {
    const date = freshWeekday();
    await seedBooking({ date, startTime: '10:00', endTime: '12:00' });
    await seedBooking({ date, startTime: '11:00', endTime: '13:00', status: 'pending' }); // does not throw
    await assert.rejects(
      seedBooking({ date, startTime: '11:00', endTime: '13:00', status: 'approved' }),
      (error) => error.code === '23P01' && error.constraint === 'bookings_no_overlap',
    );
  });
});

describe('POST /api/bookings: simultaneous requests through the real API', () => {
  const INSERT = /INSERT INTO bookings/;

  test('two overlapping pending requests in flight at once both succeed', async () => {
    const date = freshWeekday();
    const together = server.holdUntilSimultaneous(INSERT, 2);
    const [first, second] = await Promise.all([
      post(validRequest({ date, startTime: '10:00', endTime: '12:00' }), minjun),
      post(validRequest({ date, startTime: '11:00', endTime: '13:00' }), seoyeon),
    ]);
    await together; // rejects unless both INSERTs were waiting at the same moment

    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.deepEqual((await rowsOn(date)).map((row) => row.status), ['pending', 'pending']);
  });

  test('two requests in flight at once that overlap an approved booking are both refused', async () => {
    const date = freshWeekday();
    await seedBooking({ date, startTime: '10:00', endTime: '12:00' });
    const together = server.holdUntilSimultaneous(INSERT, 2);
    const [first, second] = await Promise.all([
      post(validRequest({ date, startTime: '09:00', endTime: '11:00' }), minjun),
      post(validRequest({ date, startTime: '11:00', endTime: '13:00' }), seoyeon),
    ]);
    await together;

    for (const response of [first, second]) {
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.error.message, CONFLICT);
    }
    assert.deepEqual((await rowsOn(date)).map((row) => row.status), ['approved'], 'neither request was added');
  });
});
