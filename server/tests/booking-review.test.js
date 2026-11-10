// Reviewing booking requests through the real app: the queue (GET /api/bookings/requests),
// approving (with the automatic rejection of overlapping requests) and rejecting.
//
// The campus clock is frozen in 2035, so the sample requests are all in the past and out
// of the queue. Each test uses new students and a weekday of its own, and looks at its
// own rows only.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

const NOW = new Date('2035-03-07T05:00:00Z'); // Wednesday 7 March 2035, 14:00 in Korea
const TODAY = '2035-03-07';
const YESTERDAY = '2035-03-06';
const PASSWORD = 'Student@2026';
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_REJECT_NOTE = 'Another request for this time was approved.';

let server;
let admin; // { id, cookie }
let otherAdmin;
const facilityIds = {};

before(async () => {
  server = await startTestServer();
  server.setClock(() => NOW);
  for (const row of (await server.db.query('SELECT id, name FROM facilities')).rows) facilityIds[row.name] = row.id;
  admin = {
    id: (await server.db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id,
    cookie: await server.login('admin@kdu.example', 'Admin@2026'),
  };
  otherAdmin = await newUser('admin');
});

after(async () => {
  await server?.close();
});

const lab = () => facilityIds['Computer Lab A']; // 30 seats
const physics = () => facilityIds['Physics Lab'];

let userCount = 0;
/** A new account, signed in: { id, email, fullName, cookie }. */
async function newUser(role = 'student') {
  userCount += 1;
  const email = `review.${role}.${userCount}@kdu.example`;
  const fullName = `Review ${role === 'admin' ? 'Admin' : 'Student'} ${userCount}`;
  const { rows } = await server.db.query(
    `INSERT INTO users (full_name, email, password_hash, role)
     VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), $4)
     RETURNING id`,
    [fullName, email, PASSWORD, role],
  );
  return { id: rows[0].id, email, fullName, cookie: await server.login(email, PASSWORD) };
}

let cursor = Date.parse('2035-06-01T00:00:00Z');
/** A weekday of its own, well after the frozen today. */
function freshWeekday() {
  do cursor += DAY_MS; while ([0, 6].includes(new Date(cursor).getUTCDay()));
  return new Date(cursor).toISOString().slice(0, 10);
}

/** Puts a booking straight into the test database, with the audit fields its status requires. */
async function seed(owner, { date, startTime, endTime, status = 'pending', facilityId = lab(), purpose = 'Seeded by a test' }) {
  const decided = ['approved', 'rejected', 'completed'].includes(status);
  const cancelled = status === 'cancelled';
  const { rows } = await server.db.query(
    `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status,
                           decided_by, decided_at, cancelled_by, cancelled_at)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 4, $5, $6, $7, $8::timestamptz, $9, $10::timestamptz)
     RETURNING id`,
    [owner.id, facilityId, `${date}T${startTime}:00+09:00`, `${date}T${endTime}:00+09:00`, purpose, status,
      decided ? admin.id : null, decided ? NOW : null, cancelled ? owner.id : null, cancelled ? NOW : null],
  );
  return rows[0].id;
}

async function row(id) {
  const { rows } = await server.db.query(
    'SELECT status, decided_by, decided_at, decision_note, cancelled_by, updated_at FROM bookings WHERE id = $1',
    [id],
  );
  return rows[0];
}

async function statuses(...ids) {
  return Promise.all(ids.map(async (id) => (await row(id)).status));
}

async function queue(cookie = admin.cookie) {
  const response = await server.request('/bookings/requests', { cookie });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data.requests;
}

const approve = (id, body, cookie = admin.cookie) => server.request(`/bookings/${id}/approve`, { method: 'POST', body, cookie });
const reject = (id, body, cookie = admin.cookie) => server.request(`/bookings/${id}/reject`, { method: 'POST', body, cookie });

/** Makes a facility unbookable for the length of `run`. */
async function withFacilityStatus(facilityId, status, run) {
  await server.db.query('UPDATE facilities SET status = $2 WHERE id = $1', [facilityId, status]);
  try {
    await run();
  } finally {
    await server.db.query("UPDATE facilities SET status = 'active' WHERE id = $1", [facilityId]);
  }
}

describe('GET /api/bookings/requests', () => {
  test('lists pending requests that have not started, soonest first, with the student and facility', async () => {
    const student = await newUser();
    const date = freshWeekday();
    const later = await seed(student, { date, startTime: '15:00', endTime: '16:00' });
    const sooner = await seed(student, { date, startTime: '10:00', endTime: '11:00', purpose: 'Algorithms study group' });
    const ids = [
      later, sooner,
      await seed(student, { date: YESTERDAY, startTime: '10:00', endTime: '11:00' }),
      await seed(student, { date: TODAY, startTime: '14:00', endTime: '15:00' }), // starts right now
      await seed(student, { date, startTime: '12:00', endTime: '13:00', status: 'approved', facilityId: physics() }),
      await seed(student, { date, startTime: '17:00', endTime: '18:00', status: 'rejected' }),
      await seed(student, { date, startTime: '18:00', endTime: '19:00', status: 'cancelled' }),
    ];

    const mine = (await queue()).filter((request) => ids.includes(request.id));
    assert.deepEqual(mine.map((request) => request.id), [sooner, later]);

    const { createdAt, ...rest } = mine[0];
    assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(rest, {
      id: sooner,
      date,
      startTime: '10:00',
      endTime: '11:00',
      participantCount: 4,
      purpose: 'Algorithms study group',
      notes: null,
      student: { id: student.id, fullName: student.fullName, email: student.email, studentNumber: null },
      facility: {
        id: lab(), name: 'Computer Lab A', roomNumber: '310', capacity: 30, isBookable: true,
        building: { code: 'ENG', name: 'Engineering Hall' },
      },
      overlappingRequests: [],
      timeTaken: false,
      canApprove: true,
    });
  });

  test('marks clashes: overlapping requests in the same room, and time already approved', async () => {
    const [kim, lee, park] = [await newUser(), await newUser(), await newUser()];
    const date = freshWeekday();
    const a = await seed(kim, { date, startTime: '10:00', endTime: '12:00' });
    const b = await seed(lee, { date, startTime: '11:00', endTime: '13:00' });
    const c = await seed(park, { date, startTime: '12:00', endTime: '13:00' }); // back-to-back with a
    const otherRoom = await seed(park, { date, startTime: '10:00', endTime: '12:00', facilityId: physics() });
    const taken = await seed(kim, { date, startTime: '15:00', endTime: '16:00' });
    await seed(lee, { date, startTime: '15:30', endTime: '16:30', status: 'approved' });

    const byId = Object.fromEntries((await queue()).map((request) => [request.id, request]));
    const brief = (request) => request.overlappingRequests.map((other) => `${other.id} ${other.studentName} ${other.startTime}-${other.endTime}`);
    assert.deepEqual(brief(byId[a]), [`${b} ${lee.fullName} 11:00-13:00`]);
    assert.deepEqual(brief(byId[b]), [`${a} ${kim.fullName} 10:00-12:00`, `${c} ${park.fullName} 12:00-13:00`]);
    assert.deepEqual(brief(byId[c]), [`${b} ${lee.fullName} 11:00-13:00`], 'back-to-back with a is not a clash');
    assert.deepEqual(brief(byId[otherRoom]), [], 'another room is not a clash');
    assert.equal(byId[a].timeTaken, false);
    assert.equal(byId[taken].timeTaken, true);
    assert.equal(byId[taken].canApprove, false);
  });

  test('a request in a facility that stopped taking bookings cannot be approved', async () => {
    const id = await seed(await newUser(), { date: freshWeekday(), startTime: '10:00', endTime: '11:00', facilityId: physics() });
    await withFacilityStatus(physics(), 'maintenance', async () => {
      const request = (await queue()).find((item) => item.id === id);
      assert.equal(request.facility.isBookable, false);
      assert.equal(request.canApprove, false);
    });
  });

  test('401 without a session, 403 for a student', async () => {
    assert.equal((await server.request('/bookings/requests')).status, 401);
    const response = await server.request('/bookings/requests', { cookie: (await newUser()).cookie });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FORBIDDEN');
  });
});

describe('POST /api/bookings/:id/approve', () => {
  test('approves the request, recording who, when and the note', async () => {
    const id = await seed(await newUser(), { date: freshWeekday(), startTime: '10:00', endTime: '11:00' });
    const response = await approve(id, { note: '  Collect the key from the department office.  ' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.autoRejected, []);
    assert.equal(response.body.data.booking.status, 'approved');
    assert.equal(response.body.data.booking.decision.note, 'Collect the key from the department office.');

    const stored = await row(id);
    assert.equal(stored.status, 'approved');
    assert.equal(stored.decided_by, admin.id);
    assert.ok(stored.decided_at instanceof Date);
    assert.equal(stored.decision_note, 'Collect the key from the department office.');
  });

  test('the note is optional', async () => {
    const id = await seed(await newUser(), { date: freshWeekday(), startTime: '10:00', endTime: '11:00' });
    assert.equal((await approve(id)).status, 200);
    assert.equal((await row(id)).decision_note, null);
  });

  test('rejects every other pending request overlapping it in the same room, in the same step', async () => {
    const [kim, lee, park] = [await newUser(), await newUser(), await newUser()];
    const date = freshWeekday();
    const before = await seed(kim, { date, startTime: '10:00', endTime: '12:00' });
    const chosen = await seed(lee, { date, startTime: '11:00', endTime: '13:00' });
    const after = await seed(park, { date, startTime: '12:30', endTime: '14:00' });
    const otherRoomLater = await seed(park, { date, startTime: '13:00', endTime: '14:00', facilityId: physics() });
    const nextToIt = await seed(kim, { date, startTime: '13:00', endTime: '14:00' }); // starts as `chosen` ends
    const otherRoom = await seed(park, { date, startTime: '11:00', endTime: '13:00', facilityId: physics() });
    const cancelled = await seed(kim, { date, startTime: '11:00', endTime: '12:00', status: 'cancelled' });

    const response = await approve(chosen);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.autoRejected, [before, after]);

    assert.deepEqual(await statuses(chosen, before, after), ['approved', 'rejected', 'rejected']);
    for (const id of [before, after]) {
      const stored = await row(id);
      assert.equal(stored.decision_note, AUTO_REJECT_NOTE);
      assert.equal(stored.decided_by, admin.id, 'the automatic rejection is recorded as the approving administrator\'s');
    }
    assert.deepEqual(await statuses(nextToIt, otherRoomLater, otherRoom), ['pending', 'pending', 'pending'], 'no overlap, no change');
    assert.equal((await row(cancelled)).status, 'cancelled', 'a cancelled request stays cancelled');
  });

  test('each student sees the decision on My bookings', async () => {
    const [kim, lee] = [await newUser(), await newUser()];
    const date = freshWeekday();
    const kimsRequest = await seed(kim, { date, startTime: '10:00', endTime: '12:00' });
    const leesRequest = await seed(lee, { date, startTime: '11:00', endTime: '12:00' });
    assert.equal((await approve(kimsRequest, { note: 'Enjoy the session.' })).status, 200);

    const kims = (await server.request('/bookings/mine', { cookie: kim.cookie })).body.data.bookings.find((item) => item.id === kimsRequest);
    const lees = (await server.request('/bookings/mine', { cookie: lee.cookie })).body.data.bookings.find((item) => item.id === leesRequest);
    assert.equal(kims.status, 'approved');
    assert.equal(kims.decision.note, 'Enjoy the session.');
    assert.equal(lees.status, 'rejected');
    assert.equal(lees.decision.note, AUTO_REJECT_NOTE);
  });

  test('409 BOOKING_CONFLICT when an approved booking already takes part of the time; nothing changes', async () => {
    const student = await newUser();
    const date = freshWeekday();
    await seed(student, { date, startTime: '10:00', endTime: '12:00', status: 'approved' });
    const request = await seed(student, { date, startTime: '11:00', endTime: '13:00' });
    const overlapping = await seed(student, { date, startTime: '12:00', endTime: '13:00' });

    const response = await approve(request);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'BOOKING_CONFLICT');
    assert.equal(response.body.error.message, 'Another booking has already been approved for part of this time, so this request cannot be approved.');
    assert.deepEqual(await statuses(request, overlapping), ['pending', 'pending'], 'no automatic rejections either');
  });

  for (const [status, message] of [
    ['approved', 'This request has already been approved.'],
    ['rejected', 'This request has already been rejected.'],
    ['cancelled', 'The student has cancelled this request.'],
    ['completed', 'This booking is already over.'],
  ]) {
    test(`409 BOOKING_NOT_PENDING when the booking is already ${status}; nothing changes`, async () => {
      const id = await seed(await newUser(), { date: freshWeekday(), startTime: '10:00', endTime: '11:00', status });
      const before = await row(id);
      const response = await approve(id);
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'BOOKING_NOT_PENDING');
      assert.equal(response.body.error.message, message);
      assert.deepEqual(await row(id), before);
    });
  }

  for (const [name, startTime] of [['has started', '13:00'], ['starts this very minute', '14:00']]) {
    test(`409 BOOKING_STARTED for a request that ${name}`, async () => {
      const id = await seed(await newUser(), { date: TODAY, startTime, endTime: '15:00' });
      const response = await approve(id);
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'BOOKING_STARTED');
      assert.equal((await row(id)).status, 'pending');
    });
  }

  test('409 FACILITY_NOT_BOOKABLE when the facility is under maintenance', async () => {
    const id = await seed(await newUser(), { date: freshWeekday(), startTime: '10:00', endTime: '11:00', facilityId: physics() });
    await withFacilityStatus(physics(), 'maintenance', async () => {
      const response = await approve(id);
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'FACILITY_NOT_BOOKABLE');
    });
    assert.equal((await row(id)).status, 'pending');
  });

  test('404 for a request that does not exist', async () => {
    const response = await approve(2_000_000_000);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'BOOKING_NOT_FOUND');
  });

  for (const [name, body, details] of [
    ['a note over 500 characters', { note: 'x'.repeat(501) }, { note: 'Note must be at most 500 characters.' }],
    ['a note that is not text', { note: 7 }, { note: 'Note must be text.' }],
  ]) {
    test(`400 for ${name}; nothing changes`, async () => {
      const id = await seed(await newUser(), { date: freshWeekday(), startTime: '10:00', endTime: '11:00' });
      const response = await approve(id, body);
      assert.equal(response.status, 400);
      assert.deepEqual(response.body.error.details, details);
      assert.equal((await row(id)).status, 'pending');
    });
  }

  test('400 for an invalid id', async () => {
    const response = await approve('abc');
    assert.equal(response.status, 400);
    assert.deepEqual(response.body.error.details, { id: 'Booking id must be a whole number.' });
  });

  test('401 without a session, 403 for a student, even their own request; nothing changes', async () => {
    const student = await newUser();
    const id = await seed(student, { date: freshWeekday(), startTime: '10:00', endTime: '11:00' });
    assert.equal((await approve(id, {}, null)).status, 401); // null, not undefined: undefined means "the default, the admin"
    assert.equal((await approve(id, {}, student.cookie)).status, 403);
    assert.equal((await row(id)).status, 'pending');
  });

  test('if any step fails, the whole approval is undone', async (t) => {
    t.mock.method(console, 'error', () => {}); // the expected 500 is logged by the error handler
    const date = freshWeekday();
    const student = await newUser();
    const request = await seed(student, { date, startTime: '10:00', endTime: '12:00' });
    const overlapping = await seed(student, { date, startTime: '11:00', endTime: '12:00' });

    server.failStatement(/UPDATE bookings o\s+SET status = 'rejected'/); // the automatic rejection, after the approval
    const response = await approve(request);
    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'INTERNAL_ERROR');
    assert.deepEqual(await statuses(request, overlapping), ['pending', 'pending'], 'the approval was rolled back');
    assert.equal((await row(request)).decided_by, null);

    assert.equal((await approve(request)).status, 200, 'and it can be approved afterwards');
  });
});

describe('POST /api/bookings/:id/reject', () => {
  test('rejects the request with the reason, recording who and when; other requests are left alone', async () => {
    const student = await newUser();
    const date = freshWeekday();
    const id = await seed(student, { date, startTime: '10:00', endTime: '12:00' });
    const overlapping = await seed(student, { date, startTime: '11:00', endTime: '12:00' });

    const response = await reject(id, { reason: '  Please book the seminar room for groups this size.  ' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.booking.status, 'rejected');

    const stored = await row(id);
    assert.equal(stored.status, 'rejected');
    assert.equal(stored.decided_by, admin.id);
    assert.equal(stored.decision_note, 'Please book the seminar room for groups this size.');
    assert.equal((await row(overlapping)).status, 'pending');
  });

  test('a request whose start time has passed can still be rejected, to clear it', async () => {
    const id = await seed(await newUser(), { date: YESTERDAY, startTime: '10:00', endTime: '11:00' });
    assert.equal((await reject(id, { reason: 'Not reviewed in time.' })).status, 200);
    assert.equal((await row(id)).status, 'rejected');
  });

  for (const [name, body, message] of [
    ['no reason', {}, 'Reason is required.'],
    ['no body at all', undefined, 'Reason is required.'],
    ['a reason of only spaces', { reason: '    ' }, 'Reason is required.'],
    ['a reason under 5 characters', { reason: 'No.' }, 'Reason must be at least 5 characters.'],
    ['a reason over 500 characters', { reason: 'x'.repeat(501) }, 'Reason must be at most 500 characters.'],
  ]) {
    test(`400 for ${name}; nothing changes`, async () => {
      const id = await seed(await newUser(), { date: freshWeekday(), startTime: '10:00', endTime: '11:00' });
      const response = await reject(id, body);
      assert.equal(response.status, 400);
      assert.deepEqual(response.body.error.details, { reason: message });
      assert.equal((await row(id)).status, 'pending');
    });
  }

  for (const [status, message] of [
    ['approved', 'This request has already been approved.'],
    ['rejected', 'This request has already been rejected.'],
    ['cancelled', 'The student has cancelled this request.'],
  ]) {
    test(`409 BOOKING_NOT_PENDING when the booking is already ${status}; nothing changes`, async () => {
      const id = await seed(await newUser(), { date: freshWeekday(), startTime: '10:00', endTime: '11:00', status });
      const before = await row(id);
      const response = await reject(id, { reason: 'Trying anyway.' });
      assert.equal(response.status, 409);
      assert.equal(response.body.error.message, message);
      assert.deepEqual(await row(id), before);
    });
  }

  test('404 for a request that does not exist', async () => {
    assert.equal((await reject(2_000_000_000, { reason: 'Does not matter.' })).status, 404);
  });

  test('401 without a session, 403 for a student; nothing changes', async () => {
    const student = await newUser();
    const id = await seed(student, { date: freshWeekday(), startTime: '10:00', endTime: '11:00' });
    assert.equal((await reject(id, { reason: 'Not allowed here.' }, null)).status, 401);
    assert.equal((await reject(id, { reason: 'Not allowed here.' }, student.cookie)).status, 403);
    assert.equal((await row(id)).status, 'pending');
  });
});

describe('simultaneous decisions through the real API', () => {
  const sortedStatuses = (responses) => responses.map((response) => response.status).sort();

  test('two administrators approving two overlapping requests at once: exactly one is approved', async () => {
    const [kim, lee] = [await newUser(), await newUser()];
    const date = freshWeekday();
    const first = await seed(kim, { date, startTime: '10:00', endTime: '12:00' });
    const second = await seed(lee, { date, startTime: '11:00', endTime: '13:00' });

    const together = server.holdUntilSimultaneous(/^BEGIN$/, 2);
    const responses = await Promise.all([approve(first, {}, admin.cookie), approve(second, {}, otherAdmin.cookie)]);
    await together; // rejects unless both approvals were waiting to start at the same moment

    assert.deepEqual(sortedStatuses(responses), [200, 409], JSON.stringify(responses.map((response) => response.body)));
    assert.equal(responses.find((response) => response.status === 409).body.error.message, 'This request has already been rejected.');
    assert.deepEqual((await statuses(first, second)).sort(), ['approved', 'rejected']);
  });

  test('the same request approved by two administrators at once: one succeeds', async () => {
    const id = await seed(await newUser(), { date: freshWeekday(), startTime: '10:00', endTime: '11:00' });
    const together = server.holdUntilSimultaneous(/^BEGIN$/, 2);
    const responses = await Promise.all([approve(id, { note: 'First' }, admin.cookie), approve(id, { note: 'Second' }, otherAdmin.cookie)]);
    await together;

    assert.deepEqual(sortedStatuses(responses), [200, 409]);
    assert.equal(responses.find((response) => response.status === 409).body.error.message, 'This request has already been approved.');
    const winner = responses.find((response) => response.status === 200).body.data.booking.decision.note;
    assert.equal((await row(id)).decision_note, winner);
  });

  test('an approval and a rejection of the same request at once: exactly one decision is stored', async () => {
    const id = await seed(await newUser(), { date: freshWeekday(), startTime: '10:00', endTime: '11:00' });
    const together = server.holdUntilSimultaneous(/^BEGIN$|UPDATE bookings\s+SET status = 'rejected'/, 2);
    const [approval, rejection] = await Promise.all([
      approve(id, {}, admin.cookie),
      reject(id, { reason: 'Rejected at the same moment.' }, otherAdmin.cookie),
    ]);
    await together;

    assert.deepEqual(sortedStatuses([approval, rejection]), [200, 409]);
    assert.equal((await row(id)).status, approval.status === 200 ? 'approved' : 'rejected');
  });

  test('an approval and the student\'s cancellation at once: the cancellation always stands', async () => {
    // If the approval runs first, the booking is approved and then cancelled (an approved
    // booking can be cancelled until it starts). If the cancellation runs first, the
    // approval finds nothing to approve. Either way the student's decision stands.
    const student = await newUser();
    const id = await seed(student, { date: freshWeekday(), startTime: '10:00', endTime: '11:00' });
    const together = server.holdUntilSimultaneous(/^BEGIN$|SET status = 'cancelled'/, 2);
    const [approval, cancellation] = await Promise.all([
      approve(id, {}, admin.cookie),
      server.request(`/bookings/${id}/cancel`, { method: 'POST', body: {}, cookie: student.cookie }),
    ]);
    await together;

    assert.equal(cancellation.status, 200, JSON.stringify(cancellation.body));
    assert.ok([200, 409].includes(approval.status));
    if (approval.status === 409) assert.equal(approval.body.error.message, 'The student has cancelled this request.');
    const stored = await row(id);
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.cancelled_by, student.id);
  });
});
