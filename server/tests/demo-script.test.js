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
