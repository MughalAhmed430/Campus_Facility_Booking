import multer from 'multer';
import * as assignmentService from '../services/assignment.service.js';
import AppError from '../utils/app-error.js';
import { DOCUMENT_MAX_BYTES, safeDownloadName } from '../utils/document-type.js';
import { FieldValidator, MAX_INTEGER } from '../utils/validation.js';

const INSTRUCTIONS_MAX_LENGTH = 5000;
const FEEDBACK_MAX_LENGTH = 2000;

function parseId(raw, label) {
  const v = new FieldValidator({ id: raw });
  const id = v.integer('id', { label, min: 1, max: MAX_INTEGER });
  v.assertValid();
  return id;
}

/** multer for one file in `field` (at most 10 MB) plus a few text fields, turning its errors into 400s. */
function receive(field) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: DOCUMENT_MAX_BYTES, files: 1, fields: 10, fieldSize: INSTRUCTIONS_MAX_LENGTH * 4 },
  }).single(field);
  return (req, res, next) => upload(req, res, (err) => {
    if (!err) return next();
    const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
      ? `The file must be at most ${DOCUMENT_MAX_BYTES / 1024 / 1024} MB.`
      : `Send the form as multipart/form-data with at most one file, in the field "${field}".`;
    return next(new AppError(400, 'VALIDATION_ERROR', message, { details: { [field]: message }, cause: err }));
  });
}
export const receiveAttachment = receive('attachment');
export const receiveSubmission = receive('file');

/** Multer reads file names as latin1; browsers send UTF-8. */
const originalName = (file) => Buffer.from(file.originalname, 'latin1').toString('utf8');

function sendFile(res, { buffer, type, name }) {
  res.set({
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${safeDownloadName(name).replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safeDownloadName(name))}`,
    'Cache-Control': 'private, no-store',
  });
  res.send(buffer);
}

/** GET /api/courses/:id/assignments -> 200 { assignments } (administrators, or a registered student) */
export async function list(req, res) {
  res.json({ success: true, data: { assignments: await assignmentService.listAssignments(req.user, parseId(req.params.id, 'Course id')) } });
}

function parseAssignment(body) {
  const v = new FieldValidator(body ?? {});
  const date = v.date('dueDate', { label: 'Due date' });
  const time = v.time('dueTime', { label: 'Due time' });
  const maxPoints = v.integer('maxPoints', { label: 'Out of', min: 1, max: 1000 });
  const fields = {
    title: v.string('title', { label: 'Title', max: 150 }),
    instructions: v.string('instructions', { label: 'Instructions', min: 10, max: INSTRUCTIONS_MAX_LENGTH }),
    dueAt: date && time ? `${date}T${time}:00+09:00` : undefined,
    maxPoints,
  };
  v.assertValid();
  return { fields, removeAttachment: body?.removeAttachment === 'true' };
}

/** POST /api/courses/:id/assignments (multipart: title, instructions, dueDate, dueTime, maxPoints, attachment?) -> 201 { assignments } */
export async function create(req, res) {
  const courseId = parseId(req.params.id, 'Course id');
  const { fields } = parseAssignment(req.body);
  const attachment = req.file ? { buffer: req.file.buffer, originalName: originalName(req.file) } : null;
  await assignmentService.saveAssignment(courseId, null, fields, { attachment });
  res.status(201).json({ success: true, data: { assignments: await assignmentService.listAssignments(req.user, courseId) } });
}

/** PUT /api/courses/:id/assignments/:assignmentId (multipart, as create, plus removeAttachment=true) -> 200 { assignments } */
export async function update(req, res) {
  const courseId = parseId(req.params.id, 'Course id');
  const assignmentId = parseId(req.params.assignmentId, 'Assignment id');
  const { fields, removeAttachment } = parseAssignment(req.body);
  const attachment = req.file ? { buffer: req.file.buffer, originalName: originalName(req.file) } : null;
  await assignmentService.saveAssignment(courseId, assignmentId, fields, { attachment, removeAttachment });
  res.json({ success: true, data: { assignments: await assignmentService.listAssignments(req.user, courseId) } });
}

/** DELETE /api/courses/:id/assignments/:assignmentId -> 200 {}, 409 ASSIGNMENT_HAS_SUBMISSIONS */
export async function remove(req, res) {
  await assignmentService.deleteAssignment(parseId(req.params.id, 'Course id'), parseId(req.params.assignmentId, 'Assignment id'));
  res.json({ success: true, data: {} });
}

/** GET /api/assignments/:id/attachment -> the file (download) */
export async function attachment(req, res) {
  sendFile(res, await assignmentService.readAttachment(req.user, parseId(req.params.id, 'Assignment id')));
}

/** PUT /api/assignments/:id/submission (students; multipart, field "file") -> 200 { assignment } */
export async function submit(req, res) {
  const id = parseId(req.params.id, 'Assignment id');
  if (!req.file) throw new AppError(400, 'VALIDATION_ERROR', 'Choose a file to hand in.', { details: { file: 'Choose a file to hand in.' } });
  const assignment = await assignmentService.submit(req.user, id, { buffer: req.file.buffer, originalName: originalName(req.file) });
  res.json({ success: true, data: { assignment } });
}

/** GET /api/assignments/:id/submission/file (students: their own file) */
export async function ownFile(req, res) {
  sendFile(res, await assignmentService.readSubmissionFile(req.user, parseId(req.params.id, 'Assignment id'), req.user.id));
}

/** GET /api/assignments/:id/submissions (administrators) -> 200 { assignment, students } */
export async function submissions(req, res) {
  res.json({ success: true, data: await assignmentService.listSubmissions(parseId(req.params.id, 'Assignment id')) });
}

/** GET /api/assignments/:id/submissions/:studentId/file (administrators) */
export async function studentFile(req, res) {
  sendFile(res, await assignmentService.readSubmissionFile(req.user, parseId(req.params.id, 'Assignment id'), parseId(req.params.studentId, 'Student id')));
}

/** PUT /api/assignments/:id/submissions/:studentId/mark { points, feedback? } (administrators) -> 200 { assignment, students } */
export async function mark(req, res) {
  const id = parseId(req.params.id, 'Assignment id');
  const studentId = parseId(req.params.studentId, 'Student id');
  const v = new FieldValidator(req.body ?? {});
  const raw = req.body?.points;
  const points = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(points) || points < 0 || Math.round(points * 100) !== points * 100) v.addError('points', 'Enter a mark of 0 or more, with at most two decimals.');
  const feedback = v.string('feedback', { label: 'Feedback', required: false, max: FEEDBACK_MAX_LENGTH });
  v.assertValid();
  res.json({ success: true, data: await assignmentService.markSubmission(req.user.id, id, studentId, { points, feedback }) });
}
