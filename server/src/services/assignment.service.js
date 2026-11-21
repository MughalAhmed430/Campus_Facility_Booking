import { query, withTransaction } from '../db/pool.js';
import AppError from '../utils/app-error.js';
import { currentInstant } from '../utils/campus-time.js';
import { checkDocument, servedTypeOf, extensionOf } from '../utils/document-type.js';
import { deleteStoredFile, readStoredFile, saveFile } from '../utils/file-storage.js';

// Assignments per course, set by the academic office (an administrator), and students'
// submissions: one file each, replaceable until the deadline; a first submission after it
// is still accepted and flagged late. Files are stored outside the public folder and
// served only to the student who handed one in or an administrator.

const ATTACHMENTS = 'assignments';
const SUBMISSIONS = 'submissions';

const courseNotFound = () => new AppError(404, 'COURSE_NOT_FOUND', 'This course does not exist.');
const assignmentNotFound = () => new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'This assignment does not exist.');
const fileError = (field, message) => new AppError(400, 'VALIDATION_ERROR', message, { details: { [field]: message } });

/** Is the viewer allowed to see this course's assignments: an administrator, or a student registered for it? */
async function canSeeCourse(viewer, courseId) {
  const { rows: [row] } = await query(
    `SELECT EXISTS (SELECT 1 FROM courses WHERE id = $1) AS course,
            EXISTS (SELECT 1 FROM course_registrations WHERE course_id = $1 AND student_id = $2 AND status = 'registered') AS mine`,
    [courseId, viewer.id],
  );
  if (!row.course || (viewer.role !== 'admin' && !row.mine)) throw courseNotFound();
}

function toAssignment(row, now) {
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    instructions: row.instructions,
    dueAt: row.due_at.toISOString(),
    isPastDue: row.due_at <= now,
    maxPoints: Number(row.max_points),
    attachment: row.attachment_name ? { name: row.attachment_name } : null,
    createdAt: row.created_at.toISOString(),
  };
}

function toSubmission(row) {
  if (!row?.submitted_at) return null;
  return {
    originalName: row.original_name,
    sizeBytes: row.size_bytes,
    submittedAt: row.submitted_at.toISOString(),
    isLate: row.is_late,
    points: row.points === null ? null : Number(row.points),
    feedback: row.feedback,
    markedAt: row.marked_at ? row.marked_at.toISOString() : null,
  };
}

/** What a student may still do with their submission. */
function submissionRules(assignment, submission) {
  if (submission?.markedAt) return { canSubmit: false, why: 'Your submission has been marked.' };
  if (submission && assignment.isPastDue) return { canSubmit: false, why: 'The deadline has passed, so it can no longer be replaced.' };
  return { canSubmit: true, why: null };
}

/**
 * A course's assignments, soonest due first. For a student, each has `mySubmission`,
 * `canSubmit` and `why`; for an administrator, how many were handed in and marked.
 */
export async function listAssignments(viewer, courseId) {
  await canSeeCourse(viewer, courseId);
  const now = currentInstant();
  const { rows } = await query(
    `SELECT a.*, s.original_name, s.size_bytes, s.submitted_at, s.is_late, s.points, s.feedback, s.marked_at,
            (SELECT count(*)::int FROM submissions x WHERE x.assignment_id = a.id) AS submitted,
            (SELECT count(*)::int FROM submissions x WHERE x.assignment_id = a.id AND x.points IS NOT NULL) AS marked
     FROM assignments a
     LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = $2
     WHERE a.course_id = $1
     ORDER BY a.due_at, a.id`,
    [courseId, viewer.id],
  );
  return rows.map((row) => {
    const assignment = toAssignment(row, now);
    if (viewer.role === 'admin') return { ...assignment, submitted: row.submitted, marked: row.marked };
    const mySubmission = toSubmission(row);
    return { ...assignment, mySubmission, ...submissionRules(assignment, mySubmission) };
  });
}

async function findAssignment(id, runner = { query }) {
  const { rows: [row] } = await runner.query('SELECT * FROM assignments WHERE id = $1', [id]);
  if (!row) throw assignmentNotFound();
  return row;
}

/**
 * Creates or replaces an assignment: { title, instructions, dueAt, maxPoints }, and an
 * optional attachment { buffer, originalName } (checked like a submission). removeAttachment
 * drops the current one. The new file is saved before the database points at it.
 */
export async function saveAssignment(courseId, assignmentId, fields, { attachment = null, removeAttachment = false } = {}) {
  let stored = null;
  if (attachment) {
    const checked = checkDocument(attachment.buffer, attachment.originalName);
    if (checked.error) throw fileError('attachment', checked.error);
    stored = await saveFile(ATTACHMENTS, attachment.buffer, checked.extension);
  }
  let previous = null;
  try {
    const id = await withTransaction(async (tx) => {
      const { rows: [course] } = await tx.query('SELECT id FROM courses WHERE id = $1', [courseId]);
      if (!course) throw courseNotFound();
      if (assignmentId === null) {
        const { rows: [row] } = await tx.query(
          `INSERT INTO assignments (course_id, title, instructions, due_at, max_points, attachment_file, attachment_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [courseId, fields.title, fields.instructions, fields.dueAt, fields.maxPoints, stored, stored ? attachment.originalName.slice(0, 255) : null],
        );
        return row.id;
      }
      const { rows: [current] } = await tx.query('SELECT attachment_file, attachment_name FROM assignments WHERE id = $1 AND course_id = $2 FOR UPDATE', [assignmentId, courseId]);
      if (!current) throw assignmentNotFound();
      const { rows: [above] } = await tx.query('SELECT 1 FROM submissions WHERE assignment_id = $1 AND points > $2 LIMIT 1', [assignmentId, fields.maxPoints]);
      if (above) {
        throw new AppError(409, 'MARKS_ABOVE_MAX', 'Some submissions have a higher mark than this.', { details: { maxPoints: 'Some submissions have a higher mark than this.' } });
      }
      const keep = !stored && !removeAttachment;
      if (!keep) previous = current.attachment_file;
      await tx.query(
        `UPDATE assignments SET title = $2, instructions = $3, due_at = $4, max_points = $5, attachment_file = $6, attachment_name = $7
         WHERE id = $1`,
        [assignmentId, fields.title, fields.instructions, fields.dueAt, fields.maxPoints,
          keep ? current.attachment_file : stored, keep ? current.attachment_name : (stored ? attachment.originalName.slice(0, 255) : null)],
      );
      return assignmentId;
    });
    if (previous) await deleteStoredFile(ATTACHMENTS, previous);
    return id;
  } catch (err) {
    if (stored) await deleteStoredFile(ATTACHMENTS, stored);
    throw err;
  }
}

/** Deletes an assignment nobody has handed in. 409 ASSIGNMENT_HAS_SUBMISSIONS otherwise. */
export async function deleteAssignment(courseId, assignmentId) {
  let file;
  try {
    file = await withTransaction(async (tx) => {
      const { rows: [row] } = await tx.query('DELETE FROM assignments WHERE id = $1 AND course_id = $2 RETURNING attachment_file', [assignmentId, courseId]);
      if (!row) throw assignmentNotFound();
      return row.attachment_file;
    });
  } catch (err) {
    if (err.code === '23001' || err.code === '23503') {
      throw new AppError(409, 'ASSIGNMENT_HAS_SUBMISSIONS', 'Students have handed this assignment in, so it cannot be deleted.', { cause: err });
    }
    throw err;
  }
  if (file) await deleteStoredFile(ATTACHMENTS, file);
}

async function readFile(area, name, originalName) {
  const buffer = name ? await readStoredFile(area, name) : null;
  if (!buffer) throw new AppError(404, 'FILE_NOT_FOUND', 'This file is not available.');
  return { buffer, type: servedTypeOf(extensionOf(name)), name: originalName };
}

/** The assignment's attachment, for an administrator or a student registered for the course. */
export async function readAttachment(viewer, assignmentId) {
  const assignment = await findAssignment(assignmentId);
  await canSeeCourse(viewer, assignment.course_id);
  return readFile(ATTACHMENTS, assignment.attachment_file, assignment.attachment_name);
}

/**
 * Hands in (or replaces) the student's file. Refused: 404 when they are not registered for
 * the course; 409 SUBMISSION_MARKED once marked; 409 DEADLINE_PASSED when replacing after
 * the deadline. A first submission after the deadline is accepted and flagged late.
 * The new file is saved first; the replaced one is deleted after the database changed.
 */
export async function submit(viewer, assignmentId, { buffer, originalName }) {
  const checked = checkDocument(buffer, originalName);
  if (checked.error) throw fileError('file', checked.error);
  const assignment = await findAssignment(assignmentId);
  await canSeeCourse(viewer, assignment.course_id);
  const stored = await saveFile(SUBMISSIONS, buffer, checked.extension);
  let previous = null;
  try {
    await withTransaction(async (tx) => {
      const now = currentInstant();
      const { rows: [current] } = await tx.query(
        'SELECT file, marked_at FROM submissions WHERE assignment_id = $1 AND student_id = $2 FOR UPDATE',
        [assignmentId, viewer.id],
      );
      if (current?.marked_at) throw new AppError(409, 'SUBMISSION_MARKED', 'Your submission has been marked, so it can no longer be replaced.');
      if (current && assignment.due_at <= now) throw new AppError(409, 'DEADLINE_PASSED', 'The deadline has passed, so your submission can no longer be replaced.');
      previous = current?.file ?? null;
      await tx.query(
        `INSERT INTO submissions (assignment_id, student_id, file, original_name, size_bytes, submitted_at, is_late)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (assignment_id, student_id) DO UPDATE
           SET file = EXCLUDED.file, original_name = EXCLUDED.original_name, size_bytes = EXCLUDED.size_bytes,
               submitted_at = EXCLUDED.submitted_at, is_late = EXCLUDED.is_late`,
        [assignmentId, viewer.id, stored, originalName.slice(0, 255), buffer.length, now.toISOString(), assignment.due_at <= now],
      );
    });
  } catch (err) {
    await deleteStoredFile(SUBMISSIONS, stored);
    throw err;
  }
  if (previous) await deleteStoredFile(SUBMISSIONS, previous);
  const assignments = await listAssignments(viewer, assignment.course_id);
  return assignments.find((item) => item.id === assignmentId);
}

/** A submission's file: the student's own, or anyone's for an administrator (404 otherwise). */
export async function readSubmissionFile(viewer, assignmentId, studentId) {
  if (viewer.role !== 'admin' && viewer.id !== studentId) throw new AppError(404, 'FILE_NOT_FOUND', 'This file is not available.');
  const { rows: [row] } = await query('SELECT file, original_name FROM submissions WHERE assignment_id = $1 AND student_id = $2', [assignmentId, studentId]);
  if (!row) throw new AppError(404, 'FILE_NOT_FOUND', 'This file is not available.');
  return readFile(SUBMISSIONS, row.file, row.original_name);
}

/** Administrators: every registered student of the assignment's course, with their submission (or none). */
export async function listSubmissions(assignmentId) {
  const assignment = await findAssignment(assignmentId);
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.student_number, s.original_name, s.size_bytes, s.submitted_at, s.is_late, s.points, s.feedback, s.marked_at
     FROM course_registrations r
     JOIN users u ON u.id = r.student_id
     LEFT JOIN submissions s ON s.assignment_id = $1 AND s.student_id = u.id
     WHERE r.course_id = $2 AND r.status = 'registered'
     ORDER BY u.full_name, u.id`,
    [assignmentId, assignment.course_id],
  );
  return {
    assignment: toAssignment(assignment, currentInstant()),
    students: rows.map((row) => ({ id: row.id, fullName: row.full_name, studentNumber: row.student_number, submission: toSubmission(row) })),
  };
}

/**
 * Administrators: marks a submission { points (0 to the assignment's max), feedback }.
 * The student is notified in the same transaction. 404 when there is no submission.
 */
export async function markSubmission(adminId, assignmentId, studentId, { points, feedback }) {
  await withTransaction(async (tx) => {
    const assignment = await findAssignment(assignmentId, tx);
    const max = Number(assignment.max_points);
    if (points > max) throw new AppError(400, 'VALIDATION_ERROR', `Enter a mark from 0 to ${max}.`, { details: { points: `Enter a mark from 0 to ${max}.` } });
    const { rows } = await tx.query(
      `UPDATE submissions SET points = $3, feedback = $4, marked_by = $5, marked_at = now()
       WHERE assignment_id = $1 AND student_id = $2 RETURNING student_id`,
      [assignmentId, studentId, points, feedback ?? null, adminId],
    );
    if (rows.length === 0) throw new AppError(404, 'SUBMISSION_NOT_FOUND', 'This student has not handed it in.');
    await tx.query(
      `INSERT INTO notifications (user_id, assignment_id, type, title, message)
       SELECT $2, a.id, 'assignment_marked', 'Assignment marked',
              'Your submission for ' || c.code || ' "' || a.title || '" was marked: ' || trim_scale($3::numeric) || ' out of ' || trim_scale(a.max_points) || '.'
              || COALESCE(' Feedback: ' || $4::text, '')
       FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = $1`,
      [assignmentId, studentId, points, feedback ?? null],
    );
  });
  return listSubmissions(assignmentId);
}

/**
 * For grades: each student's assignment mark in each course, as a fraction from 0 to 1:
 * the average of (points ÷ out of) over their marked submissions. Map 'courseId:studentId'
 * -> fraction. A student with no marked submission has none.
 */
export async function assignmentFractions(courseIds, studentIds = null) {
  const { rows } = await query(
    `SELECT a.course_id, s.student_id, avg(s.points / a.max_points) AS fraction
     FROM submissions s JOIN assignments a ON a.id = s.assignment_id
     WHERE a.course_id = ANY($1::int[]) AND s.points IS NOT NULL
       AND ($2::int[] IS NULL OR s.student_id = ANY($2::int[]))
     GROUP BY a.course_id, s.student_id`,
    [courseIds, studentIds],
  );
  return new Map(rows.map((row) => [`${row.course_id}:${row.student_id}`, Number(row.fraction)]));
}
