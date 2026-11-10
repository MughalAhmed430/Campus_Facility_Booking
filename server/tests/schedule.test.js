// The booking schedule through the real app: a facility's week (GET /api/facilities/:id/schedule),
// the administrators' day (GET /api/bookings/schedule) and the "free at" facility filter.
//
// The campus clock is frozen in 2035, so the sample bookings (dated relative to the real
// today) never fall in the weeks these tests use.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

const NOW = new Date('2035-03-07T05:00:00Z'); // Wednesday 7 March 2035, 14:00 in Korea
const TODAY = '2035-03-07';
const DAY_MS = 24 * 60 * 60 * 1000;

let server;
let minjun; // session cookies
let jiho;
let admin;
const userIds = {};
const facilityIds = {};

before(async () => {
  server = await startTestServer();
  server.setClock(() => NOW);
  [minjun, jiho, admin] = await Promise.all([
    server.login('minjun.kim@kdu.example', 'Student@2026'),
    server.login('jiho.park@kdu.example', 'Student@2026'),
    server.login('admin@kdu.example', 'Admin@2026'),
  ]);
  for (const row of (await server.db.query('SELECT id, email FROM users')).rows) userIds[row.email] = row.id;
  for (const row of (await server.db.query('SELECT id, name FROM facilities')).rows) facilityIds[row.name] = row.id;
});

after(async () => {
  await server?.close();
});

const LAB = 'Computer Lab A'; // 09:00-21:00, closed at weekends
const STUDY_ROOM = 'Group Study Room A'; // 09:00-22:00, open every day

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// Each test that adds bookings gets a week of its own, Monday to Sunday, and the week
// after it stays free for bookings that must fall just outside it.
let nextMonday = '2035-04-02';
function freshWeek() {
  const monday = nextMonday;
  nextMonday = addDays(nextMonday, 14);
  return monday;
}

/** Puts a booking straight into the test database, with the audit fields its status requires. */
async function seedBooking({ date, startTime, endTime, status = 'approved', facility = LAB, student = 'jiho.park', purpose = 'Seeded by a test' }) {
  const decided = ['approved', 'rejected', 'completed'].includes(status);
  const cancelled = status === 'cancelled';
  const adminId = userIds['admin@kdu.example'];
  const { rows: [row] } = await server.db.query(
    `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status,
                           decided_by, decided_at, cancelled_by, cancelled_at)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 3, $5, $6, $7, $8::timestamptz, $9, $10::timestamptz)
     RETURNING id`,
    [userIds[`${student}@kdu.example`], facilityIds[facility], `${date}T${startTime}:00+09:00`, `${date}T${endTime}:00+09:00`,
      purpose, status, decided ? adminId : null, decided ? NOW : null, cancelled ? adminId : null, cancelled ? NOW : null],
  );
  return row.id;
}

async function get(pathname, { cookie = minjun, status = 200 } = {}) {
  const response = await server.request(pathname, { cookie });
  assert.equal(response.status, status, `GET ${pathname}: ${JSON.stringify(response.body)}`);
  return response.body;
}

describe('GET /api/facilities/:id/schedule', () => {
  const week = async (facility, from, { cookie, days } = {}) =>
    (await get(`/facilities/${facilityIds[facility]}/schedule?from=${from}${days ? `&days=${days}` : ''}`, { cookie })).data;

  test('lists each day with its bookings: others\' as times only, the student\'s own marked, their own requests too', async () => {
    const monday = freshWeek();
    const tuesday = addDays(monday, 1);
    await seedBooking({ date: monday, startTime: '13:00', endTime: '14:00' }); // jiho, approved
    await seedBooking({ date: monday, startTime: '10:00', endTime: '11:30', status: 'completed' });
    await seedBooking({ date: monday, startTime: '15:00', endTime: '16:00', student: 'minjun.kim' });
    await seedBooking({ date: tuesday, startTime: '09:00', endTime: '10:00', status: 'pending', student: 'minjun.kim' });
    // Left out: someone else's request, rejected and cancelled bookings, another facility, the next week.
    await seedBooking({ date: tuesday, startTime: '11:00', endTime: '12:00', status: 'pending' });
    await seedBooking({ date: tuesday, startTime: '13:00', endTime: '14:00', status: 'rejected', student: 'minjun.kim' });
    await seedBooking({ date: tuesday, startTime: '15:00', endTime: '16:00', status: 'cancelled', student: 'minjun.kim' });
    await seedBooking({ date: monday, startTime: '10:00', endTime: '11:00', facility: 'Physics Lab' });
    await seedBooking({ date: addDays(monday, 7), startTime: '10:00', endTime: '11:00' });

    const schedule = await week(LAB, monday);
    assert.deepEqual(schedule.days.slice(0, 3), [
      {
        date: monday,
        isOpen: true,
        bookings: [
          { startTime: '10:00', endTime: '11:30', kind: 'booked' },
          { startTime: '13:00', endTime: '14:00', kind: 'booked' },
          { startTime: '15:00', endTime: '16:00', kind: 'yours' },
        ],
      },
      { date: tuesday, isOpen: true, bookings: [{ startTime: '09:00', endTime: '10:00', kind: 'your-request' }] },
      { date: addDays(monday, 2), isOpen: true, bookings: [] },
    ]);
    assert.ok(schedule.days.slice(3).every((day) => day.bookings.length === 0));
  });

  test('says nothing about who booked: no names, ids or purposes', async () => {
    const monday = freshWeek();
    await seedBooking({ date: monday, startTime: '10:00', endTime: '11:00', purpose: 'Secret society meeting' });
    const schedule = await week(LAB, monday);
    assert.deepEqual(Object.keys(schedule.days[0].bookings[0]).sort(), ['endTime', 'kind', 'startTime']);
    const text = JSON.stringify(schedule);
    for (const hidden of ['Secret society', 'jiho', 'Park', 'student']) {
      assert.ok(!text.includes(hidden), `the schedule mentions ${hidden}`);
    }
  });

  test('another student sees the first student\'s booking as booked and their request not at all', async () => {
    const monday = freshWeek();
    await seedBooking({ date: monday, startTime: '10:00', endTime: '11:00', student: 'minjun.kim' });
    await seedBooking({ date: monday, startTime: '12:00', endTime: '13:00', status: 'pending', student: 'minjun.kim' });
    const [day] = (await week(LAB, monday, { cookie: jiho })).days;
    assert.deepEqual(day.bookings, [{ startTime: '10:00', endTime: '11:00', kind: 'booked' }]);
  });

  test('an administrator sees bookings as booked, and no requests', async () => {
    const monday = freshWeek();
    await seedBooking({ date: monday, startTime: '10:00', endTime: '11:00', student: 'minjun.kim' });
    await seedBooking({ date: monday, startTime: '12:00', endTime: '13:00', status: 'pending' });
    const [day] = (await week(LAB, monday, { cookie: admin })).days;
    assert.deepEqual(day.bookings, [{ startTime: '10:00', endTime: '11:00', kind: 'booked' }]);
  });

  test('a lab closed at weekends is closed on Saturday and Sunday; a study room is open every day', async () => {
    const monday = freshWeek();
    assert.deepEqual((await week(LAB, monday)).days.map((day) => day.isOpen), [true, true, true, true, true, false, false]);
    assert.deepEqual((await week(STUDY_ROOM, monday)).days.map((day) => day.isOpen), [true, true, true, true, true, true, true]);
  });

  test('the week may start on any day; days says how many days to return', async () => {
    const schedule = await week(LAB, '2035-04-06', { days: 3 }); // a Friday
    assert.deepEqual(schedule.days.map((day) => [day.date, day.isOpen]), [['2035-04-06', true], ['2035-04-07', false], ['2035-04-08', false]]);
    assert.equal((await week(LAB, TODAY, { days: 1 })).days.length, 1);
    assert.equal((await week(LAB, TODAY)).days.length, 7, 'a week when days is left out');
  });

  test('days run from midnight to midnight, Korea time', async () => {
    const monday = freshWeek();
    await seedBooking({ date: addDays(monday, -1), startTime: '23:00', endTime: '23:30', facility: STUDY_ROOM }); // Sunday before
    await seedBooking({ date: monday, startTime: '00:00', endTime: '00:30', facility: STUDY_ROOM });
    await seedBooking({ date: addDays(monday, 6), startTime: '23:30', endTime: '23:59', facility: STUDY_ROOM });
    await seedBooking({ date: addDays(monday, 7), startTime: '00:00', endTime: '00:30', facility: STUDY_ROOM }); // Monday after
    const { days } = await week(STUDY_ROOM, monday);
    assert.deepEqual(days.map((day) => day.bookings.map((booking) => booking.startTime)),
      [['00:00'], [], [], [], [], [], ['23:30']]);
  });

  test('includes the opening hours and whether the facility takes requests', async () => {
    const lab = await week(LAB, TODAY, { days: 1 });
    assert.deepEqual([lab.facilityId, lab.from, lab.isBookable], [facilityIds[LAB], TODAY, true]);
    assert.deepEqual(lab.openingHours, { opensAt: '09:00', closesAt: '21:00', openWeekends: false });
    assert.equal((await week('Lecture Room 110', TODAY, { days: 1 })).isBookable, false, 'under maintenance');
    assert.equal((await week('Conference Room 401', TODAY, { days: 1 })).isBookable, false, 'retired');
  });

  test('a week can end on 31 December 9999', async () => {
    const schedule = await week(LAB, '9999-12-25');
    assert.equal(schedule.days.at(-1).date, '9999-12-31');
  });

  for (const [name, query, details] of [
    ['a missing start date', '', { from: 'Start date is required.' }],
    ['an impossible date', '?from=2035-02-30', { from: 'Start date must be a real date, written YYYY-MM-DD.' }],
    ['0 days', `?from=${TODAY}&days=0`, { days: 'Days must be between 1 and 7.' }],
    ['8 days', `?from=${TODAY}&days=8`, { days: 'Days must be between 1 and 7.' }],
    ['days that is not a number', `?from=${TODAY}&days=week`, { days: 'Days must be a whole number.' }],
    ['a week past the year 9999', '?from=9999-12-26', { from: 'The schedule cannot go past 31 December 9999.' }],
  ]) {
    test(`400 for ${name}`, async () => {
      const body = await get(`/facilities/${facilityIds[LAB]}/schedule${query}`, { status: 400 });
      assert.deepEqual(body.error.details, details);
    });
  }

  test('400 for an id that is not a number, 404 for a facility that does not exist', async () => {
    assert.deepEqual((await get(`/facilities/abc/schedule?from=${TODAY}`, { status: 400 })).error.details, { id: 'Facility id must be a whole number.' });
    assert.equal((await get(`/facilities/999999/schedule?from=${TODAY}`, { status: 404 })).error.code, 'FACILITY_NOT_FOUND');
  });

  test('401 without a session', async () => {
    assert.equal((await server.request(`/facilities/${facilityIds[LAB]}/schedule?from=${TODAY}`)).status, 401);
  });

  test('the old day lookup is gone', async () => {
    assert.equal((await server.request(`/facilities/${facilityIds[LAB]}/bookings?date=${TODAY}`, { cookie: minjun })).status, 404);
  });
});

describe('GET /api/bookings/schedule (administrators)', () => {
  const day = async (query, { cookie = admin, status = 200 } = {}) => get(`/bookings/schedule${query}`, { cookie, status });
  const facilityOn = (schedule, name) => schedule.facilities.find((facility) => facility.name === name);

  test('every facility\'s bookings that day, with the student and purpose, pending requests included', async () => {
    const date = freshWeek();
    const approved = await seedBooking({ date, startTime: '10:00', endTime: '12:00', purpose: 'Algorithms study group' });
    const first = await seedBooking({ date, startTime: '13:00', endTime: '15:00', status: 'pending', student: 'minjun.kim', purpose: 'Web lab practice' });
    const second = await seedBooking({ date, startTime: '14:00', endTime: '16:00', status: 'pending', student: 'seoyeon.lee', purpose: 'Contest practice' });
    // Left out: rejected and cancelled, and the days before and after.
    await seedBooking({ date, startTime: '16:00', endTime: '17:00', status: 'rejected' });
    await seedBooking({ date, startTime: '17:00', endTime: '18:00', status: 'cancelled' });
    await seedBooking({ date: addDays(date, -1), startTime: '10:00', endTime: '11:00' });
    await seedBooking({ date: addDays(date, 1), startTime: '10:00', endTime: '11:00' });

    const { data } = await day(`?date=${date}`);
    assert.equal(data.date, date);
    const lab = facilityOn(data, LAB);
    assert.deepEqual(lab.bookings.map((booking) => [booking.id, booking.status, booking.startTime, booking.endTime, booking.student.fullName, booking.purpose]), [
      [approved, 'approved', '10:00', '12:00', 'Park Ji-ho', 'Algorithms study group'],
      [first, 'pending', '13:00', '15:00', 'Kim Min-jun', 'Web lab practice'],
      [second, 'pending', '14:00', '16:00', 'Lee Seo-yeon', 'Contest practice'],
    ]);
    assert.deepEqual(lab.bookings[1].student, {
      id: userIds['minjun.kim@kdu.example'], fullName: 'Kim Min-jun', email: 'minjun.kim@kdu.example', studentNumber: '231001',
    });
    assert.equal(lab.bookings[0].participantCount, 3);
    assert.deepEqual(Object.keys(lab).sort(),
      ['bookings', 'building', 'capacity', 'id', 'isBookable', 'isOpen', 'name', 'openingHours', 'roomNumber', 'status', 'type']);
    assert.deepEqual(lab.openingHours, { opensAt: '09:00', closesAt: '21:00', openWeekends: false });
    assert.deepEqual(lab.building, { code: 'ENG', name: 'Engineering Hall' });
    assert.ok(facilityOn(data, 'Physics Lab').bookings.length === 0);
  });

  test('lists the facilities in the same order as the facility list, retired ones left out', async () => {
    const { data } = await day(`?date=${freshWeek()}`);
    const { data: list } = await get('/facilities', { cookie: admin });
    assert.deepEqual(data.facilities.map((facility) => facility.name),
      list.facilities.filter((facility) => facility.status !== 'inactive').map((facility) => facility.name));
    assert.equal(facilityOn(data, 'Lecture Room 110').status, 'maintenance', 'closed for a while, still listed');
  });

  test('a retired facility appears on a day it still has a booking', async () => {
    const date = freshWeek();
    await seedBooking({ date, startTime: '10:00', endTime: '11:00', facility: 'Conference Room 401' });
    const retired = facilityOn((await day(`?date=${date}`)).data, 'Conference Room 401');
    assert.equal(retired.bookings.length, 1);
    assert.equal(retired.isBookable, false);
  });

  test('type limits it to one kind of facility', async () => {
    const { data } = await day(`?date=${freshWeek()}&type=meeting_room`);
    assert.deepEqual(data.facilities.map((facility) => facility.name), ['Group Study Room A', 'Group Study Room B', 'Club Meeting Room']);
  });

  test('at weekends, facilities closed at weekends say so', async () => {
    const { data } = await day(`?date=${addDays(freshWeek(), 5)}`); // Saturday
    assert.equal(facilityOn(data, LAB).isOpen, false);
    assert.equal(facilityOn(data, STUDY_ROOM).isOpen, true);
  });

  test('a booking that has ended shows as completed', async () => {
    const id = await seedBooking({ date: TODAY, startTime: '09:00', endTime: '10:00' }); // ended at 10:00, it is 14:00
    const lab = facilityOn((await day(`?date=${TODAY}`)).data, LAB);
    assert.equal(lab.bookings.find((booking) => booking.id === id).status, 'completed');
  });

  for (const [name, query, details] of [
    ['a missing date', '', { date: 'Date is required.' }],
    ['an impossible date', '?date=2035-13-01', { date: 'Date must be a real date, written YYYY-MM-DD.' }],
    ['an unknown type', `?date=${TODAY}&type=gym`, { type: 'Type must be one of: classroom, laboratory, meeting_room.' }],
  ]) {
    test(`400 for ${name}`, async () => {
      assert.deepEqual((await day(query, { status: 400 })).error.details, details);
    });
  }

  test('students are refused (403), and so is anyone not signed in (401)', async () => {
    assert.equal((await day(`?date=${TODAY}`, { cookie: minjun, status: 403 })).error.code, 'FORBIDDEN');
    assert.equal((await server.request(`/bookings/schedule?date=${TODAY}`)).status, 401);
  });
});

describe('GET /api/facilities: free at a date and time', () => {
  const ACTIVE_CLASSROOMS = ['Classroom 105', 'Classroom 204', 'Lecture Room 101', 'Seminar Room 302'];
  const free = async (date, startTime, endTime, extra = '') => {
    const { data } = await get(`/facilities?date=${date}&startTime=${startTime}&endTime=${endTime}${extra}`);
    assert.equal(data.total, data.facilities.length);
    return data.facilities.map((facility) => facility.name).sort();
  };

  test('only facilities open for the whole time are listed', async () => {
    const monday = freshWeek();
    assert.deepEqual(await free(monday, '08:00', '09:00'), ACTIVE_CLASSROOMS, 'only classrooms open at 08:00');
    assert.deepEqual(await free(monday, '20:00', '22:00'),
      [...ACTIVE_CLASSROOMS, 'Club Meeting Room', 'Group Study Room A', 'Group Study Room B'].sort(), 'labs close at 21:00');
    const evening = await free(monday, '18:00', '21:00');
    assert.ok(!evening.includes('Chemistry Lab') && evening.includes(LAB), 'the chemistry lab closes at 18:00; the end may be the closing time');
    assert.ok(!(await free(monday, '09:00', '10:00')).includes('Club Meeting Room'), 'it opens at 10:00');
  });

  test('at weekends only facilities open at weekends are listed', async () => {
    const saturday = addDays(freshWeek(), 5);
    assert.deepEqual(await free(saturday, '10:00', '12:00'), ['Club Meeting Room', 'Group Study Room A', 'Group Study Room B']);
  });

  test('facilities under maintenance or retired are never free', async () => {
    const names = await free(freshWeek(), '10:00', '11:00');
    assert.equal(names.length, 11);
    assert.ok(!names.includes('Lecture Room 110') && !names.includes('Conference Room 401'));
  });

  test('an approved booking that takes any of the time makes a facility busy; back-to-back is fine', async () => {
    const monday = freshWeek();
    await seedBooking({ date: monday, startTime: '10:00', endTime: '11:00' });
    const labs = (start, end) => free(monday, start, end, '&type=laboratory');
    assert.ok(!(await labs('10:30', '11:30')).includes(LAB), 'overlaps the end');
    assert.ok(!(await labs('09:00', '12:00')).includes(LAB), 'covers it');
    assert.ok(!(await labs('10:15', '10:45')).includes(LAB), 'inside it');
    assert.ok((await labs('11:00', '12:00')).includes(LAB), 'starts when it ends');
    assert.ok((await labs('09:00', '10:00')).includes(LAB), 'ends when it starts');
    assert.equal((await labs('10:30', '11:30')).length, 3, 'the other labs are still free');
  });

  test('pending requests, rejected and cancelled bookings leave a facility free', async () => {
    const monday = freshWeek();
    for (const status of ['pending', 'rejected', 'cancelled']) await seedBooking({ date: monday, startTime: '10:00', endTime: '11:00', status });
    assert.ok((await free(monday, '10:00', '11:00')).includes(LAB));
  });

  test('combines with the other filters', async () => {
    assert.deepEqual(await free(freshWeek(), '10:00', '12:00', '&type=meeting_room&minCapacity=8'), ['Club Meeting Room', 'Group Study Room B']);
  });

  test('later today is fine', async () => {
    assert.ok((await free(TODAY, '15:00', '16:00')).includes(LAB));
  });

  for (const [name, query, details] of [
    ['a date without times', `date=${TODAY}`, { startTime: 'Start time is required.', endTime: 'End time is required.' }],
    ['times without a date', 'startTime=10:00&endTime=11:00', { date: 'Date is required.' }],
    ['an end before the start', 'date=2035-04-02&startTime=11:00&endTime=10:00', { endTime: 'End time must be after the start time.' }],
    ['an end equal to the start', 'date=2035-04-02&startTime=11:00&endTime=11:00', { endTime: 'End time must be after the start time.' }],
    ['a past date', 'date=2035-03-06&startTime=10:00&endTime=11:00', { date: 'Choose today or a later date.' }],
    ['a start time that has passed today', `date=${TODAY}&startTime=13:00&endTime=15:00`, { startTime: 'This start time has already passed. Choose a later time.' }],
    ['a time that is not HH:MM', 'date=2035-04-02&startTime=9am&endTime=11:00', { startTime: 'Start time must be a valid time, written HH:MM.' }],
  ]) {
    test(`400 for ${name}`, async () => {
      assert.deepEqual((await get(`/facilities?${query}`, { status: 400 })).error.details, details);
    });
  }
});
