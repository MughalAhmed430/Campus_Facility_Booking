import * as gradeService from '../services/grade.service.js';
import AppError from '../utils/app-error.js';
import { FieldValidator, MAX_INTEGER } from '../utils/validation.js';

// Grades: assessments per course, marks, and each student's own results.

function ids(params) {
  const v = new FieldValidator({ id: params.id, assessmentId: params.assessmentId });
  const result = {
    courseId: v.integer('id', { label: 'Course id', min: 1, max: MAX_INTEGER }),
    assessmentId: params.assessmentId === undefined ? null : v.integer('assessmentId', { label: 'Assessment id', min: 1, max: MAX_INTEGER }),
  };
  v.assertValid();
  return result;
}

/** A number with at most two decimals, from 0 (or `min`) to `max`. */
function decimal(v, field, { label, min, max, required = true }) {
  const raw = v.body[field];
  if (raw === undefined || raw === null || raw === '') {
    if (required) v.addError(field, `${label} is required.`);
    return undefined;
  }
  const value = typeof raw === 'number' ? raw : (/^\s*\d+(\.\d+)?\s*$/.test(String(raw)) ? Number(raw) : NaN);
  if (!Number.isFinite(value) || Math.round(value * 100) !== value * 100) {
    v.addError(field, `${label} must be a number with at most two decimals.`);
    return undefined;
  }
  if (value < min || value > max) {
    v.addError(field, `${label} must be from ${min} to ${max}.`);
    return undefined;
  }
  return value;
}

function parseAssessment(body) {
  const v = new FieldValidator(body ?? {});
  const fields = {
    name: v.string('name', { label: 'Name', max: 60 }),
    weight: decimal(v, 'weight', { label: 'Weight', min: 0.01, max: 100 }),
    maxPoints: decimal(v, 'maxPoints', { label: 'Out of', min: 0.01, max: 1000 }),
    source: v.oneOf('source', ['manual', 'assignments'], { label: 'Marks from', required: false }) ?? 'manual',
  };
  v.assertValid();
  return fields;
}

/** GET /api/courses/:id/assessments -> 200 { assessments, weightTotal } (admins, or a registered student) */
export async function list(req, res) {
  const { courseId } = ids(req.params);
  res.json({ success: true, data: await gradeService.listAssessments(req.user, courseId) });
}

/** POST /api/courses/:id/assessments { name, weight, maxPoints } -> 201 { assessment } */
export async function create(req, res) {
  const { courseId } = ids(req.params);
  const assessment = await gradeService.saveAssessment(courseId, null, parseAssessment(req.body));
  res.status(201).json({ success: true, data: { assessment } });
}

/** PUT /api/courses/:id/assessments/:assessmentId -> 200 { assessment } */
export async function update(req, res) {
  const { courseId, assessmentId } = ids(req.params);
  res.json({ success: true, data: { assessment: await gradeService.saveAssessment(courseId, assessmentId, parseAssessment(req.body)) } });
}

/** DELETE /api/courses/:id/assessments/:assessmentId -> 200 {}, 409 ASSESSMENT_HAS_MARKS */
export async function remove(req, res) {
  const { courseId, assessmentId } = ids(req.params);
  await gradeService.deleteAssessment(courseId, assessmentId);
  res.json({ success: true, data: {} });
}

/** GET /api/courses/:id/gradebook (administrators) */
export async function gradebook(req, res) {
  const { courseId } = ids(req.params);
  res.json({ success: true, data: await gradeService.gradebook(courseId) });
}

/**
 * PUT /api/courses/:id/assessments/:assessmentId/marks { marks: [{ studentId, points }] }
 * points null removes the mark. -> 200 (the gradebook), 400 with details["marks.<studentId>"]
 */
export async function saveMarks(req, res) {
  const { courseId, assessmentId } = ids(req.params);
  const list = req.body?.marks;
  if (!Array.isArray(list) || list.length === 0 || list.length > 1000) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Send { "marks": [{ "studentId", "points" }] } with 1 to 1000 entries.');
  }
  const details = {};
  const entries = [];
  const seen = new Set();
  for (const item of list) {
    const v = new FieldValidator(item && typeof item === 'object' && !Array.isArray(item) ? item : {});
    const studentId = v.integer('studentId', { label: 'Student', min: 1, max: MAX_INTEGER });
    const points = item?.points === null ? null : decimal(v, 'points', { label: 'Mark', min: 0, max: 1000 });
    if (studentId === undefined || points === undefined) {
      details[`marks.${item?.studentId ?? '?'}`] = Object.values(v.errors)[0] ?? 'Invalid mark.';
    } else if (seen.has(studentId)) {
      details[`marks.${studentId}`] = 'This student appears twice.';
    } else {
      seen.add(studentId);
      entries.push({ studentId, points });
    }
  }
  if (Object.keys(details).length > 0) throw new AppError(400, 'VALIDATION_ERROR', 'Some marks are invalid.', { details });
  res.json({ success: true, data: await gradeService.saveMarks(req.user.id, courseId, assessmentId, entries) });
}

/** GET /api/grades/mine (students) -> 200 { semesters, cgpa, creditsEarned, scale } */
export async function mine(req, res) {
  res.json({ success: true, data: await gradeService.myGrades(req.user.id) });
}

/** GET /api/grades/scale -> 200 { scale } */
export function scale(req, res) {
  res.json({ success: true, data: { scale: gradeService.GRADE_SCALE } });
}
