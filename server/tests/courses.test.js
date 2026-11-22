// The academic module through the real app: courses, professors, lectures that hold
// rooms (room_occupancy), and course registration with its seat limit and clash rule.
//
// The clock is the real one: the sample semester is always running on the day the seed
// runs. Each test that changes rooms uses Seminar Room 302 (HUM 302) at a time and day
// of its own, or a new course; registration tests use new students.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

const PASSWORD = 'Student@2026';
const DAY_MS = 24 * 60 * 60 * 1000;

let server;
let admin; // session cookie
let adminId;
let jiho;
let semester; // { id, name, startsOn, endsOn }
const facilityIds = {};
const courseIds = {};

before(async () => {
  server = await startTestServer();
  admin = await server.login('admin@kdu.example', 'Admin@2026');
  adminId = (await server.db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;
  jiho = await server.login('jiho.park@kdu.example', PASSWORD);
  for (const row of (await server.db.query('SELECT id, name FROM facilities')).rows) facilityIds[row.name] = row.id;
  for (const row of (await server.db.query('SELECT id, code FROM courses')).rows) courseIds[row.code] = row.id;
  const { semesters, currentId } = (await server.request('/semesters', { cookie: admin })).body.data;
  semester = semesters.find((item) => item.id === currentId);
});

after(async () => {
  await server?.close();
});

const seminar = () => facilityIds['Seminar Room 302']; // HUM 302, 08:00-22:00 on weekdays, 24 seats

let studentCount = 0;
async function newStudent() {
  studentCount += 1;
  const email = `courses.${studentCount}@kdu.example`;
  const { rows } = await server.db.query(
    `INSERT INTO users (full_name, email, password_hash, role, student_number)
     VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), 'student', $4) RETURNING id`,
    [`Course Student ${studentCount}`, email, PASSWORD, String(800000 + studentCount)],
  );
  return { id: rows[0].id, cookie: await server.login(email, PASSWORD) };
}

const today = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); // Korea
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** The first date after today (at least 2 days ahead) that falls on ISO `weekday` (1 = Monday). */
function next(weekday, { weeksLater = 0 } = {}) {
  let date = addDays(today(), 2);
  while ((new Date(`${date}T00:00:00Z`).getUTCDay() || 7) !== weekday) date = addDays(date, 1);
  return addDays(date, 7 * weeksLater);
}
const at = (date, time) => `${date}T${time}:00+09:00`;

async function seedBooking({ date, startTime, endTime, status, facilityId = seminar() }) {
  const student = await newStudent();
  const decided = status === 'pending' ? [null, null] : [adminId, new Date().toISOString()];
  const { rows: [row] } = await server.db.query(
    `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, 5, 'Course test booking', $5, $6, $7) RETURNING id`,
    [student.id, facilityId, at(date, startTime), at(date, endTime), status, ...decided],
  );
  return { id: row.id, student };
}

let courseCount = 0;
/** A new course in the sample semester, taught by `professor` (a sample professor's name). */
async function newCourse({ professor = 'Dr. Yoon Tae-hee', seatLimit = 30 } = {}) {
  courseCount += 1;
  const { rows: [{ id: professorId, department_id: departmentId }] } = await server.db.query(
    'SELECT id, department_id FROM professors WHERE full_name = $1', [professor],
  );
  const response = await server.request('/courses', {
    method: 'POST', cookie: admin,
    body: { semesterId: semester.id, code: `TST${String(100 + courseCount)}`, title: `Test Course ${courseCount}`, credits: 3, departmentId, professorId, seatLimit },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data.course;
}

const addSlot = (courseId, body) => server.request(`/courses/${courseId}/slots`, { method: 'POST', cookie: admin, body });
const requestBooking = (cookie, { date, startTime, endTime, facilityId = seminar() }) => server.request('/bookings', {
  method: 'POST', cookie, body: { facilityId, date, startTime, endTime, participantCount: 5, purpose: 'Group study session' },
});

describe('the sample courses', () => {
  test('the current semester is labelled sample data and has eight courses with their lectures', async () => {
    assert.match(semester.name, /\(sample\)$/);
    assert.ok(semester.startsOn <= today() && today() <= semester.endsOn, 'the sample semester is running');
    const { body } = await server.request('/courses', { cookie: jiho });
    assert.equal(body.data.semester.id, semester.id);
    assert.equal(body.data.courses.length, 8);
    const small = body.data.courses.find((course) => course.code === 'GEN1100');
    assert.deepEqual([small.seatLimit, small.seatsTaken, small.seatsLeft], [3, 2, 1]);
    assert.equal(small.isRegistered, true);
    assert.equal(small.canRegister, false);
    const data = body.data.courses.find((course) => course.code === 'CSE2010');
    assert.equal(data.professor.fullName, 'Dr. Han Ji-won');
    assert.equal(data.professor.hasPhoto, false);
    assert.deepEqual(data.slots.map((slot) => [slot.weekday, slot.startTime, slot.endTime, `${slot.facility.building.code} ${slot.facility.roomNumber}`]),
      [[1, '09:00', '10:30', 'ENG 204'], [3, '09:00', '10:30', 'ENG 204']]);
  });

  test('search and department filters', async () => {
    const byText = (await server.request('/courses?q=network', { cookie: jiho })).body.data.courses;
    assert.deepEqual(byText.map((course) => course.code), ['CSE3050']);
    const byProfessor = (await server.request('/courses?q=kang', { cookie: jiho })).body.data.courses;
    assert.deepEqual(byProfessor.map((course) => course.code), ['BUS1010', 'BUS2040']);
    const { departments } = (await server.request('/departments', { cookie: jiho })).body.data;
    const gen = departments.find((department) => department.code === 'GEN');
    const byDepartment = (await server.request(`/courses?department=${gen.id}`, { cookie: jiho })).body.data.courses;
    assert.deepEqual(byDepartment.map((course) => course.code), ['GEN1001', 'GEN1100']);
    assert.equal((await server.request('/courses?semester=abc', { cookie: jiho })).status, 400);
    assert.equal((await server.request('/courses?semester=999', { cookie: jiho })).status, 404);
  });

  test("Park Ji-ho's timetable: three courses, 8 credits", async () => {
    const { body } = await server.request('/courses/mine', { cookie: jiho });
    assert.deepEqual(body.data.courses.map((course) => course.code), ['CSE2010', 'CSE3050', 'GEN1100']);
    assert.equal(body.data.totalCredits, 8);
    assert.equal((await server.request('/courses/mine', { cookie: admin })).status, 403);
  });

  test('signing in is required', async () => {
    assert.equal((await server.request('/courses')).status, 401);
    assert.equal((await server.request('/professors')).status, 401);
  });
});

describe('registering and dropping', () => {
  test('a course whose lectures overlap one already taken is refused', async () => {
    const response = await server.request(`/courses/${courseIds.BUS2040}/register`, { method: 'POST', cookie: jiho });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'TIMETABLE_CLASH');
    assert.match(response.body.error.message, /same time as CSE3050 Computer Networks/);
  });

  test('two students asking for the last seat at the same moment: one gets it, the other is told it is full', async () => {
    const [first, second] = [await newStudent(), await newStudent()];
    const together = server.holdUntilSimultaneous(/^BEGIN$/, 2);
    const responses = await Promise.all([first, second].map((student) =>
      server.request(`/courses/${courseIds.GEN1100}/register`, { method: 'POST', cookie: student.cookie })));
    await together;
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const refused = responses.find((response) => response.status === 409);
    assert.equal(refused.body.error.code, 'COURSE_FULL');
    const { rows: [{ taken }] } = await server.db.query(
      "SELECT count(*)::int AS taken FROM course_registrations WHERE course_id = $1 AND status = 'registered'", [courseIds.GEN1100],
    );
    assert.equal(taken, 3, 'never more than the seat limit');
  });

  test('register, drop, register again; each change is refused when it makes no sense', async () => {
    const student = await newStudent();
    const register = () => server.request(`/courses/${courseIds.BUS1010}/register`, { method: 'POST', cookie: student.cookie });
    const drop = () => server.request(`/courses/${courseIds.BUS1010}/drop`, { method: 'POST', cookie: student.cookie });

    const registered = await register();
    assert.equal(registered.status, 200);
    assert.equal(registered.body.data.course.isRegistered, true);
    assert.equal(registered.body.data.course.canDrop, true);
    assert.equal((await register()).body.error.code, 'ALREADY_REGISTERED');

    const dropped = await drop();
    assert.equal(dropped.status, 200);
    assert.equal(dropped.body.data.course.isRegistered, false);
    assert.equal((await drop()).body.error.code, 'NOT_REGISTERED');
    assert.equal((await register()).status, 200, 'registering again after dropping');
    const { rows: [row] } = await server.db.query('SELECT status, dropped_at FROM course_registrations WHERE course_id = $1 AND student_id = $2', [courseIds.BUS1010, student.id]);
    assert.deepEqual(row, { status: 'registered', dropped_at: null });
  });

  test('administrators cannot register; students cannot manage courses or see the class list', async () => {
    assert.equal((await server.request(`/courses/${courseIds.BUS1010}/register`, { method: 'POST', cookie: admin })).status, 403);
    assert.equal((await server.request('/courses', { method: 'POST', cookie: jiho, body: {} })).status, 403);
    assert.equal((await server.request(`/courses/${courseIds.CSE2010}/students`, { cookie: jiho })).status, 403);
    assert.equal((await server.request(`/courses/${courseIds.CSE2010}/slots`, { method: 'POST', cookie: jiho, body: {} })).status, 403);
    const { students } = (await server.request(`/courses/${courseIds.CSE2010}/students`, { cookie: admin })).body.data;
    assert.deepEqual(students.map((student) => student.fullName), ['Kim Min-jun', 'Lee Seo-yeon', 'Park Ji-ho']);
  });

  test('a course that does not exist', async () => {
    const student = await newStudent();
    assert.equal((await server.request('/courses/999999/register', { method: 'POST', cookie: student.cookie })).status, 404);
    assert.equal((await server.request('/courses/999999', { cookie: student.cookie })).status, 404);
  });
});

describe('lectures hold their room', () => {
  test('a new weekly lecture: sessions for the rest of the semester, on the facility schedule, and the room refuses requests then', async () => {
    const course = await newCourse();
    const tuesday = next(2);
    const created = await addSlot(course.id, { weekday: 2, startTime: '10:00', endTime: '11:30', facilityId: seminar() });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok(created.body.data.sessionsCreated >= 1);
    assert.deepEqual(created.body.data.autoRejected, []);

    const schedule = (await server.request(`/facilities/${seminar()}/schedule?from=${tuesday}&days=1`, { cookie: jiho })).body.data;
    assert.deepEqual(schedule.days[0].bookings, [{ startTime: '10:00', endTime: '11:30', kind: 'lecture', course: { code: course.code, title: course.title } }]);

    const refused = await requestBooking(jiho, { date: tuesday, startTime: '11:00', endTime: '12:00' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.message, `A lecture (${course.code}) is held in this room at this time. Choose a different time.`);
    assert.equal((await requestBooking(jiho, { date: tuesday, startTime: '11:30', endTime: '12:30' })).status, 201, 'right after the lecture is free');

    const free = (await server.request(`/facilities?date=${tuesday}&startTime=10:00&endTime=11:00`, { cookie: jiho })).body.data.facilities;
    assert.ok(!free.some((facility) => facility.id === seminar()), '"Free at" leaves the room out');

    const day = (await server.request(`/bookings/schedule?date=${tuesday}`, { cookie: admin })).body.data;
    const room = day.facilities.find((facility) => facility.id === seminar());
    assert.deepEqual(room.lectures.map((lecture) => [lecture.course.code, lecture.startTime, lecture.endTime]), [[course.code, '10:00', '11:30']]);

    // Removing the lecture frees the room again.
    const removed = await server.request(`/courses/${course.id}/slots/${created.body.data.slot.id}`, { method: 'DELETE', cookie: admin });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.data.sessionsRemoved, created.body.data.sessionsCreated);
    assert.equal((await requestBooking(jiho, { date: tuesday, startTime: '10:00', endTime: '11:00' })).status, 201);
  });

  test('a lecture cannot be scheduled over an approved reservation; nothing is saved', async () => {
    const course = await newCourse();
    const thursday = next(4, { weeksLater: 1 });
    const booking = await seedBooking({ date: thursday, startTime: '08:00', endTime: '09:00', status: 'approved' });
    const before = (await server.db.query('SELECT count(*)::int AS n FROM lecture_sessions')).rows[0].n;

    const refused = await addSlot(course.id, { weekday: 4, startTime: '08:00', endTime: '09:30', facilityId: seminar() });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'LECTURE_CONFLICT');
    assert.ok(refused.body.error.message.includes(`reservation FR-${String(booking.id).padStart(6, '0')}`), refused.body.error.message);
    assert.equal(refused.body.error.details.clashes.length, 1);
    assert.equal((await server.db.query('SELECT count(*)::int AS n FROM lecture_sessions')).rows[0].n, before);
    assert.equal((await server.db.query('SELECT count(*)::int AS n FROM lecture_slots WHERE course_id = $1', [course.id])).rows[0].n, 0);
  });

  test('two lectures cannot share a room, and a professor cannot lecture twice at once', async () => {
    const course = await newCourse();
    // GEN1001 is on Fridays 10:00-12:00 in HUM 302.
    const sameRoom = await addSlot(course.id, { weekday: 5, startTime: '11:00', endTime: '12:00', facilityId: seminar() });
    assert.equal(sameRoom.status, 409);
    assert.match(sameRoom.body.error.message, /lecture GEN1001/);

    // Dr. Oh lectures CSE3050 on Mondays 15:00-16:30 (ENG 204).
    const other = await newCourse({ professor: 'Dr. Oh Seung-woo' });
    const busy = await addSlot(other.id, { weekday: 1, startTime: '16:00', endTime: '17:00', facilityId: seminar() });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, 'PROFESSOR_CLASH');
  });

  test('pending requests for the new lecture\'s time are rejected, and their students told', async () => {
    const course = await newCourse();
    const wednesday = next(3, { weeksLater: 1 });
    const pending = await seedBooking({ date: wednesday, startTime: '18:00', endTime: '19:00', status: 'pending' });
    const elsewhere = await seedBooking({ date: wednesday, startTime: '19:30', endTime: '20:30', status: 'pending' });

    const created = await addSlot(course.id, { weekday: 3, startTime: '18:00', endTime: '19:30', facilityId: seminar() });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.data.autoRejected, [pending.id]);

    const { rows: [row] } = await server.db.query('SELECT status, decision_note, decided_by FROM bookings WHERE id = $1', [pending.id]);
    assert.deepEqual(row, { status: 'rejected', decision_note: 'A lecture was scheduled in this room at this time.', decided_by: adminId });
    assert.equal((await server.db.query('SELECT status FROM bookings WHERE id = $1', [elsewhere.id])).rows[0].status, 'pending');
    const { notifications } = (await server.request('/notifications', { cookie: pending.student.cookie })).body.data;
    assert.equal(notifications[0].title, 'Reservation request rejected');
    assert.ok(notifications[0].message.endsWith('Reason: A lecture was scheduled in this room at this time.'));
  });

  test('a request made before a lecture appeared cannot then be approved over it', async () => {
    // A pending request saved directly, as if it had been sent just as the lecture was being saved.
    const course = await newCourse();
    const monday = next(1, { weeksLater: 2 });
    assert.equal((await addSlot(course.id, { weekday: 1, startTime: '20:00', endTime: '21:00', facilityId: seminar() })).status, 201);
    const { id } = await seedBooking({ date: monday, startTime: '20:00', endTime: '21:00', status: 'pending' });

    const queue = (await server.request('/bookings/requests', { cookie: admin })).body.data.requests;
    const request = queue.find((item) => item.id === id);
    assert.deepEqual([request.timeTaken, request.canApprove], [true, false]);

    const approval = await server.request(`/bookings/${id}/approve`, { method: 'POST', cookie: admin, body: {} });
    assert.equal(approval.status, 409);
    assert.equal(approval.body.error.message, 'A lecture is held in this room during part of this time, so this request cannot be approved.');
    assert.equal((await server.db.query('SELECT status FROM bookings WHERE id = $1', [id])).rows[0].status, 'pending');
  });

  test('an approval and a new lecture for the same time at the same moment: exactly one holds the room', async () => {
    const course = await newCourse();
    const friday = next(5, { weeksLater: 1 });
    const { id } = await seedBooking({ date: friday, startTime: '17:00', endTime: '18:00', status: 'pending' });

    const together = server.holdUntilSimultaneous(/^BEGIN$/, 2);
    const [approval, lecture] = await Promise.all([
      server.request(`/bookings/${id}/approve`, { method: 'POST', cookie: admin, body: {} }),
      addSlot(course.id, { weekday: 5, startTime: '17:00', endTime: '18:00', facilityId: seminar() }),
    ]);
    await together;

    const won = [approval.status === 200, lecture.status === 201];
    assert.equal(won.filter(Boolean).length, 1, JSON.stringify([approval.body, lecture.body]));
    assert.equal((won[0] ? lecture : approval).status, 409);
    const { rows } = await server.db.query(
      `SELECT count(*)::int AS n FROM room_occupancy
       WHERE facility_id = $1 AND during && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
      [seminar(), at(friday, '17:00'), at(friday, '18:00')],
    );
    assert.equal(rows[0].n, 1, 'one thing holds the room');
  });

  test('the database itself refuses a lecture over an approved booking, and an approval over a lecture', async () => {
    const course = await newCourse();
    const date = next(2, { weeksLater: 2 });
    await seedBooking({ date, startTime: '13:00', endTime: '14:00', status: 'approved' });
    await assert.rejects(
      server.db.query(
        'INSERT INTO lecture_sessions (course_id, facility_id, start_time, end_time) VALUES ($1, $2, $3, $4)',
        [course.id, seminar(), at(date, '13:30'), at(date, '14:30')],
      ),
      (err) => err.code === '23P01' && /room_occupancy_no_overlap/.test(err.message),
    );

    await server.db.query(
      'INSERT INTO lecture_sessions (course_id, facility_id, start_time, end_time) VALUES ($1, $2, $3, $4)',
      [course.id, seminar(), at(date, '15:00'), at(date, '16:00')],
    );
    const { id } = await seedBooking({ date, startTime: '15:30', endTime: '16:30', status: 'pending' });
    await assert.rejects(
      server.db.query("UPDATE bookings SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1", [id, adminId]),
      (err) => err.code === '23P01' && /room_occupancy_no_overlap/.test(err.message),
    );
  });

  test('a lecture must fit the room: open, inside its hours, on the half hour, 30 minutes to 4 hours', async () => {
    const course = await newCourse();
    const cases = [
      [{ weekday: 6, startTime: '10:00', endTime: '11:00', facilityId: seminar() }, 'weekday'],
      [{ weekday: 2, startTime: '07:00', endTime: '08:30', facilityId: seminar() }, 'startTime'],
      [{ weekday: 2, startTime: '10:15', endTime: '11:00', facilityId: seminar() }, 'startTime'],
      [{ weekday: 2, startTime: '10:00', endTime: '15:00', facilityId: seminar() }, 'endTime'],
      [{ weekday: 2, startTime: '10:00', endTime: '11:00', facilityId: facilityIds['Lecture Room 110'] }, 'facilityId'],
      [{ weekday: 8, startTime: '10:00', endTime: '11:00', facilityId: seminar() }, 'weekday'],
    ];
    for (const [body, field] of cases) {
      const response = await addSlot(course.id, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.ok(response.body.error.details[field], `${JSON.stringify(body)} -> ${JSON.stringify(response.body.error.details)}`);
    }
  });
});

describe('managing courses', () => {
  test('codes are unique per semester; the seat limit cannot go below the registered students', async () => {
    const course = await newCourse({ seatLimit: 5 });
    const duplicate = await server.request('/courses', {
      method: 'POST', cookie: admin,
      body: { semesterId: semester.id, code: course.code.toLowerCase(), title: 'Copy', credits: 3, departmentId: course.department.id, professorId: course.professor.id, seatLimit: 5 },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'COURSE_CODE_TAKEN');

    const student = await newStudent();
    await server.request(`/courses/${course.id}/register`, { method: 'POST', cookie: student.cookie });
    const fields = { code: course.code, title: 'Renamed', credits: 2, departmentId: course.department.id, professorId: course.professor.id, seatLimit: 0 };
    assert.equal((await server.request(`/courses/${course.id}`, { method: 'PUT', cookie: admin, body: fields })).status, 400);
    const renamed = await server.request(`/courses/${course.id}`, { method: 'PUT', cookie: admin, body: { ...fields, seatLimit: 1 } });
    assert.equal(renamed.status, 200);
    assert.deepEqual([renamed.body.data.course.title, renamed.body.data.course.seatsLeft], ['Renamed', 0]);

    assert.equal((await server.request(`/courses/${course.id}`, { method: 'DELETE', cookie: admin })).body.error.code, 'COURSE_HAS_STUDENTS');
    const unused = await newCourse();
    assert.equal((await server.request(`/courses/${unused.id}`, { method: 'DELETE', cookie: admin })).status, 200);
    assert.equal((await server.request(`/courses/${unused.id}`, { cookie: admin })).status, 404);
  });

  test('invalid course fields are reported per field', async () => {
    const response = await server.request('/courses', { method: 'POST', cookie: admin, body: { code: 'data structures', credits: 9, seatLimit: 'many' } });
    assert.equal(response.status, 400);
    assert.deepEqual(Object.keys(response.body.error.details).sort(), ['code', 'credits', 'departmentId', 'professorId', 'seatLimit', 'semesterId', 'title']);
  });

  test('semesters cannot overlap', async () => {
    const response = await server.request('/semesters', { method: 'POST', cookie: admin, body: { name: 'Overlapping', startsOn: semester.startsOn, endsOn: semester.endsOn } });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'SEMESTER_OVERLAP');
    const later = await server.request('/semesters', { method: 'POST', cookie: admin, body: { name: 'Later semester', startsOn: addDays(semester.endsOn, 60), endsOn: addDays(semester.endsOn, 170) } });
    assert.equal(later.status, 201);
  });
});

describe('professors', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);
  async function upload(id, bytes, credit) {
    const form = new FormData();
    if (credit !== undefined) form.append('credit', credit);
    form.append('photo', new Blob([bytes], { type: 'image/png' }), 'photo.png');
    const response = await fetch(`${server.baseUrl}/api/professors/${id}/photo`, { method: 'PUT', headers: { Cookie: admin }, body: form });
    return { status: response.status, body: await response.json() };
  }

  test('create, edit, photo with its credit, delete', async () => {
    const { departments } = (await server.request('/departments', { cookie: admin })).body.data;
    const created = await server.request('/professors', { method: 'POST', cookie: admin, body: { fullName: '  Dr.  Test  Person ', departmentId: departments[0].id } });
    assert.equal(created.status, 201);
    const { professor } = created.body.data;
    assert.deepEqual([professor.fullName, professor.hasPhoto, professor.courseCount], ['Dr. Test Person', false, 0]);

    assert.equal((await upload(professor.id, PNG)).status, 400, 'the credit is required');
    const notImage = await upload(professor.id, EXE, 'University website');
    assert.equal(notImage.status, 400);
    assert.ok(notImage.body.error.details.photo);
    const uploaded = await upload(professor.id, PNG, 'Kyungdong University website, used with permission');
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    assert.deepEqual([uploaded.body.data.professor.hasPhoto, uploaded.body.data.professor.photoCredit], [true, 'Kyungdong University website, used with permission']);

    const photo = await fetch(`${server.baseUrl}/api/professors/${professor.id}/photo`, { headers: { Cookie: jiho } });
    assert.equal(photo.status, 200, 'students see professors\' photos');
    assert.equal(photo.headers.get('content-type'), 'image/png');

    const renamed = await server.request(`/professors/${professor.id}`, { method: 'PUT', cookie: admin, body: { fullName: 'Dr. Renamed', departmentId: departments[1].id } });
    assert.equal(renamed.body.data.professor.department.id, departments[1].id);
    assert.equal((await server.request(`/professors/${professor.id}`, { method: 'PUT', cookie: jiho, body: { fullName: 'x', departmentId: 1 } })).status, 403);

    assert.equal((await server.request(`/professors/${professor.id}/photo`, { method: 'DELETE', cookie: admin })).body.data.professor.hasPhoto, false);
    assert.equal((await server.request(`/professors/${professor.id}`, { method: 'DELETE', cookie: admin })).status, 200);
  });

  test('a professor who teaches a course cannot be deleted', async () => {
    const { professors } = (await server.request('/professors', { cookie: admin })).body.data;
    const han = professors.find((professor) => professor.fullName === 'Dr. Han Ji-won');
    assert.equal(han.courseCount, 2); // one course in each sample semester
    const response = await server.request(`/professors/${han.id}`, { method: 'DELETE', cookie: admin });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'PROFESSOR_HAS_COURSES');
  });
});
