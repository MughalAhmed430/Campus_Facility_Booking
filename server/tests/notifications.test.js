// In-app notifications through the real app: what creates one (an approval, a
// rejection, an automatic rejection, an administrator's cancellation), that each is
// stored together with the change or not at all, and the student's own list:
// GET /api/notifications, GET /api/notifications/unread-count,
// POST /api/notifications/:id/read and POST /api/notifications/read-all.
//
// The campus clock is frozen in 2035. Every test uses students of its own.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

const NOW = new Date('2035-03-07T05:00:00Z'); // Wednesday 7 March 2035, 14:00 in Korea
const PASSWORD = 'Student@2026';
const DAY_MS = 24 * 60 * 60 * 1000;

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

let studentCount = 0;
/** A new student account with no bookings or notifications, signed in: { id, cookie }. */
async function newStudent() {
  studentCount += 1;
  const email = `notify.${studentCount}@kdu.example`;
  const { rows } = await server.db.query(
    `INSERT INTO users (full_name, email, password_hash, role)
     VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), 'student')
     RETURNING id`,
    [`Notify Student ${studentCount}`, email, PASSWORD],
  );
  return { id: rows[0].id, cookie: await server.login(email, PASSWORD) };
}

// Approved bookings in one room must not overlap, so each test takes a weekday of its own.
let cursor = Date.parse('2035-05-01T00:00:00Z');
function freshWeekday() {
  do cursor += DAY_MS; while ([0, 6].includes(new Date(cursor).getUTCDay()));
  return new Date(cursor).toISOString().slice(0, 10);
}

/** Puts a booking straight into the test database (no notification). Returns its id. */
async function seedBooking(owner, { date, startTime = '10:00', endTime = '11:00', status = 'pending' }) {
  const approved = status === 'approved';
  const { rows } = await server.db.query(
    `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status, decided_by, decided_at)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 4, 'Seeded by a test', $5, $6, $7::timestamptz)
     RETURNING id`,
    [owner.id, labId, `${date}T${startTime}:00+09:00`, `${date}T${endTime}:00+09:00`, status, approved ? adminId : null, approved ? NOW : null],
  );
  return rows[0].id;
}

/** Puts a notification straight into the test database. Returns its id. */
async function seedNotification(owner, { title = 'Seeded', read = false, createdAt = NOW } = {}) {
  const { rows } = await server.db.query(
    `INSERT INTO notifications (user_id, type, title, message, read_at, created_at)
     VALUES ($1, 'system', $2, 'Seeded by a test.', $3, $4)
     RETURNING id`,
    [owner.id, title, read ? NOW : null, createdAt],
  );
  return rows[0].id;
}

const post = (path, cookie, body = {}) => server.request(path, { method: 'POST', body, cookie });
const approve = (id, body) => post(`/bookings/${id}/approve`, admin, body);
const reject = (id, reason) => post(`/bookings/${id}/reject`, admin, { reason });
const list = (cookie) => server.request('/notifications', { cookie });
const unread = async (cookie) => (await server.request('/notifications/unread-count', { cookie })).body.data.unreadCount;
const stored = async (userId) => (await server.db.query(
  'SELECT booking_id, type, title, message, read_at FROM notifications WHERE user_id = $1 ORDER BY id', [userId],
)).rows;
const status = async (id) => (await server.db.query('SELECT status FROM bookings WHERE id = $1', [id])).rows[0].status;

describe('what creates a notification', () => {
  test('an approval tells the student, with the facility, the time and the note', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: '2035-05-01', startTime: '10:00', endTime: '11:30' }); // a Tuesday
    assert.equal((await approve(id, { note: 'Collect the key from the office.' })).status, 200);

    assert.deepEqual(await stored(student.id), [{
      booking_id: id,
      type: 'booking_approved',
      title: 'Booking request approved',
      message: 'Your request for Computer Lab A (ENG 310) on Tue 01 May, 10:00-11:30 was approved. Note: Collect the key from the office.',
      read_at: null,
    }]);
  });

  test('an approval without a note says only that it was approved', async () => {
    const student = await newStudent();
    await approve(await seedBooking(student, { date: freshWeekday() }));
    const [notification] = await stored(student.id);
    assert.ok(notification.message.endsWith('was approved.'), notification.message);
  });

  test('a rejection tells the student, with the reason', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: freshWeekday() });
    assert.equal((await reject(id, 'The lab is reserved for exams that week.')).status, 200);
    const [notification, ...rest] = await stored(student.id);
    assert.deepEqual(rest, []);
    assert.deepEqual({ booking: notification.booking_id, type: notification.type, title: notification.title },
      { booking: id, type: 'booking_rejected', title: 'Booking request rejected' });
    assert.ok(notification.message.endsWith('was rejected. Reason: The lab is reserved for exams that week.'), notification.message);
  });

  test('approving one request tells the students whose overlapping requests it rejected, and nobody else', async () => {
    const winner = await newStudent();
    const overlapping = await newStudent();
    const bystander = await newStudent();
    const date = freshWeekday();
    const chosen = await seedBooking(winner, { date, startTime: '10:00', endTime: '12:00' });
    const lost = await seedBooking(overlapping, { date, startTime: '11:00', endTime: '13:00' });
    await seedBooking(bystander, { date, startTime: '14:00', endTime: '15:00' });
    await approve(chosen);

    assert.deepEqual((await stored(winner.id)).map((n) => [n.booking_id, n.type]), [[chosen, 'booking_approved']]);
    const [told] = await stored(overlapping.id);
    assert.deepEqual([told.booking_id, told.type], [lost, 'booking_rejected']);
    assert.ok(told.message.endsWith('Reason: Another request for this time was approved.'), told.message);
    assert.deepEqual(await stored(bystander.id), []);
  });

  test('an administrator\'s cancellation tells the student, with the reason', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: freshWeekday(), status: 'approved' });
    assert.equal((await post(`/bookings/${id}/cancel`, admin, { reason: 'The room has a water leak.' })).status, 200);
    const [notification, ...rest] = await stored(student.id);
    assert.deepEqual(rest, []);
    assert.deepEqual({ booking: notification.booking_id, type: notification.type, title: notification.title },
      { booking: id, type: 'booking_cancelled', title: 'Booking cancelled' });
    assert.ok(notification.message.startsWith('Your booking for Computer Lab A (ENG 310) on '), notification.message);
    assert.ok(notification.message.endsWith('was cancelled by an administrator. Reason: The room has a water leak.'), notification.message);
  });

  test('a student cancelling their own booking, or sending a request, creates none', async () => {
    const student = await newStudent();
    const date = freshWeekday();
    const id = await seedBooking(student, { date, status: 'approved' });
    assert.equal((await post(`/bookings/${id}/cancel`, student.cookie)).status, 200);
    const request = { facilityId: labId, date, startTime: '13:00', endTime: '14:00', participantCount: 4, purpose: 'Study group' };
    assert.equal((await post('/bookings', student.cookie, request)).status, 201);
    assert.deepEqual(await stored(student.id), []);
    assert.equal((await server.db.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1', [adminId])).rows[0].n, 0,
      'administrators get no notifications, in the sample data either');
  });

  test('a change that is refused creates none', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: freshWeekday(), status: 'approved' });
    assert.equal((await approve(id)).status, 409);
    assert.equal((await reject(id, 'Too late to reject.')).status, 409);
    assert.equal((await post(`/bookings/${id}/cancel`, admin, { reason: 'No.' })).status, 400);
    assert.deepEqual(await stored(student.id), []);
  });
});

describe('a change and its notification are stored together, or not at all', () => {
  // Makes the database itself refuse one kind of notification, as a real failure would.
  // NOT VALID: the rule applies to new rows only (the sample data has rows of every kind).
  async function whileRefusing(type, work) {
    await server.db.query(`ALTER TABLE notifications ADD CONSTRAINT refuse_for_test CHECK (type <> '${type}') NOT VALID`);
    try {
      await work();
    } finally {
      await server.db.query('ALTER TABLE notifications DROP CONSTRAINT refuse_for_test');
    }
  }

  test('approval: if the notification cannot be stored, the approval and the automatic rejections are undone', async () => {
    const winner = await newStudent();
    const overlapping = await newStudent();
    const date = freshWeekday();
    const chosen = await seedBooking(winner, { date, startTime: '10:00', endTime: '12:00' });
    const other = await seedBooking(overlapping, { date, startTime: '11:00', endTime: '13:00' });

    await whileRefusing('booking_rejected', async () => {
      assert.equal((await approve(chosen)).status, 500);
    });
    assert.deepEqual([await status(chosen), await status(other)], ['pending', 'pending']);
    assert.deepEqual([...await stored(winner.id), ...await stored(overlapping.id)], []);

    assert.equal((await approve(chosen)).status, 200, 'and it works once the database accepts it again');
  });

  test('rejection: if the notification cannot be stored, the request stays pending', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: freshWeekday() });
    await whileRefusing('booking_rejected', async () => {
      assert.equal((await reject(id, 'A reason long enough.')).status, 500);
    });
    assert.equal(await status(id), 'pending');
    assert.deepEqual(await stored(student.id), []);
  });

  test('administrator\'s cancellation: if the notification cannot be stored, the booking stays approved', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: freshWeekday(), status: 'approved' });
    await whileRefusing('booking_cancelled', async () => {
      assert.equal((await post(`/bookings/${id}/cancel`, admin, { reason: 'A reason long enough.' })).status, 500);
    });
    assert.equal(await status(id), 'approved');
    assert.deepEqual(await stored(student.id), []);
  });

  test('two administrators deciding one request at once: one decision, one notification', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: freshWeekday() });
    const responses = await Promise.all([reject(id, 'First administrator.'), reject(id, 'Second administrator.')]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.equal((await stored(student.id)).length, 1);
  });
});

describe('GET /api/notifications and /unread-count', () => {
  test('lists only the student\'s own, newest first, with the unread count', async () => {
    const student = await newStudent();
    const other = await newStudent();
    const older = await seedNotification(student, { title: 'Older', read: true, createdAt: new Date(NOW.getTime() - DAY_MS) });
    const newer = await seedNotification(student, { title: 'Newer' });
    await seedNotification(other, { title: 'Someone else\'s' });

    const response = await list(student.cookie);
    assert.equal(response.status, 200);
    const { notifications, unreadCount } = response.body.data;
    assert.equal(unreadCount, 1);
    assert.deepEqual(notifications, [
      { id: newer, type: 'system', title: 'Newer', message: 'Seeded by a test.', bookingId: null, isRead: false, createdAt: NOW.toISOString() },
      { id: older, type: 'system', title: 'Older', message: 'Seeded by a test.', bookingId: null, isRead: true, createdAt: new Date(NOW.getTime() - DAY_MS).toISOString() },
    ]);
    assert.equal(await unread(student.cookie), 1);
  });

  test('a notification made by a decision carries its booking id', async () => {
    const student = await newStudent();
    const id = await seedBooking(student, { date: freshWeekday() });
    await approve(id);
    const { notifications, unreadCount } = (await list(student.cookie)).body.data;
    assert.deepEqual([notifications.length, notifications[0].bookingId, notifications[0].isRead, unreadCount], [1, id, false, 1]);
  });

  test('shows the latest 50; the unread count still counts them all', async () => {
    const student = await newStudent();
    for (let i = 0; i < 55; i += 1) await seedNotification(student, { title: `Number ${i}`, createdAt: new Date(NOW.getTime() + i * 1000) });
    const { notifications, unreadCount } = (await list(student.cookie)).body.data;
    assert.deepEqual([notifications.length, notifications[0].title, notifications.at(-1).title, unreadCount], [50, 'Number 54', 'Number 5', 55]);
  });

  test('a student with none gets an empty list and 0', async () => {
    const student = await newStudent();
    assert.deepEqual((await list(student.cookie)).body.data, { notifications: [], unreadCount: 0 });
    assert.equal(await unread(student.cookie), 0);
  });

  test('401 without a session, 403 for an administrator', async () => {
    for (const path of ['/notifications', '/notifications/unread-count']) {
      assert.equal((await server.request(path)).status, 401);
      assert.equal((await server.request(path, { cookie: admin })).status, 403);
    }
  });
});

describe('marking as read', () => {
  test('POST /:id/read marks one and returns the new unread count; again changes nothing', async () => {
    const student = await newStudent();
    const first = await seedNotification(student);
    await seedNotification(student);

    const response = await post(`/notifications/${first}/read`, student.cookie);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { unreadCount: 1 });
    const readAt = (await server.db.query('SELECT read_at FROM notifications WHERE id = $1', [first])).rows[0].read_at;
    assert.ok(readAt instanceof Date);

    assert.deepEqual((await post(`/notifications/${first}/read`, student.cookie)).body.data, { unreadCount: 1 });
    assert.deepEqual((await server.db.query('SELECT read_at FROM notifications WHERE id = $1', [first])).rows[0].read_at, readAt, 'the first time stays');
  });

  test('another student\'s notification is a 404, exactly like one that does not exist, and stays unread', async () => {
    const owner = await newStudent();
    const intruder = await newStudent();
    const id = await seedNotification(owner);
    const response = await post(`/notifications/${id}/read`, intruder.cookie);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOTIFICATION_NOT_FOUND');
    assert.deepEqual(response.body, (await post('/notifications/999999/read', intruder.cookie)).body);
    assert.equal(await unread(owner.cookie), 1);
  });

  test('POST /read-all marks every one of the student\'s, and nobody else\'s', async () => {
    const student = await newStudent();
    const other = await newStudent();
    for (let i = 0; i < 3; i += 1) await seedNotification(student);
    await seedNotification(student, { read: true });
    await seedNotification(other);

    const response = await post('/notifications/read-all', student.cookie);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { marked: 3, unreadCount: 0 });
    assert.equal(await unread(student.cookie), 0);
    assert.equal(await unread(other.cookie), 1);
    assert.deepEqual((await post('/notifications/read-all', student.cookie)).body.data, { marked: 0, unreadCount: 0 });
  });

  test('400 for an invalid id; 401 without a session, 403 for an administrator', async () => {
    const student = await newStudent();
    const id = await seedNotification(student);
    assert.equal((await post('/notifications/abc/read', student.cookie)).status, 400);
    for (const path of [`/notifications/${id}/read`, '/notifications/read-all']) {
      assert.equal((await post(path, undefined)).status, 401);
      assert.equal((await post(path, admin)).status, 403);
    }
    assert.equal(await unread(student.cookie), 1);
  });
});
