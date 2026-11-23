// Attendance through the real app: marking a lecture session, editing it, the course
// report, and a student's own rates with the warning below 80%.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { attendanceSummary } from '../src/services/attendance.service.js';
import { startTestServer } from './helpers/test-server.js';

const PASSWORD = 'Student@2026';

let server;
let admin;
let ali;
const courseIds = {};

before(async () => {
  server = await startTestServer();
  admin = await server.login('admin@kdu.example', 'Admin@2026');
  ali = await server.login('ali.raza@kdu.example', PASSWORD);
  for (const row of (await server.db.query('SELECT id, code FROM courses')).rows) courseIds[row.code] = row.id;
});

after(async () => {
  await server?.close();
});

/** The id of a session of `code` that has started (latest), or that has not (soonest). */
async function sessionOf(code, { started = true } = {}) {
  const { rows: [row] } = await server.db.query(
    `SELECT ls.id FROM lecture_sessions ls JOIN courses c ON c.id = ls.course_id
     WHERE c.code = $1 AND ${started ? 'ls.start_time <= now()' : 'ls.start_time > now()'}
     ORDER BY ls.start_time ${started ? 'DESC' : 'ASC'} LIMIT 1`,
    [code],
  );
  return row.id;
}
const userId = async (email) => (await server.db.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
const save = (sessionId, records, cookie = admin) => server.request(`/sessions/${sessionId}/attendance`, { method: 'PUT', cookie, body: { records } });

describe('the rate and the warning', () => {
  test('present ÷ (present + absent); excused left out; a warning below 80%', () => {
    assert.deepEqual(attendanceSummary({ present: 8, absent: 2, excused: 3 }),
      { present: 8, absent: 2, excused: 3, recorded: 13, ratePercent: 80, warning: false });
    assert.equal(attendanceSummary({ present: 7, absent: 2 }).ratePercent, 77.8);
    assert.equal(attendanceSummary({ present: 7, absent: 2 }).warning, true);
    assert.deepEqual(attendanceSummary({ excused: 2 }), { present: 0, absent: 0, excused: 2, recorded: 2, ratePercent: null, warning: false });
  });
});

describe("a student's own attendance", () => {
  test('Ali Raza is warned in BUS1010, not in CSE2010', async () => {
    const { body } = await server.request('/attendance/mine', { cookie: ali });
    assert.equal(body.data.warningBelowPercent, 80);
    const bus = body.data.courses.find((c) => c.course.code === 'BUS1010');
    const data = body.data.courses.find((c) => c.course.code === 'CSE2010');
    assert.ok(bus.ratePercent < 80 && bus.warning, JSON.stringify(bus));
    assert.ok(data.ratePercent >= 80 && !data.warning, JSON.stringify(data));
    assert.equal(bus.present + bus.absent + bus.excused, bus.recorded);
  });

  test('only for students, and only their own', async () => {
    assert.equal((await server.request('/attendance/mine', { cookie: admin })).status, 403);
    assert.equal((await server.request(`/courses/${courseIds.BUS1010}/attendance-report`, { cookie: ali })).status, 403);
    assert.equal((await save(await sessionOf('BUS1010'), [{ studentId: 1, status: 'present' }], ali)).status, 403);
    const { courses } = (await server.request('/attendance/mine', { cookie: ali })).body.data;
    assert.deepEqual(courses.map((c) => c.course.code), ['BUS1010', 'CSE2010']);
  });
});

describe('taking attendance (administrators)', () => {
  test('the sessions so far, each with how many are marked', async () => {
    const { course, sessions } = (await server.request(`/courses/${courseIds.CSE2010}/sessions`, { cookie: admin })).body.data;
    assert.equal(course.registered, 3);
    assert.ok(sessions.length >= 20, 'two lectures a week for ten weeks');
    assert.ok(sessions.every((s, i) => i === 0 || sessions[i - 1].date >= s.date), 'latest first');
    assert.ok(sessions.slice(-20).every((s) => s.marked === 3), 'the sample weeks are marked');
  });

  test('mark, change and remove; the student sees it at once', async () => {
    const sessionId = await sessionOf('CSE2010');
    const student = await userId('ali.raza@kdu.example');
    const before = (await server.request('/attendance/mine', { cookie: ali })).body.data.courses.find((c) => c.course.code === 'CSE2010');
    const { rows: [original] } = await server.db.query('SELECT status FROM attendance WHERE session_id = $1 AND student_id = $2', [sessionId, student]);

    const absent = await save(sessionId, [{ studentId: student, status: 'absent' }]);
    assert.equal(absent.status, 200, JSON.stringify(absent.body));
    assert.equal(absent.body.data.students.find((s) => s.id === student).status, 'absent');
    const excused = await save(sessionId, [{ studentId: student, status: 'excused' }]);
    assert.equal(excused.body.data.students.find((s) => s.id === student).status, 'excused');
    const after = (await server.request('/attendance/mine', { cookie: ali })).body.data.courses.find((c) => c.course.code === 'CSE2010');
    assert.equal(after.excused, before.excused + (original?.status === 'excused' ? 0 : 1));
    assert.equal(after.recorded, before.recorded + (original ? 0 : 1));

    const removed = await save(sessionId, [{ studentId: student, status: null }]);
    assert.equal(removed.body.data.students.find((s) => s.id === student).status, null);
  });

  test('not for a lecture that has not started, nor for students not in the course', async () => {
    const future = await save(await sessionOf('CSE2010', { started: false }), [{ studentId: await userId('ali.raza@kdu.example'), status: 'present' }]);
    assert.equal(future.status, 409);
    assert.equal(future.body.error.code, 'SESSION_NOT_STARTED');
    const outsider = await userId('fatima.siddiqui@kdu.example'); // not in CSE2010
    const refused = await save(await sessionOf('CSE2010'), [{ studentId: outsider, status: 'present' }]);
    assert.equal(refused.status, 400);
    assert.ok(refused.body.error.details[`records.${outsider}`]);
    assert.equal((await save(await sessionOf('CSE2010'), [{ studentId: outsider, status: 'late' }])).status, 400);
    assert.equal((await save(await sessionOf('CSE2010'), [])).status, 400);
    assert.equal((await server.request('/sessions/999999/attendance', { cookie: admin })).status, 404);
  });

  test('falling below 80% sends the student a University Notice, once', async () => {
    // A new student in CSE2010, absent from the latest lectures one by one.
    const email = 'attendance.drop@kdu.example';
    const { rows: [student] } = await server.db.query(
      `INSERT INTO users (full_name, email, password_hash, role) VALUES ('Drop Student', $1, crypt($2, gen_salt('bf', 4)), 'student') RETURNING id`,
      [email, PASSWORD],
    );
    await server.db.query('INSERT INTO course_registrations (course_id, student_id) VALUES ($1, $2)', [courseIds.CSE2010, student.id]);
    const cookie = await server.login(email, PASSWORD);
    const { rows: sessions } = await server.db.query(
      'SELECT id FROM lecture_sessions WHERE course_id = $1 AND start_time <= now() ORDER BY start_time LIMIT 6', [courseIds.CSE2010],
    );
    const statuses = ['present', 'present', 'present', 'present', 'absent', 'absent']; // 4/5 = 80%, then 4/6 = 66.7%
    for (const [index, session] of sessions.entries()) {
      assert.equal((await save(session.id, [{ studentId: student.id, status: statuses[index] }])).status, 200);
    }
    const warnings = (await server.request('/notifications', { cookie })).body.data.notifications.filter((n) => n.type === 'attendance_warning');
    assert.equal(warnings.length, 1, 'only when it falls below, not for every absence after');
    assert.equal(warnings[0].title, 'Attendance below 80%');
    assert.match(warnings[0].message, /CSE2010 Data Structures is now 66\.7%/);
  });

  test('the course report: lowest rate first, with how many are warned', async () => {
    const { students, warnings, warningBelowPercent } = (await server.request(`/courses/${courseIds.BUS1010}/attendance-report`, { cookie: admin })).body.data;
    assert.equal(warningBelowPercent, 80);
    assert.equal(students[0].fullName, 'Ali Raza');
    assert.equal(students[0].warning, true);
    assert.equal(warnings, students.filter((s) => s.warning).length);
    assert.ok(warnings >= 1);
  });
});
