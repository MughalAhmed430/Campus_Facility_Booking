import { query, withTransaction } from '../db/pool.js';
import AppError from '../utils/app-error.js';
import { assignmentFractions } from './assignment.service.js';

/**
 * THE GRADE SCALE (the 4.5 scale used by Korean universities; documented in README.md).
 * A course total (0 to 100, the weighted sum of its assessments) gets the first letter
 * whose minimum it reaches. Grade points are what the GPA averages.
 */
export const GRADE_SCALE = Object.freeze([
  { letter: 'A+', min: 95, points: 4.5 },
  { letter: 'A', min: 90, points: 4.0 },
  { letter: 'B+', min: 85, points: 3.5 },
  { letter: 'B', min: 80, points: 3.0 },
  { letter: 'C+', min: 75, points: 2.5 },
  { letter: 'C', min: 70, points: 2.0 },
  { letter: 'D+', min: 65, points: 1.5 },
  { letter: 'D', min: 60, points: 1.0 },
  { letter: 'F', min: 0, points: 0 },
]);

const round2 = (value) => Math.round(value * 100) / 100;

export function letterFor(total) {
  return GRADE_SCALE.find((grade) => total >= grade.min);
}

/**
 * The result of one student in one course. assessments: [{ id, weight, maxPoints }];
 * marks: Map assessmentId -> points.
 *   total       the weighted points earned so far, out of 100 (null with no marks)
 *   markedWeight how much of the 100 has been marked
 *   complete    every assessment marked and the weights add up to 100: only then is
 *               there a letter grade, and only then does the course count in the GPA
 */
export function courseResult(assessments, marks) {
  const weightTotal = round2(assessments.reduce((sum, a) => sum + a.weight, 0));
  const marked = assessments.filter((a) => marks.has(a.id));
  const total = marked.length === 0 ? null : round2(marked.reduce((sum, a) => sum + (marks.get(a.id) / a.maxPoints) * a.weight, 0));
  const complete = assessments.length > 0 && weightTotal === 100 && marked.length === assessments.length;
  const grade = complete ? letterFor(total) : null;
  return {
    total,
    markedWeight: round2(marked.reduce((sum, a) => sum + a.weight, 0)),
    complete,
    letter: grade?.letter ?? null,
    gradePoints: grade?.points ?? null,
  };
}

/** Credit-weighted average of the grade points of complete courses; null with none. */
export function gpaOf(results) {
  const counted = results.filter((result) => result.complete);
  const credits = counted.reduce((sum, result) => sum + result.credits, 0);
  if (credits === 0) return null;
  return round2(counted.reduce((sum, result) => sum + result.gradePoints * result.credits, 0) / credits);
}

function toAssessment(row) {
  return { id: row.id, name: row.name, weight: Number(row.weight), maxPoints: Number(row.max_points), position: row.position, source: row.source };
}

/**
 * Fills in the marks of assessments whose source is 'assignments': the student's average
 * over their marked assignments in the course, scaled to the assessment's maximum.
 * marks: Map assessmentId -> points, changed in place.
 */
function addAssignmentMarks(courseId, studentId, assessments, marks, fractions) {
  const fraction = fractions.get(`${courseId}:${studentId}`);
  for (const assessment of assessments) {
    if (assessment.source !== 'assignments') continue;
    if (fraction === undefined) marks.delete(assessment.id);
    else marks.set(assessment.id, round2(fraction * assessment.maxPoints));
  }
}

const courseNotFound = () => new AppError(404, 'COURSE_NOT_FOUND', 'This course does not exist.');
const assessmentNotFound = () => new AppError(404, 'ASSESSMENT_NOT_FOUND', 'This assessment does not exist.');

async function assessmentsOf(courseIds, runner = { query }) {
  const { rows } = await runner.query(
    'SELECT id, course_id, name, weight, max_points, position, source FROM assessments WHERE course_id = ANY($1::int[]) ORDER BY position, id',
    [courseIds],
  );
  return rows;
}

/**
 * A course's assessments, with weightTotal. Administrators see any course; a student
 * only one they are registered for (404 otherwise, as for a course that does not exist).
 */
export async function listAssessments(viewer, courseId) {
  const { rows: [course] } = await query(
    `SELECT c.id,
            EXISTS (SELECT 1 FROM course_registrations r WHERE r.course_id = c.id AND r.student_id = $2 AND r.status = 'registered') AS mine
     FROM courses c WHERE c.id = $1`,
    [courseId, viewer.id],
  );
  if (!course || (viewer.role !== 'admin' && !course.mine)) throw courseNotFound();
  const assessments = (await assessmentsOf([courseId])).map(toAssessment);
  return { assessments, weightTotal: round2(assessments.reduce((sum, a) => sum + a.weight, 0)) };
}

/**
 * Adds or changes an assessment, keeping the course's weights at 100 or less (the
 * course row is locked, so two administrators cannot both push it past 100).
 * 409 WEIGHTS_OVER_100, 409 ASSESSMENT_NAME_TAKEN. Lowering max points below a mark
 * already given is refused: 409 MARKS_ABOVE_MAX.
 */
export async function saveAssessment(courseId, assessmentId, { name, weight, maxPoints, source = 'manual' }) {
  try {
    return await withTransaction(async (tx) => {
      const { rows: [course] } = await tx.query('SELECT id FROM courses WHERE id = $1 FOR UPDATE', [courseId]);
      if (!course) throw courseNotFound();
      const { rows: [{ others }] } = await tx.query(
        'SELECT COALESCE(sum(weight), 0) AS others FROM assessments WHERE course_id = $1 AND ($2::int IS NULL OR id <> $2::int)',
        [courseId, assessmentId],
      );
      if (round2(Number(others) + weight) > 100) {
        const message = `The weights would add up to ${round2(Number(others) + weight)}. At most ${round2(100 - Number(others))} is left for this one.`;
        throw new AppError(409, 'WEIGHTS_OVER_100', message, { details: { weight: message } });
      }
      if (assessmentId === null) {
        const { rows: [row] } = await tx.query(
          `INSERT INTO assessments (course_id, name, weight, max_points, source, position)
           VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(max(position), 0) + 1 FROM assessments WHERE course_id = $1))
           RETURNING id, name, weight, max_points, position, source`,
          [courseId, name, weight, maxPoints, source],
        );
        return toAssessment(row);
      }
      const { rows: [above] } = await tx.query(
        'SELECT 1 FROM marks WHERE assessment_id = $1 AND points > $2 LIMIT 1', [assessmentId, maxPoints],
      );
      if (source === 'assignments') {
        const { rows: [entered] } = await tx.query('SELECT 1 FROM marks WHERE assessment_id = $1 LIMIT 1', [assessmentId]);
        if (entered) {
          const message = 'Marks were entered by hand for this assessment. Remove them before taking the marks from assignments.';
          throw new AppError(409, 'ASSESSMENT_HAS_MARKS', message, { details: { source: message } });
        }
      }
      if (above) {
        const message = 'Some marks are higher than this. Change those marks first.';
        throw new AppError(409, 'MARKS_ABOVE_MAX', message, { details: { maxPoints: message } });
      }
      const { rows: [row] } = await tx.query(
        `UPDATE assessments SET name = $3, weight = $4, max_points = $5, source = $6
         WHERE id = $1 AND course_id = $2 RETURNING id, name, weight, max_points, position, source`,
        [assessmentId, courseId, name, weight, maxPoints, source],
      );
      if (!row) throw assessmentNotFound();
      return toAssessment(row);
    });
  } catch (err) {
    if (err.code === '23505') {
      const message = 'This course already has an assessment with this name.';
      throw new AppError(409, 'ASSESSMENT_NAME_TAKEN', message, { details: { name: message }, cause: err });
    }
    throw err;
  }
}

/** Deletes an assessment that has no marks yet. 409 ASSESSMENT_HAS_MARKS otherwise. */
export async function deleteAssessment(courseId, assessmentId) {
  try {
    const { rows } = await query('DELETE FROM assessments WHERE id = $1 AND course_id = $2 RETURNING id', [assessmentId, courseId]);
    if (rows.length === 0) throw assessmentNotFound();
  } catch (err) {
    if (err.code === '23001' || err.code === '23503') {
      throw new AppError(409, 'ASSESSMENT_HAS_MARKS', 'Marks have been entered for this assessment, so it cannot be deleted. Remove the marks first.', { cause: err });
    }
    throw err;
  }
}

/**
 * Administrators: the course's gradebook. Every registered student with their marks and
 * result. { course, assessments, weightTotal, students: [{ id, fullName, studentNumber, marks, result }] }
 */
export async function gradebook(courseId) {
  const { rows: [course] } = await query('SELECT id, code, title, credits FROM courses WHERE id = $1', [courseId]);
  if (!course) throw courseNotFound();
  const assessments = (await assessmentsOf([courseId])).map(toAssessment);
  const { rows: students } = await query(
    `SELECT u.id, u.full_name, u.student_number,
            COALESCE((SELECT json_object_agg(m.assessment_id, m.points)
                      FROM marks m JOIN assessments a ON a.id = m.assessment_id
                      WHERE a.course_id = r.course_id AND m.student_id = u.id), '{}'::json) AS marks
     FROM course_registrations r
     JOIN users u ON u.id = r.student_id
     WHERE r.course_id = $1 AND r.status = 'registered'
     ORDER BY u.full_name, u.id`,
    [courseId],
  );
  const fractions = await assignmentFractions([courseId]);
  return {
    course: { id: course.id, code: course.code, title: course.title, credits: course.credits },
    assessments,
    weightTotal: round2(assessments.reduce((sum, a) => sum + a.weight, 0)),
    scale: GRADE_SCALE,
    students: students.map((row) => {
      const marks = new Map(Object.entries(row.marks).map(([id, points]) => [Number(id), Number(points)]));
      addAssignmentMarks(courseId, row.id, assessments, marks, fractions);
      return {
        id: row.id,
        fullName: row.full_name,
        studentNumber: row.student_number,
        marks: Object.fromEntries(marks),
        result: courseResult(assessments, marks),
      };
    }),
  };
}

/**
 * Saves marks for one assessment: entries [{ studentId, points }] (points null removes a
 * mark). All or nothing, in one transaction. Every student must be registered for the
 * course, and points must be from 0 to the assessment's max: 400 otherwise, saying which.
 */
export async function saveMarks(adminId, courseId, assessmentId, entries) {
  await withTransaction(async (tx) => {
    const { rows: [assessment] } = await tx.query(
      'SELECT id, max_points, source FROM assessments WHERE id = $1 AND course_id = $2 FOR SHARE', [assessmentId, courseId],
    );
    if (!assessment) throw assessmentNotFound();
    if (assessment.source === 'assignments') {
      throw new AppError(409, 'MARKS_FROM_ASSIGNMENTS', 'This assessment takes its marks from the course\'s assignments: mark the submissions instead.');
    }
    const max = Number(assessment.max_points);
    const { rows: registered } = await tx.query(
      "SELECT student_id FROM course_registrations WHERE course_id = $1 AND status = 'registered' AND student_id = ANY($2::int[])",
      [courseId, entries.map((entry) => entry.studentId)],
    );
    const known = new Set(registered.map((row) => row.student_id));
    const details = {};
    for (const entry of entries) {
      if (!known.has(entry.studentId)) details[`marks.${entry.studentId}`] = 'This student is not registered for the course.';
      else if (entry.points !== null && (entry.points < 0 || entry.points > max)) details[`marks.${entry.studentId}`] = `Enter a mark from 0 to ${max}.`;
    }
    if (Object.keys(details).length > 0) throw new AppError(400, 'VALIDATION_ERROR', 'Some marks are invalid.', { details });

    const remove = entries.filter((entry) => entry.points === null).map((entry) => entry.studentId);
    const save = entries.filter((entry) => entry.points !== null);
    if (remove.length > 0) {
      await tx.query('DELETE FROM marks WHERE assessment_id = $1 AND student_id = ANY($2::int[])', [assessmentId, remove]);
    }
    if (save.length > 0) {
      await tx.query(
        `INSERT INTO marks (assessment_id, student_id, points, entered_by)
         SELECT $1, entry.student_id, entry.points, $2
         FROM unnest($3::int[], $4::numeric[]) AS entry (student_id, points)
         ON CONFLICT (assessment_id, student_id)
         DO UPDATE SET points = EXCLUDED.points, entered_by = EXCLUDED.entered_by, updated_at = now()`,
        [assessmentId, adminId, save.map((entry) => entry.studentId), save.map((entry) => entry.points)],
      );
    }
  });
  return gradebook(courseId);
}

/**
 * A student's own grades, every semester they took courses in, latest first: each course
 * with its assessments, their marks and the result; the semester GPA; and the CGPA over
 * every complete course. Only the student's own marks are ever read.
 */
export async function myGrades(studentId) {
  const { rows: courses } = await query(
    `SELECT c.id, c.code, c.title, c.credits,
            s.id AS semester_id, s.name AS semester_name,
            to_char(s.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(s.ends_on, 'YYYY-MM-DD') AS ends_on
     FROM course_registrations r
     JOIN courses c ON c.id = r.course_id
     JOIN semesters s ON s.id = c.semester_id
     WHERE r.student_id = $1 AND r.status = 'registered'
     ORDER BY s.starts_on DESC, c.code`,
    [studentId],
  );
  const assessmentRows = await assessmentsOf(courses.map((course) => course.id));
  const { rows: markRows } = await query(
    'SELECT assessment_id, points FROM marks WHERE student_id = $1 AND assessment_id = ANY($2::int[])',
    [studentId, assessmentRows.map((row) => row.id)],
  );
  const marks = new Map(markRows.map((row) => [row.assessment_id, Number(row.points)]));
  const fractions = await assignmentFractions(courses.map((course) => course.id), [studentId]);

  const semesters = [];
  for (const course of courses) {
    let semester = semesters.find((item) => item.semester.id === course.semester_id);
    if (!semester) {
      semester = { semester: { id: course.semester_id, name: course.semester_name, startsOn: course.starts_on, endsOn: course.ends_on }, courses: [] };
      semesters.push(semester);
    }
    const assessments = assessmentRows.filter((row) => row.course_id === course.id).map(toAssessment);
    const mine = new Map(assessments.filter((a) => marks.has(a.id)).map((a) => [a.id, marks.get(a.id)]));
    addAssignmentMarks(course.id, studentId, assessments, mine, fractions);
    semester.courses.push({
      course: { id: course.id, code: course.code, title: course.title, credits: course.credits },
      assessments: assessments.map((a) => ({ ...a, points: mine.has(a.id) ? mine.get(a.id) : null })),
      ...courseResult(assessments, mine),
      credits: course.credits,
    });
  }
  const all = semesters.flatMap((item) => item.courses);
  return {
    semesters: semesters.map((item) => ({
      ...item,
      gpa: gpaOf(item.courses),
      credits: item.courses.reduce((sum, course) => sum + course.credits, 0),
      creditsEarned: item.courses.filter((course) => course.complete && course.letter !== 'F').reduce((sum, course) => sum + course.credits, 0),
    })),
    cgpa: gpaOf(all),
    creditsEarned: all.filter((course) => course.complete && course.letter !== 'F').reduce((sum, course) => sum + course.credits, 0),
    scale: GRADE_SCALE,
  };
}
