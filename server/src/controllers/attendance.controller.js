import * as attendanceService from '../services/attendance.service.js';
import { ATTENDANCE_STATUSES, WARNING_BELOW_PERCENT } from '../services/attendance.service.js';
import * as courseService from '../services/course.service.js';
import AppError from '../utils/app-error.js';
import { FieldValidator, MAX_INTEGER } from '../utils/validation.js';

function parseId(raw, label) {
  const v = new FieldValidator({ id: raw });
  const id = v.integer('id', { label, min: 1, max: MAX_INTEGER });
  v.assertValid();
  return id;
}

/** GET /api/courses/:id/sessions (administrators) -> 200 { course, sessions } (those that have started) */
export async function sessions(req, res) {
  res.json({ success: true, data: await attendanceService.listSessions(parseId(req.params.id, 'Course id')) });
}

/** GET /api/sessions/:id/attendance (administrators) -> 200 { session, students } */
export async function show(req, res) {
  res.json({ success: true, data: await attendanceService.getSessionAttendance(parseId(req.params.id, 'Lecture id')) });
}

/**
 * PUT /api/sessions/:id/attendance { records: [{ studentId, status }] } (administrators)
 * status: present | absent | excused, or null to remove the mark.
 * -> 200 { session, students }, 409 SESSION_NOT_STARTED, 400
 */
export async function save(req, res) {
  const sessionId = parseId(req.params.id, 'Lecture id');
  const list = req.body?.records;
  if (!Array.isArray(list) || list.length === 0 || list.length > 1000) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Send { "records": [{ "studentId", "status" }] } with 1 to 1000 entries.');
  }
  const details = {};
  const records = [];
  const seen = new Set();
  for (const item of list) {
    const v = new FieldValidator(item && typeof item === 'object' && !Array.isArray(item) ? item : {});
    const studentId = v.integer('studentId', { label: 'Student', min: 1, max: MAX_INTEGER });
    const status = item?.status === null ? null : v.oneOf('status', ATTENDANCE_STATUSES, { label: 'Attendance' });
    if (studentId === undefined || status === undefined) details[`records.${item?.studentId ?? '?'}`] = Object.values(v.errors)[0];
    else if (seen.has(studentId)) details[`records.${studentId}`] = 'This student appears twice.';
    else {
      seen.add(studentId);
      records.push({ studentId, status });
    }
  }
  if (Object.keys(details).length > 0) throw new AppError(400, 'VALIDATION_ERROR', 'Some attendance marks are invalid.', { details });
  res.json({ success: true, data: await attendanceService.saveSessionAttendance(req.user.id, sessionId, records) });
}

/** GET /api/courses/:id/attendance-report (administrators) -> 200 { course, students, warnings, warningBelowPercent } */
export async function report(req, res) {
  res.json({ success: true, data: await attendanceService.courseReport(parseId(req.params.id, 'Course id')) });
}

/** GET /api/attendance/mine?semester= (students) -> 200 { semester, courses, warningBelowPercent } */
export async function mine(req, res) {
  const v = new FieldValidator(req.query);
  const semesterId = v.integer('semester', { label: 'Semester', required: false, min: 1, max: MAX_INTEGER });
  v.assertValid();
  const { semester } = await courseService.listCourses(req.user, { semesterId });
  const courses = semester ? await attendanceService.myAttendance(req.user.id, semester.id) : [];
  res.json({ success: true, data: { semester, courses, warningBelowPercent: WARNING_BELOW_PERCENT } });
}
