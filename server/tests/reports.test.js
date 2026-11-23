// Key figures for administrators, through the real app: GET /api/reports/summary.
// The figures are checked against bookings built by hand in March 2035, where the sample
// data has none. The seeded facilities are made inactive first, so the totals come from
// three facilities made here:
//
//   Report Room A   09:00-21:00 (12 h), open every day, active
//   Report Room B   09:00-18:00 (9 h),  closed at weekends, under maintenance
//   Report Room C   08:00-20:00,        inactive
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

const NOW = new Date('2035-03-07T05:00:00Z'); // Wednesday 7 March 2035, 14:00 in Korea
const WEEK = { from: '2035-03-05', to: '2035-03-11' }; // Monday to Sunday: 7 days, 5 weekdays

let server;
let admin; // session cookie
let adminId;
let studentId;
const rooms = {};

before(async () => {
  server = await startTestServer();
  server.setClock(() => NOW);
  admin = await server.login('admin@kdu.example', 'Admin@2026');
  adminId = (await server.db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;
  studentId = (await server.db.query("SELECT id FROM users WHERE email = 'ali.raza@kdu.example'")).rows[0].id;

  await server.db.query("UPDATE facilities SET status = 'inactive'");
  const { rows } = await server.db.query(
    `INSERT INTO facilities (building_id, room_number, name, facility_type, capacity, floor, status, opens_at, closes_at, is_open_weekends)
     SELECT (SELECT id FROM buildings ORDER BY id LIMIT 1), v.room, v.name, 'meeting_room', 10, 9, v.status, v.opens::time, v.closes::time, v.weekends
     FROM (VALUES
       ('R-A', 'Report Room A', 'active',      '09:00', '21:00', true),
       ('R-B', 'Report Room B', 'maintenance', '09:00', '18:00', false),
       ('R-C', 'Report Room C', 'inactive',    '08:00', '20:00', true)
     ) AS v (room, name, status, opens, closes, weekends)
     RETURNING id, name`,
  );
  for (const row of rows) rooms[row.name.at(-1)] = row.id;

  // In the week:                                              hours  counts as
  await booking('A', '2035-03-05', '10:00', '12:00', 'approved'); //  2    decided, approved
  await booking('A', '2035-03-06', '09:00', '10:30', 'completed'); // 1.5  decided, approved
  await booking('A', '2035-03-06', '13:00', '14:00', 'rejected'); //       decided
  await booking('A', '2035-03-07', '15:00', '16:00', 'pending');
  await booking('A', '2035-03-08', '10:00', '11:00', 'cancelled', { approvedFirst: true }); // decided, approved
  await booking('A', '2035-03-08', '12:00', '13:00', 'cancelled'); // withdrawn before any decision
  await booking('A', '2035-03-11', '20:00', '21:00', 'approved'); //  1    the last hour of the last day
  await booking('B', '2035-03-07', '09:00', '12:00', 'approved'); //  3
  await booking('C', '2035-03-05', '08:00', '10:00', 'completed'); // 2    in an inactive facility
  // Just outside the week, on both sides.
  await booking('A', '2035-03-04', '20:00', '21:00', 'approved');
  await booking('A', '2035-03-12', '09:00', '10:00', 'approved');
});

after(async () => {
  await server?.close();
});

async function booking(room, date, startTime, endTime, status, { approvedFirst = false } = {}) {
  const decided = ['approved', 'rejected', 'completed'].includes(status) || approvedFirst;
  const cancelled = status === 'cancelled';
  await server.db.query(
    `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status,
                           decided_by, decided_at, cancelled_by, cancelled_at)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 4, 'Seeded by a test', $5, $6, $7::timestamptz, $8, $9::timestamptz)`,
    [studentId, rooms[room], `${date}T${startTime}:00+09:00`, `${date}T${endTime}:00+09:00`, status,
      decided ? adminId : null, decided ? NOW : null, cancelled ? studentId : null, cancelled ? NOW : null],
  );
}

function summary(params = {}, cookie = admin) {
  const query = new URLSearchParams(params).toString();
  return server.request(`/reports/summary${query ? `?${query}` : ''}`, { cookie });
}
const room = (data, letter) => data.facilities.find((facility) => facility.id === rooms[letter]);

describe('GET /api/reports/summary', () => {
  test('counts the requests of the range by status, both end dates included', async () => {
    const response = await summary(WEEK);
    assert.equal(response.status, 200);
    const { range, totals, byStatus } = response.body.data;
    assert.deepEqual(range, { from: '2035-03-05', to: '2035-03-11', days: 7, weekdays: 5 });
    assert.deepEqual(byStatus, { pending: 1, approved: 3, rejected: 1, cancelled: 2, completed: 2 });
    assert.equal(totals.requests, 9);
  });

  test('approval rate: approved, completed and cancelled-after-approval, out of the decided requests', async () => {
    const { totals } = (await summary(WEEK)).body.data;
    // Decided: 3 approved + 2 completed + 1 cancelled after approval + 1 rejected = 7.
    // The pending request and the one withdrawn before a decision are left out.
    assert.deepEqual({ decided: totals.decided, approved: totals.approved, rate: totals.approvalRatePercent },
      { decided: 7, approved: 6, rate: 85.7 });
  });

  test('hours booked and utilization: approved and completed bookings against the open hours', async () => {
    const { totals } = (await summary(WEEK)).body.data;
    // Booked: A 2 + 1.5 + 1, B 3, C 2 = 9.5 hours. Open: A 12 h x 7 days = 84, B 9 h x 5
    // weekdays = 45; C is inactive and left out, with its 2 booked hours: 7.5 / 129 = 5.8 %.
    assert.deepEqual({ booked: totals.bookedHours, open: totals.openHours, utilization: totals.utilizationPercent },
      { booked: 9.5, open: 129, utilization: 5.8 });
  });

  test('lists every facility, busiest first, with its own figures', async () => {
    const { data } = (await summary(WEEK)).body;
    assert.deepEqual(data.facilities.slice(0, 3).map((facility) => facility.name), ['Report Room A', 'Report Room B', 'Report Room C']);
    const { rows: [{ n }] } = await server.db.query('SELECT count(*)::int AS n FROM facilities');
    assert.equal(data.facilities.length, n);

    const a = room(data, 'A');
    assert.deepEqual(Object.keys(a).sort(),
      ['bookedHours', 'bookings', 'building', 'id', 'name', 'openHours', 'roomNumber', 'status', 'type', 'utilizationPercent']);
    assert.deepEqual({ bookings: a.bookings, booked: a.bookedHours, open: a.openHours, utilization: a.utilizationPercent, status: a.status },
      { bookings: 3, booked: 4.5, open: 84, utilization: 5.4, status: 'active' });

    // Under maintenance: still counted, and closed at weekends.
    const b = room(data, 'B');
    assert.deepEqual({ bookings: b.bookings, booked: b.bookedHours, open: b.openHours, utilization: b.utilizationPercent, status: b.status },
      { bookings: 1, booked: 3, open: 45, utilization: 6.7, status: 'maintenance' });

    // Inactive: its bookings are shown, but it has no open hours and no utilization.
    const c = room(data, 'C');
    assert.deepEqual({ bookings: c.bookings, booked: c.bookedHours, open: c.openHours, utilization: c.utilizationPercent },
      { bookings: 1, booked: 2, open: null, utilization: null });

    // The seeded facilities, with nothing booked in 2035, follow by name.
    const rest = data.facilities.slice(3);
    assert.ok(rest.every((facility) => facility.bookings === 0 && facility.bookedHours === 0));
    assert.deepEqual(rest.map((facility) => facility.name), rest.map((facility) => facility.name).toSorted());
  });

  test('a weekend: a facility closed at weekends has no open hours, so no utilization', async () => {
    const { data } = (await summary({ from: '2035-03-10', to: '2035-03-11' })).body;
    assert.deepEqual(data.range, { from: '2035-03-10', to: '2035-03-11', days: 2, weekdays: 0 });
    assert.deepEqual({ open: room(data, 'B').openHours, utilization: room(data, 'B').utilizationPercent }, { open: 0, utilization: null });
    // Only Room A was open: 24 hours, 1 of them booked.
    assert.deepEqual({ open: data.totals.openHours, booked: data.totals.bookedHours, utilization: data.totals.utilizationPercent },
      { open: 24, booked: 1, utilization: 4.2 });
  });

  test('a single day is a valid range', async () => {
    const { data } = (await summary({ from: '2035-03-06', to: '2035-03-06' })).body;
    assert.equal(data.range.days, 1);
    assert.deepEqual(data.byStatus, { pending: 0, approved: 0, rejected: 1, cancelled: 0, completed: 1 });
    assert.equal(data.totals.approvalRatePercent, 50);
  });

  test('a range with no bookings: zeros, and no approval rate rather than 0 %', async () => {
    const { data } = (await summary({ from: '2036-06-02', to: '2036-06-08' })).body;
    assert.deepEqual(data.byStatus, { pending: 0, approved: 0, rejected: 0, cancelled: 0, completed: 0 });
    assert.deepEqual(data.totals,
      { requests: 0, decided: 0, approved: 0, approvalRatePercent: null, bookedHours: 0, openHours: 129, utilizationPercent: 0 });
  });

  test('without dates the range is the last 30 days, ending today in Korea', async () => {
    assert.deepEqual((await summary()).body.data.range, { from: '2035-02-06', to: '2035-03-07', days: 30, weekdays: 22 });
    // Only one end given: the other is today, or 29 days before "to".
    assert.deepEqual((await summary({ from: '2035-03-01' })).body.data.range, { from: '2035-03-01', to: '2035-03-07', days: 7, weekdays: 5 });
    const onlyTo = (await summary({ to: '2035-01-30' })).body.data.range;
    assert.deepEqual({ from: onlyTo.from, to: onlyTo.to, days: onlyTo.days }, { from: '2035-01-01', to: '2035-01-30', days: 30 });
  });

  test('400 listing every date that is not a real one', async () => {
    const response = await summary({ from: 'last week', to: '2035-02-30' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(Object.keys(response.body.error.details).sort(), ['from', 'to']);
  });

  test('400 when "to" is before "from", or the range is longer than a year', async () => {
    const reversed = await summary({ from: '2035-03-11', to: '2035-03-05' });
    assert.equal(reversed.status, 400);
    assert.deepEqual(reversed.body.error.details, { to: 'Must be on or after the "From" date.' });

    // 1 January 2035 to 1 January 2036 is 366 days: the longest range accepted.
    assert.equal((await summary({ from: '2035-01-01', to: '2036-01-01' })).status, 200);
    const tooLong = await summary({ from: '2035-01-01', to: '2036-01-02' });
    assert.equal(tooLong.status, 400);
    assert.deepEqual(tooLong.body.error.details, { to: 'The range can be at most one year.' });
    // A "from" long ago without a "to" runs to today, which is too long as well.
    assert.equal((await summary({ from: '2030-01-01' })).status, 400);
  });

  test('401 without a session, 403 for a student', async () => {
    const student = await server.login('ali.raza@kdu.example', 'Student@2026');
    assert.equal((await summary(WEEK, null)).status, 401);
    assert.equal((await summary(WEEK, student)).status, 403);
  });

  // Last: it changes the facilities.
  test('the documented simplification: open hours follow the hours and status a facility has now', async () => {
    await server.db.query("UPDATE facilities SET closes_at = '15:00' WHERE id = $1", [rooms.A]); // 6 hours a day
    await server.db.query("UPDATE facilities SET status = 'inactive' WHERE id = $1", [rooms.B]);
    const { data } = (await summary(WEEK)).body;
    assert.deepEqual({ open: room(data, 'A').openHours, utilization: room(data, 'A').utilizationPercent }, { open: 42, utilization: 10.7 });
    assert.equal(room(data, 'B').openHours, null);
    // Only Room A is counted now: 4.5 of 42 hours. Hours booked still include every facility.
    assert.deepEqual({ booked: data.totals.bookedHours, open: data.totals.openHours, utilization: data.totals.utilizationPercent },
      { booked: 9.5, open: 42, utilization: 10.7 });
  });
});
