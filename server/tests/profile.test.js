// The profile (details, password, photo), one booking by id (the printable confirmation)
// and finding a booking by its reservation reference, through the real app.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

const PASSWORD = 'Student@2026';

let server;
let admin; // session cookie
let adminId;
let labId;

before(async () => {
  server = await startTestServer();
  admin = await server.login('admin@kdu.example', 'Admin@2026');
  adminId = (await server.db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;
  labId = (await server.db.query("SELECT id FROM facilities WHERE name = 'Computer Lab A'")).rows[0].id;
});

after(async () => {
  await server?.close();
});

let studentCount = 0;
/** A new student account, signed in: { id, email, cookie }. */
async function newStudent() {
  studentCount += 1;
  const email = `profile.${studentCount}@kdu.example`;
  const { rows } = await server.db.query(
    `INSERT INTO users (full_name, email, password_hash, role, student_number)
     VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), 'student', $4)
     RETURNING id`,
    [`Profile Student ${studentCount}`, email, PASSWORD, String(700000 + studentCount)],
  );
  return { id: rows[0].id, email, cookie: await server.login(email, PASSWORD) };
}

// The first bytes of each image format, padded: enough for the content check.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]); // a Windows program

/** PUT /api/profile/photo with one file. Resolves to { status, body }. */
async function upload(cookie, bytes, { name = 'photo.png', type = 'image/png', field = 'photo' } = {}) {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type }), name);
  const response = await fetch(`${server.baseUrl}/api/profile/photo`, { method: 'PUT', headers: { Cookie: cookie }, body: form });
  return { status: response.status, body: await response.json() };
}

/** GET a photo. Resolves to { status, type, bytes }. */
async function fetchPhoto(pathname, cookie) {
  const response = await fetch(`${server.baseUrl}/api${pathname}`, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: response.status, type: response.headers.get('content-type'), bytes: Buffer.from(await response.arrayBuffer()) };
}

const storedAvatars = async () => readdir(path.join(process.env.STORAGE_DIR, 'avatars')).catch(() => []);

describe('GET and PATCH /api/profile', () => {
  test('shows the signed-in user their own profile; never the password hash', async () => {
    const student = await newStudent();
    const { status, body } = await server.request('/profile', { cookie: student.cookie });
    assert.equal(status, 200);
    const { createdAt, ...rest } = body.data.user;
    assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(rest, {
      id: student.id, fullName: `Profile Student ${studentCount}`, email: student.email, role: 'student',
      studentNumber: String(700000 + studentCount), hasPhoto: false,
    });
  });

  test('changes the full name only; email, student number and role in the body are ignored', async () => {
    const student = await newStudent();
    const { status, body } = await server.request('/profile', {
      method: 'PATCH', cookie: student.cookie,
      body: { fullName: '  Lee   Ji-woo ', email: 'other@kdu.example', studentNumber: '1', role: 'admin' },
    });
    assert.equal(status, 200);
    assert.equal(body.data.user.fullName, 'Lee Ji-woo');
    const { rows: [row] } = await server.db.query('SELECT full_name, email, role, student_number FROM users WHERE id = $1', [student.id]);
    assert.deepEqual(row, { full_name: 'Lee Ji-woo', email: student.email, role: 'student', student_number: String(700000 + studentCount) });
    // The header shows the new name straight away.
    assert.equal((await server.request('/auth/me', { cookie: student.cookie })).body.data.user.fullName, 'Lee Ji-woo');
  });

  test('400 for an empty or too long name; 401 without a session', async () => {
    const student = await newStudent();
    for (const fullName of ['   ', 'x'.repeat(101)]) {
      const response = await server.request('/profile', { method: 'PATCH', cookie: student.cookie, body: { fullName } });
      assert.equal(response.status, 400);
      assert.ok(response.body.error.details.fullName);
    }
    assert.equal((await server.request('/profile')).status, 401);
    assert.equal((await server.request('/profile', { method: 'PATCH', body: { fullName: 'Nobody' } })).status, 401);
  });

  test('administrators have a profile too', async () => {
    const { status, body } = await server.request('/profile', { cookie: admin });
    assert.equal(status, 200);
    assert.equal(body.data.user.role, 'admin');
  });
});

describe('POST /api/profile/password', () => {
  const change = (cookie, body) => server.request('/profile/password', { method: 'POST', cookie, body });

  test('changes the password, keeps this session and signs out the others', async () => {
    const student = await newStudent();
    const otherDevice = await server.login(student.email, PASSWORD);
    const { status, body } = await change(student.cookie, { currentPassword: PASSWORD, newPassword: 'A new password 2026' });
    assert.equal(status, 200);
    assert.deepEqual(body.data, { otherSessionsEnded: 1 });

    assert.equal((await server.request('/auth/me', { cookie: student.cookie })).status, 200);
    assert.equal((await server.request('/auth/me', { cookie: otherDevice })).status, 401);
    await assert.rejects(server.login(student.email, PASSWORD));
    await server.login(student.email, 'A new password 2026');
  });

  test('400 WRONG_PASSWORD under the current password; nothing changes', async () => {
    const student = await newStudent();
    const otherDevice = await server.login(student.email, PASSWORD);
    const { status, body } = await change(student.cookie, { currentPassword: 'not my password', newPassword: 'A new password 2026' });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'WRONG_PASSWORD');
    assert.deepEqual(body.error.details, { currentPassword: 'Your current password is not correct.' });
    assert.equal((await server.request('/auth/me', { cookie: otherDevice })).status, 200);
    await server.login(student.email, PASSWORD);
  });

  test('the new password follows the registration rules, and must differ from the current one', async () => {
    const student = await newStudent();
    const cases = [
      ['short', 'New password must be at least 8 characters.'],
      ['        ', 'New password cannot be only spaces.'],
      ['é'.repeat(40), 'New password must be at most 72 bytes (about 72 English characters).'],
      [PASSWORD, 'Choose a password different from your current one.'],
    ];
    for (const [newPassword, message] of cases) {
      const response = await change(student.cookie, { currentPassword: PASSWORD, newPassword });
      assert.equal(response.status, 400, newPassword);
      assert.equal(response.body.error.details.newPassword, message);
    }
    const missing = await change(student.cookie, {});
    assert.deepEqual(Object.keys(missing.body.error.details).sort(), ['currentPassword', 'newPassword']);
    await server.login(student.email, PASSWORD);
  });

  test('401 without a session', async () => {
    assert.equal((await change(undefined, { currentPassword: PASSWORD, newPassword: 'Whatever 2026' })).status, 401);
  });
});

describe('profile photos', () => {
  test('a PNG, JPEG or WebP is stored outside the public folder and shown to its owner', async () => {
    const student = await newStudent();
    for (const [bytes, type] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [WEBP, 'image/webp']]) {
      const { status, body } = await upload(student.cookie, bytes, { type });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.data.user.hasPhoto, true);
      const photo = await fetchPhoto('/profile/photo', student.cookie);
      assert.equal(photo.status, 200);
      assert.equal(photo.type, type);
      assert.ok(photo.bytes.equals(bytes));
    }
    // Replacing a photo deletes the old file: one file is left for this student.
    const { rows: [row] } = await server.db.query('SELECT photo_file FROM users WHERE id = $1', [student.id]);
    assert.match(row.photo_file, /^[0-9a-f]{32}\.webp$/);
    assert.ok((await storedAvatars()).includes(row.photo_file));
    assert.ok(!path.resolve(process.env.STORAGE_DIR).startsWith(path.resolve('client')));
    assert.equal((await server.request('/auth/me', { cookie: student.cookie })).body.data.user.hasPhoto, true);
  });

  test('the type is checked by content: a program renamed to .png is refused', async () => {
    const student = await newStudent();
    const before = (await storedAvatars()).length;
    const { status, body } = await upload(student.cookie, EXE, { name: 'holiday.png', type: 'image/png' });
    assert.equal(status, 400);
    assert.match(body.error.details.photo, /JPEG, PNG or WebP/);
    assert.equal((await storedAvatars()).length, before);
    assert.equal((await server.request('/profile', { cookie: student.cookie })).body.data.user.hasPhoto, false);
  });

  test('400 for a file over 2 MB, a wrong field name or no file', async () => {
    const student = await newStudent();
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const tooBig = await upload(student.cookie, big);
    assert.equal(tooBig.status, 400);
    assert.equal(tooBig.body.error.details.photo, 'The photo must be at most 2 MB.');
    assert.equal((await upload(student.cookie, PNG, { field: 'picture' })).status, 400);
    const none = await fetch(`${server.baseUrl}/api/profile/photo`, { method: 'PUT', headers: { Cookie: student.cookie }, body: new FormData() });
    assert.equal(none.status, 400);
  });

  test('only the owner and administrators can see a photo; others get 404', async () => {
    const owner = await newStudent();
    const other = await newStudent();
    await upload(owner.cookie, PNG);
    assert.equal((await fetchPhoto(`/users/${owner.id}/photo`, owner.cookie)).status, 200);
    assert.equal((await fetchPhoto(`/users/${owner.id}/photo`, admin)).status, 200);
    assert.equal((await fetchPhoto(`/users/${owner.id}/photo`, other.cookie)).status, 404);
    assert.equal((await fetchPhoto(`/users/${owner.id}/photo`)).status, 401);
    assert.equal((await fetchPhoto(`/users/${other.id}/photo`, other.cookie)).status, 404); // has none
  });

  test('DELETE removes the photo and its file', async () => {
    const student = await newStudent();
    await upload(student.cookie, JPEG, { type: 'image/jpeg' });
    const { rows: [{ photo_file: file }] } = await server.db.query('SELECT photo_file FROM users WHERE id = $1', [student.id]);
    const { status, body } = await server.request('/profile/photo', { method: 'DELETE', cookie: student.cookie });
    assert.equal(status, 200);
    assert.equal(body.data.user.hasPhoto, false);
    assert.ok(!(await storedAvatars()).includes(file));
    assert.equal((await fetchPhoto('/profile/photo', student.cookie)).status, 404);
  });
});

describe('GET /api/bookings/:id and reservation references', () => {
  let day = 0; // approved bookings in one room must not overlap: each gets a day of its own
  async function seedBooking(userId, status = 'pending') {
    const decided = status === 'pending' ? [null, null] : [adminId, new Date()];
    day += 1;
    const date = `2035-07-${String(day).padStart(2, '0')}`;
    const { rows } = await server.db.query(
      `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status, decided_by, decided_at)
       VALUES ($1, $2, $6::timestamptz, $7::timestamptz, 3, 'Reference test', $3, $4, $5)
       RETURNING id`,
      [userId, labId, status, ...decided, `${date}T01:00:00Z`, `${date}T02:00:00Z`], // 10:00-11:00 in Korea
    );
    return rows[0].id;
  }

  test('a student sees their own booking with its reference; someone else\'s is 404', async () => {
    const owner = await newStudent();
    const other = await newStudent();
    const id = await seedBooking(owner.id, 'approved');
    const { status, body } = await server.request(`/bookings/${id}`, { cookie: owner.cookie });
    assert.equal(status, 200);
    assert.equal(body.data.booking.reference, `FR-${String(id).padStart(6, '0')}`);
    assert.equal(body.data.booking.status, 'approved');
    assert.match(body.data.booking.date, /^2035-07-\d{2}$/);
    assert.equal(body.data.booking.startTime, '10:00');
    assert.equal((await server.request(`/bookings/${id}`, { cookie: other.cookie })).status, 404);
    assert.equal((await server.request('/bookings/99999999', { cookie: owner.cookie })).status, 404);
    assert.equal((await server.request(`/bookings/${id}`)).status, 401);
  });

  test('an administrator sees any booking, with the student and who decided', async () => {
    const owner = await newStudent();
    const id = await seedBooking(owner.id, 'approved');
    const { status, body } = await server.request(`/bookings/${id}`, { cookie: admin });
    assert.equal(status, 200);
    assert.equal(body.data.booking.student.id, owner.id);
    assert.equal(body.data.booking.decision.by.id, adminId);
  });

  test('a new request answers with its reference', async () => {
    const student = await newStudent();
    const { status, body } = await server.request('/bookings', {
      method: 'POST', cookie: student.cookie,
      body: { facilityId: labId, date: '2035-06-04', startTime: '13:00', endTime: '14:30', participantCount: 2, purpose: 'Study group' },
    });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.data.booking.reference, `FR-${String(body.data.booking.id).padStart(6, '0')}`);
  });

  test('the administrators\' booking search finds a booking by its reference, written several ways', async () => {
    const owner = await newStudent();
    const id = await seedBooking(owner.id);
    for (const q of [`FR-${String(id).padStart(6, '0')}`, `fr${id}`, ` FR-${id} `]) {
      const { body } = await server.request(`/bookings?q=${encodeURIComponent(q)}`, { cookie: admin });
      assert.deepEqual(body.data.bookings.map((booking) => booking.id), [id], q);
    }
  });
});
