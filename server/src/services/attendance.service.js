import { query, withTransaction } from '../db/pool.js';
import AppError from '../utils/app-error.js';
import { currentInstant } from '../utils/campus-time.js';

// Attendance, per lecture session (the dated lectures generated from each course's weekly
// times). The administrator marks each registered student present, absent or excused, and
// can change it later.
//
// THE RATE: present ÷ (present + absent). Excused sessions are left out of the count, and
// sessions not marked yet do not count at all. Below WARNING_BELOW_PERCENT the student is
// warned. Documented in README.md.

export const ATTENDANCE_STATUSES = Object.freeze(['present', 'absent', 'excused']);
export const WARNING_BELOW_PERCENT = 80;

/** { present, absent, excused } -> { ...counts, recorded, ratePercent (null if none), warning } */
export function attendanceSummary({ present = 0, absent = 0, excused = 0 }) {
  const counted = present + absent;
  const ratePercent = counted === 0 ? null : Math.round((present / counted) * 1000) / 10;
  return {
    present, absent, excused,
    recorded: present + absent + excused,
    ratePercent,
    warning: ratePercent !== null && ratePercent < WARNING_BELOW_PERCENT,
  };
}

const courseNotFound = () => new AppError(404, 'COURSE_NOT_FOUND', 'This course does not exist.');
const sessionNotFound = () => new AppError(404, 'SESSION_NOT_FOUND', 'This lecture does not exist.');

/**
 * Administrators: a course's lecture sessions that have started (attendance can only be
 * taken for those), latest first, each with how many students are marked.
 */
export async function listSessions(courseId) {
  const { rows: [course] } = await query(
    `SELECT c.id, c.code, c.title,
            (SELECT count(*)::int FROM course_registrations r WHERE r.course_id = c.id AND r.status = 'registered') AS registered
     FROM courses c WHERE c.id = $1`,
    [courseId],
  );
  if (!course) throw courseNotFound();
  const { rows } = await query(
    `SELECT ls.id,
            to_char(ls.start_time AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS date,
            to_char(ls.start_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS starts,
            to_char(ls.end_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS ends,
            f.name AS facility_name, bl.code AS building_code, f.room_number,
            count(a.student_id)::int AS marked,
            count(a.student_id) FILTER (WHERE a.status = 'present')::int AS present
     FROM lecture_sessions ls
     JOIN facilities f ON f.id = ls.facility_id
     JOIN buildings bl ON bl.id = f.building_id
     LEFT JOIN attendance a ON a.session_id = ls.id
     WHERE ls.course_id = $1 AND ls.start_time <= $2::timestamptz
     GROUP BY ls.id, f.name, bl.code, f.room_number
     ORDER BY ls.start_time DESC`,
    [courseId, currentInstant().toISOString()],
  );
  return {
    course: { id: course.id, code: course.code, title: course.title, registered: course.registered },
    sessions: rows.map((row) => ({
      id: row.id, date: row.date, startTime: row.starts, endTime: row.ends,
      room: `${row.building_code} ${row.room_number}`, roomName: row.facility_name,
      marked: row.marked, present: row.present,
    })),
  };
}

async function findSession(sessionId, runner = { query }) {
  const { rows: [session] } = await runner.query(
    `SELECT ls.id, ls.course_id, ls.start_time <= $2::timestamptz AS has_started,
            to_char(ls.start_time AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS date,
            to_char(ls.start_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS starts,
            to_char(ls.end_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS ends,
            c.code, c.title
     FROM lecture_sessions ls JOIN courses c ON c.id = ls.course_id
     WHERE ls.id = $1`,
    [sessionId, currentInstant().toISOString()],
  );
  if (!session) throw sessionNotFound();
  return session;
}

/** Administrators: one session's class list with each student's mark (null: not marked). */
export async function getSessionAttendance(sessionId) {
  const session = await findSession(sessionId);
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.student_number, a.status
     FROM course_registrations r
     JOIN users u ON u.id = r.student_id
     LEFT JOIN attendance a ON a.session_id = $1 AND a.student_id = u.id
     WHERE r.course_id = $2 AND r.status = 'registered'
     ORDER BY u.full_name, u.id`,
    [sessionId, session.course_id],
  );
  return {
    session: {
      id: session.id, date: session.date, startTime: session.starts, endTime: session.ends,
      hasStarted: session.has_started, course: { id: session.course_id, code: session.code, title: session.title },
    },
    students: rows.map((row) => ({ id: row.id, fullName: row.full_name, studentNumber: row.student_number, status: row.status })),
  };
}

/**
 * Saves marks for one session: [{ studentId, status }] (status null removes the mark).
 * All or nothing. Only a session that has started (409 SESSION_NOT_STARTED), and only
 * students registered for the course (400, details["records.<studentId>"]).
 */
export async function saveSessionAttendance(adminId, sessionId, records) {
  await withTransaction(async (tx) => {
    const studentIds = records.map((record) => record.studentId);
    const session = await findSession(sessionId, tx);
    if (!session.has_started) {
      throw new AppError(409, 'SESSION_NOT_STARTED', 'This lecture has not started yet, so attendance cannot be taken.');
    }
    const { rows } = await tx.query(
      "SELECT student_id FROM course_registrations WHERE course_id = $1 AND status = 'registered' AND student_id = ANY($2::int[])",
      [session.course_id, records.map((record) => record.studentId)],
    );
    const known = new Set(rows.map((row) => row.student_id));
    const unknown = records.filter((record) => !known.has(record.studentId));
    if (unknown.length > 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Some students are not registered for this course.', {
        details: Object.fromEntries(unknown.map((record) => [`records.${record.studentId}`, 'This student is not registered for the course.'])),
      });
    }
    const before = await ratesOf(tx, session.course_id, studentIds);
    const remove = records.filter((record) => record.status === null).map((record) => record.studentId);
    const save = records.filter((record) => record.status !== null);
    if (remove.length > 0) await tx.query('DELETE FROM attendance WHERE session_id = $1 AND student_id = ANY($2::int[])', [sessionId, remove]);
    if (save.length > 0) {
      await tx.query(
        `INSERT INTO attendance (session_id, student_id, status, marked_by)
         SELECT $1, record.student_id, record.status, $2
         FROM unnest($3::int[], $4::text[]) AS record (student_id, status)
         ON CONFLICT (session_id, student_id)
         DO UPDATE SET status = EXCLUDED.status, marked_by = EXCLUDED.marked_by, updated_at = now()`,
        [sessionId, adminId, save.map((record) => record.studentId), save.map((record) => record.status)],
      );
    }
    // A University Notice for each student whose rate has just fallen below the limit.
    const after = await ratesOf(tx, session.course_id, studentIds);
    const fallen = studentIds.filter((id) => after.get(id)?.warning && !before.get(id)?.warning);
    for (const studentId of fallen) {
      await tx.query(
        `INSERT INTO notifications (user_id, type, title, message)
         VALUES ($1, 'attendance_warning', 'Attendance below ${WARNING_BELOW_PERCENT}%', $2)`,
        [studentId, `Your attendance in ${session.code} ${session.title} is now ${after.get(studentId).ratePercent}%, below ${WARNING_BELOW_PERCENT}%. `
          + 'Talk to your professor or the academic office.'],
      );
    }
  });
  return getSessionAttendance(sessionId);
}

/** Inside a transaction: each student's summary in one course (Map studentId -> attendanceSummary). */
async function ratesOf(tx, courseId, studentIds) {
  const { rows } = await tx.query(
    `SELECT a.student_id,
            count(*) FILTER (WHERE a.status = 'present')::int AS present,
            count(*) FILTER (WHERE a.status = 'absent')::int AS absent,
            count(*) FILTER (WHERE a.status = 'excused')::int AS excused
     FROM attendance a JOIN lecture_sessions ls ON ls.id = a.session_id
     WHERE ls.course_id = $1 AND a.student_id = ANY($2::int[])
     GROUP BY a.student_id`,
    [courseId, studentIds],
  );
  return new Map(rows.map((row) => [row.student_id, attendanceSummary(row)]));
}

const COUNTS_SQL = `
  count(*) FILTER (WHERE a.status = 'present')::int AS present,
  count(*) FILTER (WHERE a.status = 'absent')::int AS absent,
  count(*) FILTER (WHERE a.status = 'excused')::int AS excused`;

/** Administrators: every registered student's counts and rate in one course, lowest rate first. */
export async function courseReport(courseId) {
  const { rows: [course] } = await query('SELECT id, code, title FROM courses WHERE id = $1', [courseId]);
  if (!course) throw courseNotFound();
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.student_number, ${COUNTS_SQL}
     FROM course_registrations r
     JOIN users u ON u.id = r.student_id
     LEFT JOIN lecture_sessions ls ON ls.course_id = r.course_id
     LEFT JOIN attendance a ON a.session_id = ls.id AND a.student_id = u.id
     WHERE r.course_id = $1 AND r.status = 'registered'
     GROUP BY u.id
     ORDER BY u.full_name`,
    [courseId],
  );
  const students = rows.map((row) => ({
    id: row.id, fullName: row.full_name, studentNumber: row.student_number, ...attendanceSummary(row),
  })).sort((a, b) => (a.ratePercent ?? 101) - (b.ratePercent ?? 101) || a.fullName.localeCompare(b.fullName));
  return {
    course: { id: course.id, code: course.code, title: course.title },
    warningBelowPercent: WARNING_BELOW_PERCENT,
    students,
    warnings: students.filter((student) => student.warning).length,
  };
}

/** A student's own attendance in each course they are registered for in `semesterId`. */
export async function myAttendance(studentId, semesterId) {
  const { rows } = await query(
    `SELECT c.id, c.code, c.title, ${COUNTS_SQL}
     FROM course_registrations r
     JOIN courses c ON c.id = r.course_id
     LEFT JOIN lecture_sessions ls ON ls.course_id = c.id
     LEFT JOIN attendance a ON a.session_id = ls.id AND a.student_id = r.student_id
     WHERE r.student_id = $1 AND r.status = 'registered' AND c.semester_id = $2
     GROUP BY c.id
     ORDER BY c.code`,
    [studentId, semesterId],
  );
  return rows.map((row) => ({ course: { id: row.id, code: row.code, title: row.title }, ...attendanceSummary(row) }));
}
