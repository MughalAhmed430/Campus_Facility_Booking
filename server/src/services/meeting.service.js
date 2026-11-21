import { query, withTransaction } from '../db/pool.js';
import AppError from '../utils/app-error.js';
import { addDays, campusInstant, campusToday, currentInstant, hasPassed } from '../utils/campus-time.js';
import { STATUS_TRANSITIONS, statusesLeadingTo } from './booking.service.js';

// Counselling: students ask a professor (their advisor for that meeting) for a meeting
// inside the professor's weekly office hours; an administrator approves or declines.
// The status rules are the reservations' own (STATUS_TRANSITIONS in booking.service.js):
//   pending -> approved | rejected | cancelled;  approved -> completed | cancelled.
// One professor can never have two overlapping approved meetings: meetings_no_overlap,
// an exclusion constraint like bookings_no_overlap (database/schema.sql).

export const MEETING_CATEGORIES = Object.freeze({
  academic_advising: 'Academic advising',
  course_planning: 'Course planning',
  career_guidance: 'Career guidance',
  research_supervision: 'Research supervision',
  internship: 'Internship',
  other: 'Other',
});
export const MEETING_LENGTHS = Object.freeze([30, 60]);
const BOOK_AHEAD_DAYS = 60;
export const MEETING_STATUSES = Object.freeze(Object.keys(STATUS_TRANSITIONS));
export const AUTO_DECLINE_NOTE = 'Another meeting at this time was approved.';

const minutesOf = (time) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};
const timeOf = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const isoWeekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

// ---- Office hours ------------------------------------------------------------------------

function toOfficeHours(row) {
  return { id: row.id, weekday: row.weekday, startTime: row.starts, endTime: row.ends, location: row.location };
}
const OFFICE_HOURS_COLUMNS = "id, professor_id, weekday, to_char(starts_at, 'HH24:MI') AS starts, to_char(ends_at, 'HH24:MI') AS ends, location";

/** Every professor with their office hours (only those with some, unless all is true). */
export async function listAdvisors({ all = false } = {}) {
  const { rows: professors } = await query(
    `SELECT p.id, p.full_name, p.photo_file, p.photo_credit, d.code AS department_code, d.name AS department_name
     FROM professors p JOIN departments d ON d.id = p.department_id
     ORDER BY p.full_name`,
  );
  const { rows: hours } = await query(`SELECT ${OFFICE_HOURS_COLUMNS} FROM office_hours ORDER BY weekday, starts_at`);
  return professors.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    department: { code: row.department_code, name: row.department_name },
    hasPhoto: row.photo_file != null,
    photoCredit: row.photo_file != null ? row.photo_credit : null,
    officeHours: hours.filter((hour) => hour.professor_id === row.id).map(toOfficeHours),
  })).filter((advisor) => all || advisor.officeHours.length > 0);
}

/** Adds weekly office hours. 409 OFFICE_HOURS_OVERLAP with the professor's other hours that day. */
export async function addOfficeHours(professorId, { weekday, startTime, endTime, location }) {
  return withTransaction(async (tx) => {
    const { rows: [professor] } = await tx.query('SELECT id FROM professors WHERE id = $1 FOR UPDATE', [professorId]);
    if (!professor) throw new AppError(404, 'PROFESSOR_NOT_FOUND', 'This professor does not exist.');
    const { rows: [overlap] } = await tx.query(
      'SELECT 1 FROM office_hours WHERE professor_id = $1 AND weekday = $2 AND starts_at < $4::time AND ends_at > $3::time',
      [professorId, weekday, startTime, endTime],
    );
    if (overlap) {
      const message = 'These hours overlap other office hours of this professor that day.';
      throw new AppError(409, 'OFFICE_HOURS_OVERLAP', message, { details: { startTime: message } });
    }
    const { rows: [row] } = await tx.query(
      `INSERT INTO office_hours (professor_id, weekday, starts_at, ends_at, location)
       VALUES ($1, $2, $3::time, $4::time, $5) RETURNING ${OFFICE_HOURS_COLUMNS}`,
      [professorId, weekday, startTime, endTime, location],
    );
    return toOfficeHours(row);
  });
}

/** Removes office hours. Meetings already requested or approved are left as they are. */
export async function removeOfficeHours(professorId, hoursId) {
  const { rows } = await query('DELETE FROM office_hours WHERE id = $1 AND professor_id = $2 RETURNING id', [hoursId, professorId]);
  if (rows.length === 0) throw new AppError(404, 'OFFICE_HOURS_NOT_FOUND', 'These office hours do not exist.');
}

/**
 * The free 30-minute starts of one professor on one date: inside their office hours that
 * weekday, not past, and not taken by an approved meeting. Pending requests do not hold
 * time, as with reservations. Returns { date, officeHours, slots: [{ startTime, endTime, free }] }.
 */
export async function advisorAvailability(professorId, date) {
  const { rows: hours } = await query(
    `SELECT ${OFFICE_HOURS_COLUMNS} FROM office_hours WHERE professor_id = $1 AND weekday = $2 ORDER BY starts_at`,
    [professorId, isoWeekday(date)],
  );
  const { rows: taken } = await query(
    `SELECT to_char(start_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS starts, to_char(end_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS ends
     FROM meetings
     WHERE professor_id = $1 AND status IN ('approved', 'completed')
       AND start_time >= $2::timestamptz AND start_time < $3::timestamptz`,
    [professorId, campusInstant(date, '00:00'), campusInstant(addDays(date, 1), '00:00')],
  );
  const slots = [];
  for (const hour of hours) {
    for (let minute = minutesOf(hour.starts); minute + 30 <= minutesOf(hour.ends); minute += 30) {
      const startTime = timeOf(minute);
      const endTime = timeOf(minute + 30);
      const busy = taken.some((meeting) => meeting.starts < endTime && startTime < meeting.ends);
      slots.push({ startTime, endTime, free: !busy && !hasPassed(date, startTime) });
    }
  }
  return { date, officeHours: hours.map(toOfficeHours), slots };
}

// ---- Requests (students) -------------------------------------------------------------------

/**
 * Checks a meeting request against the rules; adds an error to `v` per problem:
 * a real professor, a date from today up to BOOK_AHEAD_DAYS ahead, not in the past, a
 * length of 30 or 60 minutes on the half hour, and the whole meeting inside one of the
 * professor's office-hours blocks that weekday.
 */
export async function checkMeetingRules(v, { professorId, date, startTime, minutes }) {
  if (date !== undefined) {
    if (date < campusToday()) v.addError('date', 'Choose today or a later date.');
    else if (date > addDays(campusToday(), BOOK_AHEAD_DAYS)) v.addError('date', `Meetings can be requested up to ${BOOK_AHEAD_DAYS} days ahead.`);
    else if (startTime !== undefined && hasPassed(date, startTime)) v.addError('startTime', 'This time has already passed.');
  }
  if (startTime !== undefined && minutesOf(startTime) % 30 !== 0) v.addError('startTime', 'Choose a time on the hour or half hour.');
  if (professorId === undefined || date === undefined || startTime === undefined || minutes === undefined) return;
  const { rows: [professor] } = await query('SELECT id FROM professors WHERE id = $1', [professorId]);
  if (!professor) {
    v.addError('professorId', 'This advisor does not exist.');
    return;
  }
  const endTime = timeOf(minutesOf(startTime) + minutes);
  const { rows: [inside] } = await query(
    'SELECT 1 FROM office_hours WHERE professor_id = $1 AND weekday = $2 AND starts_at <= $3::time AND ends_at >= $4::time',
    [professorId, isoWeekday(date), startTime, endTime],
  );
  if (!inside) v.addError('startTime', 'Choose a time inside the advisor\'s office hours.');
}

/**
 * Creates a request, always pending. 409 MEETING_CONFLICT when an approved meeting of
 * that professor already takes part of the time (checked in the INSERT; pending rows are
 * outside meetings_no_overlap, as with bookings). A student cannot have two meetings that
 * overlap, whoever with: 409 MEETING_OVERLAPS_YOURS.
 */
export async function requestMeeting(studentId, { professorId, date, startTime, minutes, category, description }) {
  const start = campusInstant(date, startTime);
  const end = campusInstant(date, timeOf(minutesOf(startTime) + minutes));
  const { rows: [mine] } = await query(
    `SELECT 1 FROM meetings WHERE student_id = $1 AND status IN ('pending', 'approved')
       AND tstzrange(start_time, end_time, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
    [studentId, start, end],
  );
  if (mine) throw new AppError(409, 'MEETING_OVERLAPS_YOURS', 'You already have a meeting or request at this time.');
  const { rows } = await query(
    `INSERT INTO meetings (student_id, professor_id, start_time, end_time, category, description)
     SELECT $1, $2, $3::timestamptz, $4::timestamptz, $5, $6
     WHERE NOT EXISTS (
       SELECT 1 FROM meetings
       WHERE professor_id = $2 AND status IN ('approved', 'completed')
         AND tstzrange(start_time, end_time, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
     )
     RETURNING id`,
    [studentId, professorId, start, end, category, description],
  );
  if (rows.length === 0) throw new AppError(409, 'MEETING_CONFLICT', 'The advisor already has a meeting at this time. Choose another time.');
  return getMeeting({ id: studentId, role: 'student' }, rows[0].id);
}

/** Approved meetings that have ended become completed (run before listing, as for bookings). */
async function completeEnded() {
  await query(
    `UPDATE meetings SET status = 'completed' WHERE status = ANY($1::text[]) AND end_time <= $2::timestamptz`,
    [statusesLeadingTo('completed'), currentInstant().toISOString()],
  );
}

const MEETING_SELECT = `
  SELECT m.id, m.status, m.category, m.description, m.created_at,
         m.decided_at, m.decision_note, m.cancelled_at, m.cancellation_reason, m.cancelled_by = m.student_id AS cancelled_by_student,
         to_char(m.start_time AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS date,
         to_char(m.start_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS starts,
         to_char(m.end_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS ends,
         m.start_time <= $1::timestamptz AS has_started,
         p.id AS professor_id, p.full_name AS professor_name,
         u.id AS student_id, u.full_name AS student_name, u.student_number, u.email,
         (SELECT oh.location FROM office_hours oh
           WHERE oh.professor_id = m.professor_id
             AND oh.weekday = extract(isodow FROM m.start_time AT TIME ZONE 'Asia/Seoul')
             AND oh.starts_at <= (m.start_time AT TIME ZONE 'Asia/Seoul')::time
             AND oh.ends_at >= (m.end_time AT TIME ZONE 'Asia/Seoul')::time
           LIMIT 1) AS location
  FROM meetings m
  JOIN professors p ON p.id = m.professor_id
  JOIN users u ON u.id = m.student_id`;

function toMeeting(row, viewer) {
  const meeting = {
    id: row.id,
    status: row.status,
    category: row.category,
    categoryLabel: MEETING_CATEGORIES[row.category] ?? row.category,
    description: row.description,
    date: row.date,
    startTime: row.starts,
    endTime: row.ends,
    location: row.location,
    hasStarted: row.has_started,
    createdAt: row.created_at.toISOString(),
    professor: { id: row.professor_id, fullName: row.professor_name },
    decision: row.decided_at ? { decidedAt: row.decided_at.toISOString(), note: row.decision_note } : null,
    cancellation: row.status === 'cancelled'
      ? { cancelledAt: row.cancelled_at.toISOString(), reason: row.cancellation_reason, byStudent: row.cancelled_by_student }
      : null,
    // The student may cancel a pending request any time, an approved meeting until it starts.
    canCancel: row.status === 'pending' || (row.status === 'approved' && !row.has_started),
  };
  if (viewer.role === 'admin') {
    meeting.student = { id: row.student_id, fullName: row.student_name, studentNumber: row.student_number, email: row.email };
    meeting.canDecide = row.status === 'pending' && !row.has_started;
  }
  return meeting;
}

const meetingNotFound = () => new AppError(404, 'MEETING_NOT_FOUND', 'This meeting does not exist, or it is not one of yours.');

export async function getMeeting(viewer, id) {
  const { rows: [row] } = await query(
    `${MEETING_SELECT} WHERE m.id = $2 AND ($3::int IS NULL OR m.student_id = $3::int)`,
    [currentInstant().toISOString(), id, viewer.role === 'admin' ? null : viewer.id],
  );
  if (!row) throw meetingNotFound();
  return toMeeting(row, viewer);
}

/** The student's own meetings, latest first. */
export async function listMyMeetings(viewer) {
  await completeEnded();
  const { rows } = await query(`${MEETING_SELECT} WHERE m.student_id = $2 ORDER BY m.start_time DESC, m.id DESC`, [currentInstant().toISOString(), viewer.id]);
  return rows.map((row) => toMeeting(row, viewer));
}

/** Administrators: meetings, filtered by statuses (optional), soonest first for pending, latest first otherwise. */
export async function listMeetings(viewer, { statuses } = {}) {
  await completeEnded();
  const pendingOnly = statuses?.length === 1 && statuses[0] === 'pending';
  const { rows } = await query(
    `${MEETING_SELECT}
     WHERE ($2::text[] IS NULL OR m.status = ANY($2::text[]))
     ORDER BY ${pendingOnly ? 'm.start_time ASC' : 'm.start_time DESC'}, m.id`,
    [currentInstant().toISOString(), statuses?.length ? statuses : null],
  );
  const meetings = rows.map((row) => toMeeting(row, viewer));
  // Pending requests overlapping each other (same professor): approving one declines the rest.
  for (const meeting of meetings) {
    if (meeting.status !== 'pending') continue;
    meeting.overlappingRequests = meetings.filter((other) => other.id !== meeting.id && other.status === 'pending'
      && other.professor.id === meeting.professor.id && other.date === meeting.date
      && other.startTime < meeting.endTime && meeting.startTime < other.endTime).map((other) => other.id);
  }
  return meetings;
}

// ---- Decisions (administrators) and cancelling ---------------------------------------------

function notifySql(source) {
  const slot = `to_char(s.start_time AT TIME ZONE 'Asia/Seoul', 'Dy DD Mon, HH24:MI') || '-' || to_char(s.end_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI')`;
  return `
    SELECT s.student_id, s.id,
           CASE s.status WHEN 'approved' THEN 'meeting_approved' WHEN 'rejected' THEN 'meeting_rejected' ELSE 'meeting_cancelled' END,
           CASE s.status WHEN 'approved' THEN 'Meeting approved' WHEN 'rejected' THEN 'Meeting request declined' ELSE 'Meeting cancelled' END,
           'Your meeting with ' || p.full_name || ' on ' || ${slot} ||
             CASE s.status WHEN 'approved' THEN ' was approved.' || COALESCE(' Note: ' || s.decision_note, '')
                           WHEN 'rejected' THEN ' was declined. Reason: ' || COALESCE(s.decision_note, 'none given.')
                           ELSE ' was cancelled by an administrator. Reason: ' || COALESCE(s.cancellation_reason, 'none given.') END
    FROM ${source} s JOIN professors p ON p.id = s.professor_id`;
}

async function notify(tx, ids) {
  if (ids.length === 0) return;
  await tx.query(
    `INSERT INTO notifications (user_id, meeting_id, type, title, message)
     ${notifySql('meetings')} WHERE s.id = ANY($1::int[])`,
    [ids],
  );
}

const NOT_PENDING = {
  approved: 'This meeting has already been approved.',
  rejected: 'This request has already been declined.',
  cancelled: 'The student has cancelled this request.',
  completed: 'This meeting is already over.',
};

/**
 * Approves a pending request and, in the same transaction, declines every other pending
 * request to the same professor that overlaps it, each student told. The request and
 * those overlapping are locked first, in id order (the approval rule of bookings).
 * 409 MEETING_CONFLICT when an approved meeting already takes part of the time: that is
 * meetings_no_overlap itself refusing the UPDATE.
 */
export async function approveMeeting(adminId, id, { note } = {}) {
  const overlap = "tstzrange(o.start_time, o.end_time, '[)') && tstzrange(m.start_time, m.end_time, '[)')";
  try {
    return await withTransaction(async (tx) => {
      await tx.query(
        `SELECT o.id FROM meetings m
         JOIN meetings o ON o.professor_id = m.professor_id AND (o.id = m.id OR (o.status = 'pending' AND ${overlap}))
         WHERE m.id = $1 ORDER BY o.id FOR UPDATE OF o`,
        [id],
      );
      const { rows: [meeting] } = await tx.query('SELECT status, start_time <= $2::timestamptz AS has_started FROM meetings WHERE id = $1', [id, currentInstant().toISOString()]);
      if (!meeting) throw meetingNotFound();
      if (meeting.status !== 'pending') throw new AppError(409, 'MEETING_NOT_PENDING', NOT_PENDING[meeting.status] ?? 'This request is no longer waiting.');
      if (meeting.has_started) throw new AppError(409, 'MEETING_STARTED', 'This request\'s time has passed, so it can no longer be approved.');
      await tx.query(
        "UPDATE meetings SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1 AND status = 'pending'",
        [id, adminId, note ?? null],
      );
      const { rows: declined } = await tx.query(
        `UPDATE meetings o SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
         FROM meetings m
         WHERE m.id = $1 AND o.professor_id = m.professor_id AND o.id <> m.id AND o.status = 'pending' AND ${overlap}
         RETURNING o.id`,
        [id, adminId, AUTO_DECLINE_NOTE],
      );
      await notify(tx, [id, ...declined.map((row) => row.id)]);
      return { meetingId: id, autoDeclined: declined.map((row) => row.id).sort((a, b) => a - b) };
    });
  } catch (err) {
    if (err.code === '23P01') {
      throw new AppError(409, 'MEETING_CONFLICT', 'The advisor already has an approved meeting during part of this time, so this request cannot be approved.', { cause: err });
    }
    throw err;
  }
}

/** Declines a pending request with a reason the student sees. One conditional UPDATE decides. */
export async function declineMeeting(adminId, id, { reason }) {
  const { rows: [row] } = await query(
    `WITH changed AS (
       UPDATE meetings SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
       WHERE id = $1 AND status = 'pending' RETURNING *
     ), told AS (
       INSERT INTO notifications (user_id, meeting_id, type, title, message) ${notifySql('changed')}
     )
     SELECT id FROM changed`,
    [id, adminId, reason],
  );
  if (!row) {
    const { rows: [current] } = await query('SELECT status FROM meetings WHERE id = $1', [id]);
    if (!current) throw meetingNotFound();
    throw new AppError(409, 'MEETING_NOT_PENDING', NOT_PENDING[current.status] ?? 'This request is no longer waiting.');
  }
}

/**
 * The student cancels their own meeting: a pending request any time, an approved meeting
 * until it starts (the booking rule). 404 for someone else's; 409 MEETING_NOT_CANCELLABLE.
 */
export async function cancelMyMeeting(viewer, id, { reason } = {}) {
  const { rows } = await query(
    `UPDATE meetings SET status = 'cancelled', cancelled_by = $2, cancelled_at = now(), cancellation_reason = $3
     WHERE id = $1 AND student_id = $2 AND status = ANY($4::text[])
       AND (status <> 'approved' OR start_time > $5::timestamptz)
     RETURNING id`,
    [id, viewer.id, reason ?? null, statusesLeadingTo('cancelled'), currentInstant().toISOString()],
  );
  if (rows.length === 0) {
    const { rows: [current] } = await query('SELECT student_id, status FROM meetings WHERE id = $1', [id]);
    if (!current || current.student_id !== viewer.id) throw meetingNotFound();
    throw new AppError(409, 'MEETING_NOT_CANCELLABLE', current.status === 'approved'
      ? 'This meeting has already started, so it can no longer be cancelled.'
      : 'This meeting can no longer be cancelled.');
  }
  return getMeeting(viewer, id);
}
