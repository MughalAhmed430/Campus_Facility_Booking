// Assignments through the real app: setting one (with an attachment), handing in files
// checked by content, replacing until the deadline, late submissions, who may download
// what, marking with feedback, and the marks feeding the course grade.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { checkDocument } from '../src/utils/document-type.js';
import { startTestServer } from './helpers/test-server.js';

const PASSWORD = 'Student@2026';

let server;
let admin;
let course; // a new course in the current semester, with a "from assignments" assessment
let student;
let other; // registered too
let outsider; // not registered

before(async () => {
  server = await startTestServer();
  admin = await server.login('admin@kdu.example', 'Admin@2026');
  const { semesters, currentId } = (await server.request('/semesters', { cookie: admin })).body.data;
  const { rows: [professor] } = await server.db.query("SELECT id, department_id FROM professors WHERE full_name = 'Dr. Han Ji-won'");
  course = (await server.request('/courses', {
    method: 'POST', cookie: admin,
    body: { semesterId: currentId ?? semesters[0].id, code: 'ASG101', title: 'Assignment Testing', credits: 3, departmentId: professor.department_id, professorId: professor.id, seatLimit: 10 },
  })).body.data.course;
  student = await newStudent();
  other = await newStudent();
  outsider = await newStudent();
  for (const s of [student, other]) await server.request(`/courses/${course.id}/register`, { method: 'POST', cookie: s.cookie });
});

after(async () => {
  await server?.close();
});

let count = 0;
async function newStudent() {
  count += 1;
  const email = `assign.${count}@kdu.example`;
  const { rows: [row] } = await server.db.query(
    `INSERT INTO users (full_name, email, password_hash, role, student_number)
     VALUES ($1, $2, crypt($3, gen_salt('bf', 4)), 'student', $4) RETURNING id`,
    [`Assign Student ${count}`, email, PASSWORD, String(980000 + count)],
  );
  return { id: row.id, cookie: await server.login(email, PASSWORD) };
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 0x20)]);
const PY = Buffer.from('def reverse(items):\n    return items[::-1]\n');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....[Content_Types].xml....word/document.xml....')]);

async function multipart(path, method, cookie, fields, file) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (file) form.append(file.field, new Blob([file.bytes]), file.name);
  const response = await fetch(`${server.baseUrl}/api${path}`, { method, headers: { Cookie: cookie }, body: form });
  return { status: response.status, body: await response.json() };
}
const kst = (offsetDays) => new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
async function createAssignment(fields = {}, attachment = null) {
  const response = await multipart(`/courses/${course.id}/assignments`, 'POST', admin,
    { title: 'Linked lists', instructions: 'Implement a linked list and explain it.', dueDate: kst(7), dueTime: '23:59', maxPoints: '20', ...fields }, attachment);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const title = fields.title ?? 'Linked lists';
  return response.body.data.assignments.filter((a) => a.title === title).at(-1);
}
const submit = (assignmentId, cookie, bytes, name) => multipart(`/assignments/${assignmentId}/submission`, 'PUT', cookie, {}, { field: 'file', bytes, name });
const download = async (path, cookie) => {
  const response = await fetch(`${server.baseUrl}/api${path}`, { headers: { Cookie: cookie } });
  return { status: response.status, type: response.headers.get('content-type'), disposition: response.headers.get('content-disposition'), bytes: Buffer.from(await response.arrayBuffer()) };
};
const mark = (assignmentId, studentId, body) => server.request(`/assignments/${assignmentId}/submissions/${studentId}/mark`, { method: 'PUT', cookie: admin, body });

describe('the content check', () => {
  test('a file must be what its name says', () => {
    assert.equal(checkDocument(PDF, 'report.pdf').extension, 'pdf');
    assert.equal(checkDocument(PY, 'solution.py').extension, 'py');
    assert.equal(checkDocument(DOCX, 'essay.docx').extension, 'docx');
    assert.match(checkDocument(EXE, 'report.pdf').error, /not really a PDF/);
    assert.match(checkDocument(EXE, 'program.exe').error, /Hand in a PDF/);
    assert.match(checkDocument(EXE, 'solution.py').error, /not really a source or text/);
    assert.match(checkDocument(PDF, 'essay.docx').error, /not really a Word/);
    assert.match(checkDocument(Buffer.alloc(0), 'a.txt').error, /empty/);
  });
});

describe('setting assignments (administrators)', () => {
  test('with an attachment students of the course can download; others cannot', async () => {
    const assignment = await createAssignment({ title: 'With a handout' }, { field: 'attachment', bytes: PDF, name: 'handout.pdf' });
    assert.deepEqual(assignment.attachment, { name: 'handout.pdf' });
    const ok = await download(`/assignments/${assignment.id}/attachment`, student.cookie);
    assert.deepEqual([ok.status, ok.type], [200, 'application/pdf']);
    assert.match(ok.disposition, /^attachment; filename="handout\.pdf"/);
    assert.equal((await download(`/assignments/${assignment.id}/attachment`, outsider.cookie)).status, 404);
    const bad = await multipart(`/courses/${course.id}/assignments`, 'POST', admin,
      { title: 'Bad', instructions: 'A handout that is a program.', dueDate: kst(7), dueTime: '23:59', maxPoints: '20' }, { field: 'attachment', bytes: EXE, name: 'handout.pdf' });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error.details.attachment);
  });

  test('fields are checked; students cannot set assignments', async () => {
    const response = await multipart(`/courses/${course.id}/assignments`, 'POST', admin, { title: '', dueDate: 'soon', maxPoints: '0' });
    assert.equal(response.status, 400);
    assert.deepEqual(Object.keys(response.body.error.details).sort(), ['dueDate', 'dueTime', 'instructions', 'maxPoints', 'title']);
    assert.equal((await multipart(`/courses/${course.id}/assignments`, 'POST', student.cookie, { title: 'x' })).status, 403);
  });
});

describe('handing in', () => {
  test('a file is checked by content, can be replaced before the deadline, and only its owner sees it', async () => {
    const assignment = await createAssignment();
    const refused = await submit(assignment.id, student.cookie, EXE, 'solution.py');
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.details.file, /not really/);

    const first = await submit(assignment.id, student.cookie, PDF, 'solution.pdf');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual([first.body.data.assignment.mySubmission.originalName, first.body.data.assignment.mySubmission.isLate], ['solution.pdf', false]);
    const replaced = await submit(assignment.id, student.cookie, PY, 'solution.py');
    assert.equal(replaced.body.data.assignment.mySubmission.originalName, 'solution.py');
    assert.equal(replaced.body.data.assignment.canSubmit, true);

    const own = await download(`/assignments/${assignment.id}/submission/file`, student.cookie);
    assert.deepEqual([own.status, own.type, own.bytes.equals(PY)], [200, 'text/plain; charset=utf-8', true]);
    assert.equal((await download(`/assignments/${assignment.id}/submission/file`, other.cookie)).status, 404, 'no submission of their own');
    assert.equal((await download(`/assignments/${assignment.id}/submissions/${student.id}/file`, other.cookie)).status, 403);
    assert.equal((await download(`/assignments/${assignment.id}/submissions/${student.id}/file`, admin)).status, 200);
    assert.equal((await submit(assignment.id, outsider.cookie, PDF, 'x.pdf')).status, 404, 'not registered for the course');
  });

  test('after the deadline: a first submission is accepted and flagged late; replacing is refused', async () => {
    const assignment = await createAssignment({ title: 'Past due', dueDate: kst(-1), dueTime: '12:00' });
    const late = await submit(assignment.id, other.cookie, PDF, 'late.pdf');
    assert.equal(late.status, 200);
    assert.equal(late.body.data.assignment.mySubmission.isLate, true);
    assert.equal(late.body.data.assignment.canSubmit, false);
    const again = await submit(assignment.id, other.cookie, PDF, 'late-again.pdf');
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'DEADLINE_PASSED');
  });
});

describe('marking, and the course grade', () => {
  test('a mark with feedback: the student sees it, is notified, can no longer replace, and the grade uses it', async () => {
    // The course takes its "Assignments" assessment (weight 30) from the assignments.
    const assessment = (await server.request(`/courses/${course.id}/assessments`, { method: 'POST', cookie: admin, body: { name: 'Assignments', weight: 30, maxPoints: 100, source: 'assignments' } })).body.data.assessment;
    assert.equal(assessment.source, 'assignments');
    const handIn = await createAssignment({ title: 'Marked one', maxPoints: '20' });
    await submit(handIn.id, student.cookie, PDF, 'answer.pdf');

    assert.equal((await mark(handIn.id, student.id, { points: 21 })).status, 400);
    assert.equal((await mark(handIn.id, outsider.id, { points: 10 })).status, 404);
    const marked = await mark(handIn.id, student.id, { points: 17, feedback: 'Good, but explain the reverse step.' });
    assert.equal(marked.status, 200, JSON.stringify(marked.body));
    const row = marked.body.data.students.find((s) => s.id === student.id);
    assert.deepEqual([row.submission.points, row.submission.feedback], [17, 'Good, but explain the reverse step.']);

    const mine = (await server.request(`/courses/${course.id}/assignments`, { cookie: student.cookie })).body.data.assignments.find((a) => a.id === handIn.id);
    assert.deepEqual([mine.mySubmission.points, mine.canSubmit], [17, false]);
    assert.equal((await submit(handIn.id, student.cookie, PDF, 'again.pdf')).body.error.code, 'SUBMISSION_MARKED');
    const { notifications } = (await server.request('/notifications', { cookie: student.cookie })).body.data;
    assert.equal(notifications[0].title, 'Assignment marked');
    assert.equal(notifications[0].message, 'Your submission for ASG101 "Marked one" was marked: 17 out of 20. Feedback: Good, but explain the reverse step.');

    const book = (await server.request(`/courses/${course.id}/gradebook`, { cookie: admin })).body.data;
    const result = book.students.find((s) => s.id === student.id);
    assert.equal(result.marks[assessment.id], 85, '17 of 20 is 85 of 100');
    assert.equal(result.result.total, 25.5, '85% of a weight of 30');
    const entered = await server.request(`/courses/${course.id}/assessments/${assessment.id}/marks`, { method: 'PUT', cookie: admin, body: { marks: [{ studentId: student.id, points: 50 }] } });
    assert.equal(entered.body.error.code, 'MARKS_FROM_ASSIGNMENTS');
    const grades = (await server.request('/grades/mine', { cookie: student.cookie })).body.data;
    const asg = grades.semesters[0].courses.find((c) => c.course.code === 'ASG101');
    assert.equal(asg.assessments.find((a) => a.name === 'Assignments').points, 85);
  });

  test('an assignment with submissions cannot be deleted; one without can', async () => {
    const used = await createAssignment({ title: 'Used' });
    await submit(used.id, student.cookie, PDF, 'a.pdf');
    assert.equal((await server.request(`/courses/${course.id}/assignments/${used.id}`, { method: 'DELETE', cookie: admin })).body.error.code, 'ASSIGNMENT_HAS_SUBMISSIONS');
    const unused = await createAssignment({ title: 'Unused' });
    assert.equal((await server.request(`/courses/${course.id}/assignments/${unused.id}`, { method: 'DELETE', cookie: admin })).status, 200);
  });

  test('the sample: CSE2010 has two assignments, one past due, and students of other courses cannot see them', async () => {
    const jiho = await server.login('jiho.park@kdu.example', PASSWORD);
    const { rows: [cse] } = await server.db.query("SELECT id FROM courses WHERE code = 'CSE2010'");
    const { assignments } = (await server.request(`/courses/${cse.id}/assignments`, { cookie: jiho })).body.data;
    assert.deepEqual(assignments.map((a) => [a.title, a.isPastDue, a.canSubmit]), [['Linked lists', true, true], ['Binary search trees', false, true]]);
    const yuna = await server.login('yuna.choi@kdu.example', PASSWORD);
    assert.equal((await server.request(`/courses/${cse.id}/assignments`, { cookie: yuna })).status, 404);
  });
});
