// The facts docs/demo-script.md relies on, checked against a fresh copy of the sample
// data, so the walk-through cannot quietly go out of date when seed.sql changes.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

let server;
let admin; // session cookies
let jiho;

before(async () => {
  server = await startTestServer();
  admin = await server.login('admin@kdu.example', 'Admin@2026');
  jiho = await server.login('jiho.park@kdu.example', 'Student@2026');
});

after(async () => {
  await server?.close();
});

const facilityId = async (name) => (await server.db.query('SELECT id FROM facilities WHERE name = $1', [name])).rows[0].id;

// The dashboard and report steps only read, so they come before the steps that change things.
test('step 1: the dashboard of Park Ji-ho has upcoming bookings and a pending request for Computer Lab A', async () => {
  const { bookings } = (await server.request('/bookings/mine', { cookie: jiho })).body.data;
  assert.ok(bookings.some((booking) => booking.status === 'approved'), 'an upcoming approved booking');
  const pending = bookings.filter((booking) => booking.status === 'pending' && !booking.hasStarted);
  assert.deepEqual(pending.map((booking) => booking.facility.name), ['Computer Lab A']);
});

test('step 4: both Computer Lab A requests are among the 5 the administrator dashboard previews', async () => {
  const { requests } = (await server.request('/bookings/requests', { cookie: admin })).body.data;
  const preview = requests.slice(0, 5).filter((request) => request.facility.name === 'Computer Lab A');
  assert.equal(preview.length, 2);
  assert.ok(preview.every((request) => request.overlappingRequests.length === 1), 'each is marked "Overlaps 1 request"');
  // Step 3 adds one request before this is shown; the preview still has room for it.
  assert.ok(requests.length <= 4);
});

test('step 8: the dashboard has figures to show, and Reports has data for this week and for the last 30 days', async () => {
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); // in Korea
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const day = (offset) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const monday = day(weekday === 0 ? -6 : 1 - weekday);

  const { facilities } = (await server.request('/facilities?status=active', { cookie: admin })).body.data;
  assert.ok(facilities.length > 0, 'active facilities');

  const week = (await server.request(`/reports/summary?from=${monday}&to=${day(weekday === 0 ? 0 : 7 - weekday)}`, { cookie: admin })).body.data;
  assert.equal(week.range.days, 7);
  assert.notEqual(week.totals.utilizationPercent, null, 'the utilization card shows a percentage, not "–"');
  assert.ok(week.totals.requests > 0, 'this week has bookings, so Reports is not empty when the card opens it');

  const month = (await server.request('/reports/summary', { cookie: admin })).body.data;
  assert.equal(month.range.days, 30);
  assert.ok(month.totals.decided > 0 && month.totals.approvalRatePercent !== null, '"Last 30 days" has an approval rate');
  assert.ok(month.totals.bookedHours > 0);
});

test('step 4: Computer Lab A has two pending requests that overlap each other, and approving one rejects the other with a notification', async () => {
  const { requests } = (await server.request('/bookings/requests', { cookie: admin })).body.data;
  const lab = requests.filter((request) => request.facility.name === 'Computer Lab A');
  assert.deepEqual(lab.map((request) => [request.student.fullName, request.startTime, request.endTime]),
    [['Lee Seo-yeon', '15:00', '17:00'], ['Park Ji-ho', '16:00', '18:00']]);
  assert.deepEqual(lab.map((request) => request.overlappingRequests.length), [1, 1]);
  assert.ok(lab.every((request) => request.canApprove));

  const before = (await server.request('/notifications/unread-count', { cookie: jiho })).body.data.unreadCount;
  const approval = await server.request(`/bookings/${lab[0].id}/approve`, { method: 'POST', body: { note: 'Enjoy the lab.' }, cookie: admin });
  assert.deepEqual(approval.body.data.autoRejected, [lab[1].id]);

  const { notifications, unreadCount } = (await server.request('/notifications', { cookie: jiho })).body.data;
  assert.equal(unreadCount, before + 1);
  assert.equal(notifications[0].title, 'Booking request rejected');
  assert.ok(notifications[0].message.endsWith('Reason: Another request for this time was approved.'));

  // The same student asking for part of the approved time is told it is taken.
  const again = await server.request('/bookings', {
    method: 'POST',
    cookie: jiho,
    body: { facilityId: lab[0].facility.id, date: lab[0].date, startTime: '16:00', endTime: '17:00', participantCount: 10, purpose: 'Contest practice' },
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.message, 'This time is already booked. Choose a different time.');
});

test('step 3: Computer Lab A holds 30, so a request for 31 is refused', async () => {
  const { facility } = (await server.request(`/facilities/${await facilityId('Computer Lab A')}`, { cookie: jiho })).body.data;
  assert.equal(facility.capacity, 30);
});

test('step 3: every facility opens and closes on the hour or half hour, so the 30-minute time lists fit', async () => {
  const { rows } = await server.db.query(
    `SELECT name FROM facilities
     WHERE extract(minute FROM opens_at)::int % 30 <> 0 OR extract(minute FROM closes_at)::int % 30 <> 0`,
  );
  assert.deepEqual(rows, []);
});

test('step 3: every sample booking starts and ends on the hour or half hour, like a new request must', async () => {
  const { rows } = await server.db.query(
    `SELECT id FROM bookings
     WHERE extract(minute FROM start_time AT TIME ZONE 'Asia/Seoul')::int % 30 <> 0
        OR extract(minute FROM end_time AT TIME ZONE 'Asia/Seoul')::int % 30 <> 0`,
  );
  assert.deepEqual(rows, []);
});

test('step 3: a new request answers with its reservation reference, and Print record finds it', async () => {
  const lab = await facilityId('Computer Lab A');
  const { rows: [{ day }] } = await server.db.query(
    "SELECT to_char((now() AT TIME ZONE 'Asia/Seoul')::date + 70 + (CASE extract(isodow FROM (now() AT TIME ZONE 'Asia/Seoul')::date + 70) WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 0 END)::int, 'YYYY-MM-DD') AS day",
  );
  const created = await server.request('/bookings', {
    method: 'POST', cookie: jiho,
    body: { facilityId: lab, date: day, startTime: '10:00', endTime: '11:00', participantCount: 10, purpose: 'Demo: study group' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { booking } = created.body.data;
  assert.match(booking.reference, /^FR-\d{6}$/);
  const record = await server.request(`/bookings/${booking.id}`, { cookie: jiho });
  assert.equal(record.body.data.booking.reference, booking.reference);
  assert.equal(record.body.data.booking.status, 'pending');
});

test('step 10: the sample semester is labelled, and Park Ji-ho has three courses for 8 credits', async () => {
  const { semester, courses, totalCredits } = (await server.request('/courses/mine', { cookie: jiho })).body.data;
  assert.match(semester.name, /\(sample\)$/);
  assert.deepEqual(courses.map((course) => course.code), ['CSE2010', 'CSE3050', 'GEN1100']);
  assert.equal(totalCredits, 8);
  const all = (await server.request('/courses', { cookie: jiho })).body.data.courses;
  assert.equal(all.find((course) => course.code === 'GEN1100').seatsLeft, 1);
});

test('step 10: BUS2040 clashes with CSE3050, which Park Ji-ho takes', async () => {
  const bus = (await server.request('/courses?q=BUS2040', { cookie: jiho })).body.data.courses[0];
  const response = await server.request(`/courses/${bus.id}/register`, { method: 'POST', cookie: jiho });
  assert.equal(response.body.error.code, 'TIMETABLE_CLASH');
  assert.match(response.body.error.message, /CSE3050 Computer Networks/);
});

test('step 10: a Friday 10:00 lecture in Seminar Room 302 is refused, naming GEN1001', async () => {
  const course = (await server.request('/courses?q=CSE2010', { cookie: admin })).body.data.courses[0];
  const response = await server.request(`/courses/${course.id}/slots`, {
    method: 'POST', cookie: admin,
    body: { weekday: 5, startTime: '10:00', endTime: '11:00', facilityId: await facilityId('Seminar Room 302') },
  });
  assert.equal(response.body.error.code, 'LECTURE_CONFLICT');
  assert.match(response.body.error.message, /lecture GEN1001/);
});

test('step 11: Park Ji-ho has a CGPA of 3.56 and a provisional current semester', async () => {
  const { semesters, cgpa } = (await server.request('/grades/mine', { cookie: jiho })).body.data;
  assert.equal(cgpa, 3.56);
  assert.deepEqual(semesters[1].courses.map((c) => [c.course.code, c.total, c.letter]),
    [['CSE1010', 92, 'A'], ['CSE2020', 77.7, 'C+'], ['GEN1002', 95.8, 'A+']]);
  assert.ok(semesters[0].courses.every((c) => !c.complete && c.markedWeight === 30), 'only the midterm is marked');
});

test('step 12: Kim Min-jun is below 80% in BUS1010 only', async () => {
  const minjun = await server.login('minjun.kim@kdu.example', 'Student@2026');
  const { courses } = (await server.request('/attendance/mine', { cookie: minjun })).body.data;
  assert.deepEqual(courses.filter((c) => c.warning).map((c) => c.course.code), ['BUS1010']);
});

test('step 13: Dr. Han Ji-won has two overlapping requests; approving Park Ji-ho\'s declines the other', async () => {
  const { meetings } = (await server.request('/meetings?status=pending', { cookie: admin })).body.data;
  const han = meetings.filter((m) => m.professor.fullName === 'Dr. Han Ji-won');
  assert.deepEqual(han.map((m) => m.student.fullName).sort(), ['Lee Seo-yeon', 'Park Ji-ho']);
  const jihoRequest = han.find((m) => m.student.fullName === 'Park Ji-ho');
  const result = await server.request(`/meetings/${jihoRequest.id}/approve`, { method: 'POST', cookie: admin, body: {} });
  assert.equal(result.body.data.autoDeclined.length, 1);
});

test('step 6: Group Study Room B has 2 upcoming approved bookings, which deactivating it leaves in place', async () => {
  const id = await facilityId('Group Study Room B');
  assert.deepEqual((await server.request(`/facilities/${id}/usage`, { cookie: admin })).body.data.usage,
    { upcomingApprovedBookings: 2, pendingRequests: 0 });

  const closed = await server.request(`/facilities/${id}/status`, { method: 'PATCH', body: { status: 'inactive' }, cookie: admin });
  assert.equal(closed.body.data.usage.upcomingApprovedBookings, 2);
  const { total } = (await server.request(`/bookings?facility=${id}&status=approved`, { cookie: admin })).body.data;
  assert.equal(total, 2, 'the Bookings page, filtered as the warning links to it, shows those two');
  assert.equal((await server.request(`/facilities/${id}/status`, { method: 'PATCH', body: { status: 'active' }, cookie: admin })).status, 200);
});

test('step 7: Park Ji-ho has upcoming bookings to warn about, and deactivating him ends his session', async () => {
  const { users } = (await server.request('/users?q=jiho', { cookie: admin })).body.data;
  assert.equal(users.length, 1);
  assert.ok(users[0].upcomingApprovedBookings > 0);
  assert.equal((await server.request(`/users/${users[0].id}/status`, { method: 'PATCH', body: { active: false }, cookie: admin })).status, 200);
  assert.equal((await server.request('/bookings/mine', { cookie: jiho })).status, 401);
});
