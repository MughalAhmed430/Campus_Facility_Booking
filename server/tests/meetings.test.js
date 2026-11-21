// Counselling through the real app: office hours, meeting requests inside them, approval
// with the automatic decline of overlapping requests, the advisor guard
// (meetings_no_overlap) under simultaneous approvals, and cancelling.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

const PASSWORD = 'Student@2026';
const DAY_MS = 24 * 60 * 60 * 1000;

let server;
let admin;
let adminId;
let jiho;
const professorIds = {};

before(async () => {
  server = await startTestServer();
  admin = await server.login('admin@kdu.example', 'Admin@2026');
  adminId = (await server.db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;
  jiho = await server.login('jiho.park@kdu.example', PASSWORD);
  for (const row of (await server.db.query('SELECT id, full_name FROM professors')).rows) professorIds[row.full_name] = row.id;
});

after(async () => {
  await server?.close();
});

let count = 0;
async function newStudent() {
  count += 1;
  const email = `meetings.${count}@kdu.example`;
  const { rows: [row] } = await server.db.query(
    `INSERT INTO users (full_name, email, password_hash, role, student_number)
     VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), 'student', $4) RETURNING id`,
    [`Meeting Student ${count}`, email, PASSWORD, String(950000 + count)],
  );
  return { id: row.id, cookie: await server.login(email, PASSWORD) };
}

const today = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** The date on ISO weekday `weekday`, at least 3 days ahead, `weeks` weeks later still. */
function next(weekday, weeks = 0) {
  let date = addDays(today(), 3);
  while ((new Date(`${date}T00:00:00Z`).getUTCDay() || 7) !== weekday) date = addDays(date, 1);
  return addDays(date, 7 * weeks);
}

// Dr. Yoon Tae-hee: Thursdays 10:00-12:00 in the sample data, and no sample meetings.
const yoon = () => professorIds['Dr. Yoon Tae-hee'];
const ask = (cookie, body) => server.request('/meetings', {
  method: 'POST', cookie,
  body: { professorId: yoon(), category: 'academic_advising', description: 'Questions about my study plan.', minutes: 30, ...body },
});
const approve = (id, cookie = admin) => server.request(`/meetings/${id}/approve`, { method: 'POST', cookie, body: {} });

describe('advisors and office hours', () => {
  test('every advisor with office hours, and the categories', async () => {
    const { advisors, categories, lengths } = (await server.request('/advisors', { cookie: jiho })).body.data;
    assert.equal(advisors.length, 5);
    const han = advisors.find((a) => a.fullName === 'Dr. Han Ji-won');
    assert.deepEqual(han.officeHours.map((o) => [o.weekday, o.startTime, o.endTime]), [[2, '13:00', '15:00'], [4, '13:00', '15:00']]);
    assert.deepEqual(Object.keys(categories), ['academic_advising', 'course_planning', 'career_guidance', 'research_supervision', 'internship', 'other']);
    assert.deepEqual(lengths, [30, 60]);
  });

  test('availability: 30-minute starts inside the office hours; an approved meeting takes its time', async () => {
    const thursday = next(4, 3);
    const student = await newStudent();
    const { id } = (await ask(student.cookie, { date: thursday, startTime: '10:30' })).body.data.meeting;
    let slots = (await server.request(`/advisors/${yoon()}/availability?date=${thursday}`, { cookie: jiho })).body.data.slots;
    assert.deepEqual(slots.map((s) => s.startTime), ['10:00', '10:30', '11:00', '11:30']);
    assert.ok(slots.every((s) => s.free), 'a pending request holds no time');
    await approve(id);
    slots = (await server.request(`/advisors/${yoon()}/availability?date=${thursday}`, { cookie: jiho })).body.data.slots;
    assert.deepEqual(slots.map((s) => s.free), [true, false, true, true]);
    assert.deepEqual((await server.request(`/advisors/${yoon()}/availability?date=${next(1)}`, { cookie: jiho })).body.data.slots, [], 'no office hours on Mondays');
  });

  test('administrators add and remove office hours; overlapping ones are refused', async () => {
    const id = professorIds['Dr. Jung Hye-jin'];
    const add = (body) => server.request(`/advisors/${id}/office-hours`, { method: 'POST', cookie: admin, body: { location: 'HUM 220', ...body } });
    const created = await add({ weekday: 3, startTime: '09:00', endTime: '10:00' });
    assert.equal(created.status, 201);
    assert.equal((await add({ weekday: 3, startTime: '09:30', endTime: '11:00' })).body.error.code, 'OFFICE_HOURS_OVERLAP');
    assert.equal((await add({ weekday: 3, startTime: '09:15', endTime: '11:00' })).status, 400);
    assert.equal((await server.request(`/advisors/${id}/office-hours`, { method: 'POST', cookie: jiho, body: {} })).status, 403);
    const removed = await server.request(`/advisors/${id}/office-hours/${created.body.data.officeHours.id}`, { method: 'DELETE', cookie: admin });
    assert.equal(removed.status, 200);
  });
});

describe('requesting a meeting', () => {
  test('inside office hours, with a category and a description; pending until decided', async () => {
    const student = await newStudent();
    const created = await ask(student.cookie, { date: next(4), startTime: '11:00', minutes: 60, category: 'career_guidance' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { meeting } = created.body.data;
    assert.deepEqual([meeting.status, meeting.startTime, meeting.endTime, meeting.categoryLabel, meeting.location],
      ['pending', '11:00', '12:00', 'Career guidance', 'HUM 214 (professor\'s office)']);
    assert.equal(meeting.canCancel, true);
    const { meetings } = (await server.request('/meetings/mine', { cookie: student.cookie })).body.data;
    assert.deepEqual(meetings.map((m) => m.id), [meeting.id]);
  });

  test('refused outside office hours, off the half hour, too long, in the past, or with a bad category', async () => {
    const student = await newStudent();
    const cases = [
      [{ date: next(4), startTime: '11:30', minutes: 60 }, 'startTime'], // runs past 12:00
      [{ date: next(4), startTime: '14:00' }, 'startTime'],
      [{ date: next(3), startTime: '10:00' }, 'startTime'], // a Wednesday
      [{ date: next(4), startTime: '10:15' }, 'startTime'],
      [{ date: next(4), startTime: '10:00', minutes: 45 }, 'minutes'],
      [{ date: addDays(today(), -1), startTime: '10:00' }, 'date'],
      [{ date: addDays(today(), 90), startTime: '10:00' }, 'date'],
      [{ date: next(4), startTime: '10:00', category: 'gossip' }, 'category'],
      [{ date: next(4), startTime: '10:00', description: 'Hi' }, 'description'],
      [{ date: next(4), startTime: '10:00', professorId: 999999 }, 'professorId'],
    ];
    for (const [body, field] of cases) {
      const response = await ask(student.cookie, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.ok(response.body.error.details[field], `${JSON.stringify(body)}: ${JSON.stringify(response.body.error.details)}`);
    }
  });

  test('a time the advisor has an approved meeting is refused; a student cannot overlap their own', async () => {
    const date = next(4, 1);
    const first = await newStudent();
    const { id } = (await ask(first.cookie, { date, startTime: '10:00' })).body.data.meeting;
    await approve(id);
    const second = await newStudent();
    const taken = await ask(second.cookie, { date, startTime: '10:00' });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.code, 'MEETING_CONFLICT');
    assert.equal((await ask(first.cookie, { date, startTime: '10:00' })).body.error.code, 'MEETING_OVERLAPS_YOURS');
    assert.equal((await ask(second.cookie, { date, startTime: '10:30' })).status, 201, 'right after it is free');
  });

  test('only students request; administrators list', async () => {
    assert.equal((await ask(admin, { date: next(4), startTime: '10:00' })).status, 403);
    assert.equal((await server.request('/meetings', { cookie: jiho })).status, 403);
  });
});

describe('deciding (administrators)', () => {
  test('the sample: two requests for Dr. Han at the same time; approving one declines the other, both students told', async () => {
    const { meetings } = (await server.request('/meetings?status=pending', { cookie: admin })).body.data;
    const han = meetings.filter((m) => m.professor.fullName === 'Dr. Han Ji-won');
    assert.equal(han.length, 2);
    assert.ok(han.every((m) => m.overlappingRequests.length === 1 && m.canDecide));
    const [first, second] = han;
    const result = await approve(first.id);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.data.autoDeclined, [second.id]);

    const { rows } = await server.db.query('SELECT id, status, decision_note, decided_by FROM meetings WHERE id = ANY($1::int[]) ORDER BY id', [[first.id, second.id]]);
    assert.deepEqual(rows.map((r) => r.status).sort(), ['approved', 'rejected']);
    assert.equal(rows.find((r) => r.id === second.id).decision_note, 'Another meeting at this time was approved.');
    const { rows: told } = await server.db.query('SELECT user_id, type, title FROM notifications WHERE meeting_id = ANY($1::int[]) ORDER BY type', [[first.id, second.id]]);
    assert.deepEqual(told.map((n) => n.title), ['Meeting approved', 'Meeting request declined']);
  });

  test('declining needs a reason the student sees', async () => {
    const student = await newStudent();
    const { id } = (await ask(student.cookie, { date: next(4, 2), startTime: '11:30' })).body.data.meeting;
    assert.equal((await server.request(`/meetings/${id}/decline`, { method: 'POST', cookie: admin, body: { reason: 'no' } })).status, 400);
    assert.equal((await server.request(`/meetings/${id}/decline`, { method: 'POST', cookie: admin, body: { reason: 'The professor is away that week.' } })).status, 200);
    const [meeting] = (await server.request('/meetings/mine', { cookie: student.cookie })).body.data.meetings;
    assert.deepEqual([meeting.status, meeting.decision.note], ['rejected', 'The professor is away that week.']);
    assert.equal((await approve(id)).body.error.code, 'MEETING_NOT_PENDING');
    const { notifications } = (await server.request('/notifications', { cookie: student.cookie })).body.data;
    assert.equal(notifications[0].meetingId, id);
    assert.ok(notifications[0].message.endsWith('Reason: The professor is away that week.'));
  });

  test('two overlapping requests approved at the same moment: exactly one is approved', async () => {
    const date = next(4, 4);
    const [a, b] = [await newStudent(), await newStudent()];
    const first = (await ask(a.cookie, { date, startTime: '10:00', minutes: 60 })).body.data.meeting.id;
    const second = (await ask(b.cookie, { date, startTime: '10:30' })).body.data.meeting.id;
    const together = server.holdUntilSimultaneous(/^BEGIN$/, 2);
    const responses = await Promise.all([approve(first), approve(second)]);
    await together;
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    const { rows } = await server.db.query("SELECT count(*)::int AS n FROM meetings WHERE id = ANY($1::int[]) AND status = 'approved'", [[first, second]]);
    assert.equal(rows[0].n, 1);
  });

  test('the database itself refuses a second overlapping approved meeting for one advisor', async () => {
    const date = next(4, 5);
    const insert = (start, end, status) => server.db.query(
      `INSERT INTO meetings (student_id, professor_id, start_time, end_time, category, description, status, decided_by, decided_at)
       VALUES ((SELECT id FROM users WHERE email = 'jiho.park@kdu.example'), $1, $2, $3, 'other', 'Direct insert.', $4, $5, now())`,
      [yoon(), `${date}T${start}:00+09:00`, `${date}T${end}:00+09:00`, status, adminId],
    );
    await insert('10:00', '11:00', 'approved');
    await assert.rejects(insert('10:30', '11:30', 'approved'), (err) => err.code === '23P01' && /meetings_no_overlap/.test(err.message));
    await insert('11:00', '11:30', 'approved'); // back to back is fine
  });
});

describe('cancelling', () => {
  test('a student cancels their own pending or approved meeting; not someone else\'s', async () => {
    const student = await newStudent();
    const { id } = (await ask(student.cookie, { date: next(4, 6), startTime: '10:00' })).body.data.meeting;
    await approve(id);
    const other = await newStudent();
    assert.equal((await server.request(`/meetings/${id}/cancel`, { method: 'POST', cookie: other.cookie, body: {} })).status, 404);
    const cancelled = await server.request(`/meetings/${id}/cancel`, { method: 'POST', cookie: student.cookie, body: { reason: 'Exam that day.' } });
    assert.equal(cancelled.status, 200);
    assert.deepEqual([cancelled.body.data.meeting.status, cancelled.body.data.meeting.cancellation.byStudent], ['cancelled', true]);
    assert.equal((await server.request(`/meetings/${id}/cancel`, { method: 'POST', cookie: student.cookie, body: {} })).body.error.code, 'MEETING_NOT_CANCELLABLE');
    const slots = (await server.request(`/advisors/${yoon()}/availability?date=${next(4, 6)}`, { cookie: jiho })).body.data.slots;
    assert.equal(slots[0].free, true, 'the time is free again');
  });

  test('a past approved meeting shows as completed and cannot be cancelled', async () => {
    const minjun = await server.login('minjun.kim@kdu.example', PASSWORD);
    const seoyeon = await server.login('seoyeon.lee@kdu.example', PASSWORD);
    const past = (await server.request('/meetings/mine', { cookie: seoyeon })).body.data.meetings.find((m) => m.status === 'completed');
    assert.ok(past && !past.canCancel);
    const upcoming = (await server.request('/meetings/mine', { cookie: minjun })).body.data.meetings[0];
    assert.deepEqual([upcoming.status, upcoming.professor.fullName, upcoming.canCancel], ['approved', 'Dr. Oh Seung-woo', true]);
  });
});
