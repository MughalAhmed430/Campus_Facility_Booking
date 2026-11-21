// Grades through the real app: weighted assessments, marks, course totals and letters,
// semester GPA and CGPA, and who may see what.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { courseResult, gpaOf, letterFor } from '../src/services/grade.service.js';
import { startTestServer } from './helpers/test-server.js';

const PASSWORD = 'Student@2026';

let server;
let admin;
let jiho;
let seoyeon;
const courseIds = {};

before(async () => {
  server = await startTestServer();
  admin = await server.login('admin@kdu.example', 'Admin@2026');
  jiho = await server.login('jiho.park@kdu.example', PASSWORD);
  seoyeon = await server.login('seoyeon.lee@kdu.example', PASSWORD);
  for (const row of (await server.db.query('SELECT id, code FROM courses')).rows) courseIds[row.code] = row.id;
});

after(async () => {
  await server?.close();
});

let count = 0;
async function newStudent() {
  count += 1;
  const email = `grades.${count}@kdu.example`;
  const { rows: [row] } = await server.db.query(
    `INSERT INTO users (full_name, email, password_hash, role, student_number)
     VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), 'student', $4) RETURNING id`,
    [`Grade Student ${count}`, email, PASSWORD, String(900000 + count)],
  );
  return { id: row.id, cookie: await server.login(email, PASSWORD) };
}

/** A new course in the current semester with no assessments, and a registered student. */
async function newCourse() {
  const { semesters, currentId } = (await server.request('/semesters', { cookie: admin })).body.data;
  const { rows: [professor] } = await server.db.query("SELECT id, department_id FROM professors WHERE full_name = 'Dr. Kang Mi-rae'");
  count += 1;
  const created = await server.request('/courses', {
    method: 'POST', cookie: admin,
    body: { semesterId: semesters.find((s) => s.id === currentId).id, code: `GRD${100 + count}`, title: 'Grading Test', credits: 3, departmentId: professor.department_id, professorId: professor.id, seatLimit: 10 },
  });
  const course = created.body.data.course;
  const student = await newStudent();
  await server.request(`/courses/${course.id}/register`, { method: 'POST', cookie: student.cookie });
  return { course, student };
}

const addAssessment = (courseId, body) => server.request(`/courses/${courseId}/assessments`, { method: 'POST', cookie: admin, body });
const putMarks = (courseId, assessmentId, marks, cookie = admin) => server.request(`/courses/${courseId}/assessments/${assessmentId}/marks`, { method: 'PUT', cookie, body: { marks } });

describe('the grade scale and the calculations', () => {
  test('letters at each boundary', () => {
    const cases = [[100, 'A+'], [95, 'A+'], [94.99, 'A'], [90, 'A'], [85, 'B+'], [80, 'B'], [75, 'C+'], [70, 'C'], [65, 'D+'], [60, 'D'], [59.99, 'F'], [0, 'F']];
    for (const [total, letter] of cases) assert.equal(letterFor(total).letter, letter, String(total));
  });

  test('a course total is the weighted sum; a letter only when everything is marked and the weights make 100', () => {
    const assessments = [{ id: 1, weight: 30, maxPoints: 100 }, { id: 2, weight: 30, maxPoints: 50 }, { id: 3, weight: 40, maxPoints: 100 }];
    assert.deepEqual(courseResult(assessments, new Map([[1, 92], [2, 44], [3, 95]])),
      { total: 92, markedWeight: 100, complete: true, letter: 'A', gradePoints: 4 }); // 27.6 + 26.4 + 38
    assert.deepEqual(courseResult(assessments, new Map([[2, 40]])),
      { total: 24, markedWeight: 30, complete: false, letter: null, gradePoints: null });
    assert.equal(courseResult(assessments.slice(0, 2), new Map([[1, 100], [2, 50]])).complete, false, 'weights of 60 are not a whole course');
    assert.equal(courseResult(assessments, new Map()).total, null);
  });

  test('GPA is weighted by credits and counts complete courses only', () => {
    assert.equal(gpaOf([
      { complete: true, gradePoints: 4.0, credits: 3 },
      { complete: true, gradePoints: 2.5, credits: 3 },
      { complete: true, gradePoints: 4.5, credits: 2 },
      { complete: false, gradePoints: null, credits: 3 },
    ]), 3.56); // 28.5 / 8
    assert.equal(gpaOf([{ complete: false, gradePoints: null, credits: 3 }]), null);
  });
});

describe("a student's own grades", () => {
  test('Park Ji-ho: last semester complete with a GPA of 3.56; this one provisional', async () => {
    const { body } = await server.request('/grades/mine', { cookie: jiho });
    assert.equal(body.success, true);
    const [current, previous] = body.data.semesters;
    assert.match(current.semester.name, /\(sample\)$/);
    assert.match(previous.semester.name, /\(sample\)$/);
    assert.ok(previous.semester.startsOn < current.semester.startsOn);

    assert.deepEqual(previous.courses.map((c) => [c.course.code, c.total, c.letter, c.gradePoints]),
      [['CSE1010', 92, 'A', 4], ['CSE2020', 77.7, 'C+', 2.5], ['GEN1002', 95.8, 'A+', 4.5]]);
    assert.equal(previous.gpa, 3.56);
    assert.equal(previous.creditsEarned, 8);

    assert.equal(current.gpa, null, 'nothing is complete yet this semester');
    const data = current.courses.find((c) => c.course.code === 'CSE2010');
    assert.deepEqual([data.total, data.markedWeight, data.complete, data.letter], [25.2, 30, false, null]); // 84% of 30
    assert.deepEqual(data.assessments.map((a) => [a.name, a.weight, a.points]),
      [['Assignments', 30, null], ['Midterm exam', 30, 84], ['Final exam', 40, null]]);

    assert.equal(body.data.cgpa, 3.56);
    assert.equal(body.data.creditsEarned, 8);
    assert.equal(body.data.scale[0].letter, 'A+');
  });

  test('a failed course counts in the GPA but earns no credits', async () => {
    const yuna = await server.login('yuna.choi@kdu.example', PASSWORD);
    const { semesters } = (await server.request('/grades/mine', { cookie: yuna })).body.data;
    const previous = semesters[1];
    assert.deepEqual(previous.courses.map((c) => [c.course.code, c.letter]), [['BUS1020', 'F'], ['HTM1010', 'B+']]);
    assert.equal(previous.gpa, 1.75); // (0 * 3 + 3.5 * 3) / 6
    assert.equal(previous.creditsEarned, 3);
  });

  test('students see only their own: no gradebook, no other course\'s assessments, no grades endpoint for admins', async () => {
    assert.equal((await server.request(`/courses/${courseIds.CSE2010}/gradebook`, { cookie: jiho })).status, 403);
    assert.equal((await server.request(`/courses/${courseIds.CSE3020}/assessments`, { cookie: jiho })).status, 404, 'not his course');
    assert.equal((await server.request(`/courses/${courseIds.CSE2010}/assessments`, { cookie: jiho })).status, 200, 'his course');
    assert.equal((await putMarks(courseIds.CSE2010, 1, [{ studentId: 1, points: 100 }], jiho)).status, 403);
    assert.equal((await server.request('/grades/mine', { cookie: admin })).status, 403);
    assert.equal((await server.request('/grades/mine')).status, 401);
    const other = (await server.request('/grades/mine', { cookie: seoyeon })).body.data;
    assert.ok(!JSON.stringify(other).includes('CSE3050'), 'only her own courses');
  });
});

describe('assessments and marks (administrators)', () => {
  test('weights can add up to 100, never more', async () => {
    const { course } = await newCourse();
    assert.equal((await addAssessment(course.id, { name: 'Coursework', weight: 60, maxPoints: 100 })).status, 201);
    const over = await addAssessment(course.id, { name: 'Exam', weight: 50, maxPoints: 100 });
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'WEIGHTS_OVER_100');
    assert.match(over.body.error.message, /At most 40 is left/);
    assert.equal((await addAssessment(course.id, { name: 'Exam', weight: 40, maxPoints: 80 })).status, 201);
    const duplicate = await addAssessment(course.id, { name: 'Exam', weight: 1, maxPoints: 10 });
    assert.equal(duplicate.status, 409); // the weights are full, and the name is taken
    const listed = (await server.request(`/courses/${course.id}/assessments`, { cookie: admin })).body.data;
    assert.deepEqual([listed.assessments.map((a) => a.name), listed.weightTotal], [['Coursework', 'Exam'], 100]);
  });

  test('marks: saved in one go, checked against the maximum, removable, and turned into a letter', async () => {
    const { course, student } = await newCourse();
    const work = (await addAssessment(course.id, { name: 'Coursework', weight: 60, maxPoints: 100 })).body.data.assessment;
    const exam = (await addAssessment(course.id, { name: 'Exam', weight: 40, maxPoints: 80 })).body.data.assessment;

    const tooHigh = await putMarks(course.id, exam.id, [{ studentId: student.id, points: 81 }]);
    assert.equal(tooHigh.status, 400);
    assert.equal(tooHigh.body.error.details[`marks.${student.id}`], 'Enter a mark from 0 to 80.');
    const outsider = await newStudent();
    const notRegistered = await putMarks(course.id, exam.id, [{ studentId: outsider.id, points: 50 }]);
    assert.equal(notRegistered.status, 400);
    assert.equal((await putMarks(course.id, exam.id, [{ studentId: student.id, points: 'lots' }])).status, 400);
    assert.equal((await server.db.query('SELECT count(*)::int AS n FROM marks WHERE student_id = $1', [student.id])).rows[0].n, 0, 'nothing saved');

    await putMarks(course.id, work.id, [{ studentId: student.id, points: 90 }]);
    const book = (await putMarks(course.id, exam.id, [{ studentId: student.id, points: 70.5 }])).body.data;
    const row = book.students.find((s) => s.id === student.id);
    assert.deepEqual(row.result, { total: 89.25, markedWeight: 100, complete: true, letter: 'B+', gradePoints: 3.5 }); // 54 + 35.25

    const mine = (await server.request('/grades/mine', { cookie: student.cookie })).body.data;
    assert.equal(mine.semesters[0].courses[0].letter, 'B+');
    assert.equal(mine.cgpa, 3.5);

    const removed = (await putMarks(course.id, exam.id, [{ studentId: student.id, points: null }])).body.data;
    assert.equal(removed.students.find((s) => s.id === student.id).result.complete, false);
  });

  test('an assessment with marks cannot be deleted, nor its maximum lowered below a mark', async () => {
    const { course, student } = await newCourse();
    const quiz = (await addAssessment(course.id, { name: 'Quiz', weight: 10, maxPoints: 20 })).body.data.assessment;
    await putMarks(course.id, quiz.id, [{ studentId: student.id, points: 18 }]);
    const lower = await server.request(`/courses/${course.id}/assessments/${quiz.id}`, { method: 'PUT', cookie: admin, body: { name: 'Quiz', weight: 10, maxPoints: 15 } });
    assert.equal(lower.body.error.code, 'MARKS_ABOVE_MAX');
    const deleted = await server.request(`/courses/${course.id}/assessments/${quiz.id}`, { method: 'DELETE', cookie: admin });
    assert.equal(deleted.body.error.code, 'ASSESSMENT_HAS_MARKS');
    await putMarks(course.id, quiz.id, [{ studentId: student.id, points: null }]);
    assert.equal((await server.request(`/courses/${course.id}/assessments/${quiz.id}`, { method: 'DELETE', cookie: admin })).status, 200);
  });

  test('the gradebook of a sample course lists every registered student', async () => {
    const book = (await server.request(`/courses/${courseIds.CSE2010}/gradebook`, { cookie: admin })).body.data;
    assert.deepEqual(book.students.map((s) => [s.fullName, s.result.total]), [['Kim Min-jun', 21.3], ['Lee Seo-yeon', 26.4], ['Park Ji-ho', 25.2]]);
    assert.equal(book.weightTotal, 100);
  });

  test('invalid assessment fields', async () => {
    const response = await addAssessment(courseIds.CSE2010, { name: '', weight: 0, maxPoints: 1.234 });
    assert.equal(response.status, 400);
    assert.deepEqual(Object.keys(response.body.error.details).sort(), ['maxPoints', 'name', 'weight']);
  });
});
