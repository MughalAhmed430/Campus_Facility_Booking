import { query, withTransaction } from '../db/pool.js';
import AppError from '../utils/app-error.js';
import { campusToday, currentInstant } from '../utils/campus-time.js';
import { escapeLikePattern, findBookingRules } from './facility.service.js';
import { notifyBookingOwners } from './notification.service.js';

// Courses, their weekly lectures, and course registration. A separate module next to
// facility reservations; the two meet in room_occupancy (database/schema.sql), where a
// lecture session holds its room exactly like an approved booking.

export const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]); // ISO: 1 = Monday
const LECTURE_MIN_MINUTES = 30;
const LECTURE_MAX_MINUTES = 240;
const TIME_STEP_MINUTES = 30;

// The note recorded on pending requests rejected because a lecture now holds their time.
export const LECTURE_REJECT_NOTE = 'A lecture was scheduled in this room at this time.';

const minutesOf = (time) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

// ---- Semesters ---------------------------------------------------------------------------

function toSemester(row) {
  return { id: row.id, name: row.name, startsOn: row.starts_on, endsOn: row.ends_on };
}

const SEMESTER_COLUMNS = "id, name, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on";

/**
 * Every semester, latest first, and which one is current: the one running today, else
 * the next to start, else the last one. currentId is null when there are none.
 */
export async function listSemesters() {
  const { rows } = await query(`SELECT ${SEMESTER_COLUMNS} FROM semesters ORDER BY starts_on DESC`);
  const today = campusToday();
  const current = rows.find((row) => row.starts_on <= today && today <= row.ends_on)
    ?? [...rows].reverse().find((row) => row.starts_on > today)
    ?? rows[0];
  return { semesters: rows.map(toSemester), currentId: current?.id ?? null };
}

async function resolveSemester(semesterId) {
  if (semesterId === undefined) {
    const { semesters, currentId } = await listSemesters();
    return semesters.find((semester) => semester.id === currentId) ?? null;
  }
  const { rows: [row] } = await query(`SELECT ${SEMESTER_COLUMNS} FROM semesters WHERE id = $1`, [semesterId]);
  if (!row) throw new AppError(404, 'SEMESTER_NOT_FOUND', 'This semester does not exist.');
  return toSemester(row);
}

/** { name, startsOn, endsOn } -> the new semester. 409 when the name is taken or the dates overlap another semester. */
export async function createSemester({ name, startsOn, endsOn }) {
  try {
    const { rows: [row] } = await query(
      `INSERT INTO semesters (name, starts_on, ends_on) VALUES ($1, $2, $3) RETURNING ${SEMESTER_COLUMNS}`,
      [name, startsOn, endsOn],
    );
    return toSemester(row);
  } catch (err) {
    if (err.code === '23505') {
      throw new AppError(409, 'SEMESTER_TAKEN', 'There is already a semester with this name.', { details: { name: 'There is already a semester with this name.' }, cause: err });
    }
    if (err.code === '23P01') {
      const message = 'These dates overlap another semester.';
      throw new AppError(409, 'SEMESTER_OVERLAP', message, { details: { startsOn: message }, cause: err });
    }
    throw err;
  }
}

// ---- Reading courses ---------------------------------------------------------------------

const COURSE_SELECT = `
  SELECT c.id, c.code, c.title, c.credits, c.description, c.seat_limit,
         s.id AS semester_id, s.name AS semester_name,
         to_char(s.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(s.ends_on, 'YYYY-MM-DD') AS ends_on,
         d.id AS department_id, d.code AS department_code, d.name AS department_name,
         p.id AS professor_id, p.full_name AS professor_name, p.photo_file AS professor_photo, p.photo_credit,
         (SELECT count(*)::int FROM course_registrations r WHERE r.course_id = c.id AND r.status = 'registered') AS seats_taken,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'id', ls.id, 'weekday', ls.weekday,
                    'startTime', to_char(ls.starts_at, 'HH24:MI'), 'endTime', to_char(ls.ends_at, 'HH24:MI'),
                    'facility', json_build_object('id', f.id, 'name', f.name, 'roomNumber', f.room_number,
                                                  'building', json_build_object('code', bl.code, 'name', bl.name))
                  ) ORDER BY ls.weekday, ls.starts_at, ls.id)
           FROM lecture_slots ls
           JOIN facilities f ON f.id = ls.facility_id
           JOIN buildings bl ON bl.id = f.building_id
           WHERE ls.course_id = c.id
         ), '[]'::json) AS slots,
         (SELECT r.status FROM course_registrations r WHERE r.course_id = c.id AND r.student_id = $1::int) AS my_status
  FROM courses c
  JOIN semesters s   ON s.id = c.semester_id
  JOIN departments d ON d.id = c.department_id
  JOIN professors p  ON p.id = c.professor_id`;

function toCourse(row, viewer) {
  const today = campusToday();
  const isOpen = today <= row.ends_on; // registration and dropping close when the semester ends
  const seatsLeft = Math.max(0, row.seat_limit - row.seats_taken);
  const course = {
    id: row.id,
    code: row.code,
    title: row.title,
    credits: row.credits,
    description: row.description,
    seatLimit: row.seat_limit,
    seatsTaken: row.seats_taken,
    seatsLeft,
    semester: { id: row.semester_id, name: row.semester_name, startsOn: row.starts_on, endsOn: row.ends_on },
    department: { id: row.department_id, code: row.department_code, name: row.department_name },
    professor: {
      id: row.professor_id,
      fullName: row.professor_name,
      hasPhoto: row.professor_photo != null,
      photoCredit: row.professor_photo != null ? row.photo_credit : null,
    },
    slots: row.slots,
    registrationOpen: isOpen,
  };
  if (viewer?.role === 'student') {
    const registered = row.my_status === 'registered';
    course.isRegistered = registered;
    course.canRegister = isOpen && !registered && seatsLeft > 0;
    course.canDrop = isOpen && registered;
  }
  return course;
}

function courseNotFound() {
  return new AppError(404, 'COURSE_NOT_FOUND', 'This course does not exist.');
}

/**
 * The courses of one semester (the current one when semesterId is undefined), by code.
 * Filters (optional): search (code, title or professor), departmentId.
 * Returns { semester, courses }; semester is null when there are no semesters at all.
 */
export async function listCourses(viewer, { semesterId, search, departmentId } = {}) {
  const semester = await resolveSemester(semesterId);
  if (!semester) return { semester: null, courses: [] };
  const params = [viewer.id, semester.id];
  const conditions = ['c.semester_id = $2::int'];
  if (search) {
    params.push(`%${escapeLikePattern(search)}%`);
    const p = `$${params.length}`;
    conditions.push(`(c.code ILIKE ${p} OR c.title ILIKE ${p} OR p.full_name ILIKE ${p})`);
  }
  if (departmentId !== undefined) {
    params.push(departmentId);
    conditions.push(`c.department_id = $${params.length}::int`);
  }
  const { rows } = await query(`${COURSE_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY c.code, c.id`, params);
  return { semester, courses: rows.map((row) => toCourse(row, viewer)) };
}

export async function getCourse(viewer, id) {
  const { rows: [row] } = await query(`${COURSE_SELECT} WHERE c.id = $2::int`, [viewer.id, id]);
  if (!row) throw courseNotFound();
  return toCourse(row, viewer);
}

/** Administrators: the students registered in a course, by name. */
export async function listCourseStudents(id) {
  const { rows: exists } = await query('SELECT 1 FROM courses WHERE id = $1', [id]);
  if (exists.length === 0) throw courseNotFound();
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.email, u.student_number, r.registered_at
     FROM course_registrations r
     JOIN users u ON u.id = r.student_id
     WHERE r.course_id = $1 AND r.status = 'registered'
     ORDER BY u.full_name, u.id`,
    [id],
  );
  return rows.map((row) => ({
    id: row.id, fullName: row.full_name, email: row.email, studentNumber: row.student_number,
    registeredAt: row.registered_at.toISOString(),
  }));
}

/**
 * A student's timetable: the courses they are registered in for one semester (the
 * current one by default), with every weekly lecture, and their total credits.
 */
export async function getTimetable(viewer, { semesterId } = {}) {
  const semester = await resolveSemester(semesterId);
  if (!semester) return { semester: null, courses: [], totalCredits: 0 };
  const { rows } = await query(
    `${COURSE_SELECT}
     WHERE c.semester_id = $2::int
       AND EXISTS (SELECT 1 FROM course_registrations r WHERE r.course_id = c.id AND r.student_id = $1::int AND r.status = 'registered')
     ORDER BY c.code`,
    [viewer.id, semester.id],
  );
  const courses = rows.map((row) => toCourse(row, viewer));
  return { semester, courses, totalCredits: courses.reduce((sum, course) => sum + course.credits, 0) };
}

// ---- Managing courses (administrators) -----------------------------------------------------

function courseSaveError(err) {
  if (err.code === '23505' && err.constraint === 'courses_semester_code_key') {
    const message = 'This semester already has a course with this code.';
    return new AppError(409, 'COURSE_CODE_TAKEN', message, { details: { code: message }, cause: err });
  }
  if (err.code === '23503') {
    const field = { courses_semester_id_fkey: 'semesterId', courses_department_id_fkey: 'departmentId', courses_professor_id_fkey: 'professorId' }[err.constraint];
    if (field) {
      const what = { semesterId: 'semester', departmentId: 'department', professorId: 'professor' }[field];
      return new AppError(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', { details: { [field]: `This ${what} does not exist.` }, cause: err });
    }
  }
  return err;
}

/** fields: { semesterId, code, title, credits, departmentId, professorId, description, seatLimit } */
export async function createCourse(viewer, fields) {
  try {
    const { rows: [row] } = await query(
      `INSERT INTO courses (semester_id, code, title, credits, department_id, professor_id, description, seat_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [fields.semesterId, fields.code, fields.title, fields.credits, fields.departmentId, fields.professorId, fields.description ?? null, fields.seatLimit],
    );
    return getCourse(viewer, row.id);
  } catch (err) {
    throw courseSaveError(err);
  }
}

/**
 * Replaces a course's details. The semester cannot change (its lectures are dated). The
 * seat limit cannot go below the number already registered: 409 SEATS_BELOW_REGISTERED.
 */
export async function updateCourse(viewer, id, fields) {
  try {
    await withTransaction(async (tx) => {
      const { rows: [course] } = await tx.query('SELECT id FROM courses WHERE id = $1 FOR UPDATE', [id]);
      if (!course) throw courseNotFound();
      const { rows: [{ taken }] } = await tx.query(
        "SELECT count(*)::int AS taken FROM course_registrations WHERE course_id = $1 AND status = 'registered'",
        [id],
      );
      if (fields.seatLimit < taken) {
        const message = `${taken} students are registered, so the seat limit cannot be lower than ${taken}.`;
        throw new AppError(409, 'SEATS_BELOW_REGISTERED', message, { details: { seatLimit: message } });
      }
      await tx.query(
        `UPDATE courses SET code = $2, title = $3, credits = $4, department_id = $5, professor_id = $6,
                            description = $7, seat_limit = $8
         WHERE id = $1`,
        [id, fields.code, fields.title, fields.credits, fields.departmentId, fields.professorId, fields.description ?? null, fields.seatLimit],
      );
    });
  } catch (err) {
    throw courseSaveError(err);
  }
  return getCourse(viewer, id);
}

/**
 * Deletes a course nobody has ever registered for, with its lectures (which frees their
 * rooms). 409 COURSE_HAS_STUDENTS otherwise: a registration is part of a student's record.
 */
export async function deleteCourse(id) {
  try {
    const { rows } = await query('DELETE FROM courses WHERE id = $1 RETURNING id', [id]);
    if (rows.length === 0) throw courseNotFound();
  } catch (err) {
    // 23001 restrict_violation (ON DELETE RESTRICT); 23503 foreign_key_violation
    if (err.code === '23001' || err.code === '23503') {
      throw new AppError(409, 'COURSE_HAS_STUDENTS', 'Students have registered for this course, so it cannot be deleted.', { cause: err });
    }
    throw err;
  }
}

/**
 * Adds a weekly lecture to `id`: { weekday, startTime, endTime, facilityId }. A session is
 * created for every remaining week of the semester, and each one holds its room.
 *
 * In one transaction:
 *   1. The room must be free in every one of those weeks. An approved booking or another
 *      lecture there is refused: 409 LECTURE_CONFLICT, listing the first clashes. The
 *      check is a query for a clear message; room_occupancy_no_overlap is what guarantees
 *      it, also against an approval committing at the same moment.
 *   2. The professor must not be lecturing elsewhere then: 409 PROFESSOR_CLASH.
 *   3. Pending reservation requests for that room and time are rejected (they could never
 *      be approved now), each with LECTURE_REJECT_NOTE and a notification.
 * Returns { slot, sessionsCreated, autoRejected: [booking ids] }.
 */
export async function addLectureSlot(viewer, id, { weekday, startTime, endTime, facilityId }) {
  const facility = await findBookingRules(facilityId);
  const details = {};
  if (!facility) details.facilityId = 'This facility does not exist.';
  else {
    if (!facility.isBookable) details.facilityId = 'This facility is closed at the moment, so no lecture can be held there.';
    if (!facility.openWeekends && weekday >= 6) details.weekday = 'This facility is closed on Saturdays and Sundays.';
    const hours = `Must be inside the opening hours, ${facility.opensAt}–${facility.closesAt}.`;
    if (startTime < facility.opensAt || startTime >= facility.closesAt) details.startTime = hours;
    if (endTime <= facility.opensAt || endTime > facility.closesAt) details.endTime = hours;
  }
  const grid = 'Choose a time on the hour or half hour, for example 10:00 or 10:30.';
  if (minutesOf(startTime) % TIME_STEP_MINUTES !== 0) details.startTime = grid;
  if (minutesOf(endTime) % TIME_STEP_MINUTES !== 0) details.endTime = grid;
  const length = minutesOf(endTime) - minutesOf(startTime);
  if (length <= 0) details.endTime = 'End time must be after the start time.';
  else if (length < LECTURE_MIN_MINUTES || length > LECTURE_MAX_MINUTES) details.endTime = 'A lecture lasts from 30 minutes to 4 hours.';
  if (Object.keys(details).length > 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', { details });
  }

  const now = currentInstant().toISOString();
  try {
    return await withTransaction(async (tx) => {
      const { rows: [course] } = await tx.query(
        `SELECT c.id, c.professor_id, c.semester_id,
                to_char(GREATEST(s.starts_on, $2::date), 'YYYY-MM-DD') AS from_date,
                to_char(s.ends_on, 'YYYY-MM-DD') AS to_date
         FROM courses c JOIN semesters s ON s.id = c.semester_id
         WHERE c.id = $1
         FOR UPDATE OF c`,
        [id, campusToday()],
      );
      if (!course) throw courseNotFound();

      // The professor's other lectures that semester on the same weekday and overlapping time.
      const { rows: [busy] } = await tx.query(
        `SELECT c.code, to_char(ls.starts_at, 'HH24:MI') AS starts, to_char(ls.ends_at, 'HH24:MI') AS ends
         FROM lecture_slots ls
         JOIN courses c ON c.id = ls.course_id
         WHERE c.professor_id = $1 AND c.semester_id = $2 AND ls.weekday = $3
           AND ls.starts_at < $5::time AND ls.ends_at > $4::time
         LIMIT 1`,
        [course.professor_id, course.semester_id, weekday, startTime, endTime],
      );
      if (busy) {
        throw new AppError(409, 'PROFESSOR_CLASH', `The professor already lectures ${busy.code} at ${busy.starts}–${busy.ends} that day.`, {
          details: { startTime: `The professor already lectures ${busy.code} at ${busy.starts}–${busy.ends} that day.` },
        });
      }

      // The dated sessions this slot will have: every matching weekday left this semester
      // (from today; one that has already started today is skipped).
      const sessionsSql = `
        SELECT (day + $3::time) AT TIME ZONE 'Asia/Seoul' AS start_time,
               (day + $4::time) AT TIME ZONE 'Asia/Seoul' AS end_time
        FROM generate_series($1::date::timestamp, $2::date::timestamp, interval '1 day') AS day
        WHERE extract(isodow FROM day) = $5
          AND (day + $3::time) AT TIME ZONE 'Asia/Seoul' > $6::timestamptz`;
      const sessionParams = [course.from_date, course.to_date, startTime, endTime, weekday, now];

      const { rows: clashes } = await tx.query(
        `WITH planned AS (${sessionsSql})
         SELECT to_char(lower(o.during) AT TIME ZONE 'Asia/Seoul', 'Dy DD Mon') AS day,
                to_char(lower(o.during) AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS starts,
                to_char(upper(o.during) AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS ends,
                o.booking_id, oc.code AS lecture_code
         FROM planned
         JOIN room_occupancy o ON o.facility_id = $7
                              AND o.during && tstzrange(planned.start_time, planned.end_time, '[)')
         LEFT JOIN lecture_sessions ols ON ols.id = o.lecture_session_id
         LEFT JOIN courses oc ON oc.id = ols.course_id
         ORDER BY lower(o.during)`,
        [...sessionParams, facilityId],
      );
      if (clashes.length > 0) throw lectureConflict(clashes);

      const { rows: [slot] } = await tx.query(
        `INSERT INTO lecture_slots (course_id, weekday, starts_at, ends_at, facility_id)
         VALUES ($1, $2, $3::time, $4::time, $5) RETURNING id`,
        [id, weekday, startTime, endTime, facilityId],
      );
      const { rows: created } = await tx.query(
        `INSERT INTO lecture_sessions (course_id, slot_id, facility_id, start_time, end_time)
         SELECT $7::int, $8::int, $9::int, planned.start_time, planned.end_time
         FROM (${sessionsSql}) AS planned
         RETURNING id`,
        [...sessionParams, id, slot.id, facilityId],
      );

      const { rows: rejected } = await tx.query(
        `UPDATE bookings b
         SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
         WHERE b.facility_id = $4 AND b.status = 'pending'
           AND EXISTS (
             SELECT 1 FROM lecture_sessions ls
             WHERE ls.slot_id = $1
               AND tstzrange(ls.start_time, ls.end_time, '[)') && tstzrange(b.start_time, b.end_time, '[)')
           )
         RETURNING b.id`,
        [slot.id, viewer.id, LECTURE_REJECT_NOTE, facilityId],
      );
      await notifyBookingOwners(tx, rejected.map((row) => row.id));

      return {
        slot: { id: slot.id, weekday, startTime, endTime, facilityId },
        sessionsCreated: created.length,
        autoRejected: rejected.map((row) => row.id).sort((a, b) => a - b),
      };
    });
  } catch (err) {
    if (err.code === '23P01') { // room_occupancy_no_overlap: something took the room meanwhile
      throw new AppError(409, 'LECTURE_CONFLICT', 'This room was taken for part of this time while the lecture was being saved. Reload and try again.', { cause: err });
    }
    throw err;
  }
}

function lectureConflict(clashes) {
  const describe = (clash) => `${clash.day} ${clash.starts}–${clash.ends} (${clash.lecture_code ? `lecture ${clash.lecture_code}` : `reservation FR-${String(clash.booking_id).padStart(6, '0')}`})`;
  const listed = clashes.slice(0, 3).map(describe).join(', ');
  const more = clashes.length > 3 ? ` and ${clashes.length - 3} more` : '';
  const message = `The room is taken in ${clashes.length === 1 ? 'one week' : `${clashes.length} weeks`}: ${listed}${more}. Choose another time or room, or cancel the reservation first.`;
  return new AppError(409, 'LECTURE_CONFLICT', message, {
    details: {
      facilityId: message,
      clashes: clashes.map((clash) => ({
        day: clash.day, startTime: clash.starts, endTime: clash.ends,
        bookingId: clash.booking_id, lectureCode: clash.lecture_code,
      })),
    },
  });
}

/**
 * Removes a weekly lecture: its sessions from now on are deleted, which frees the room
 * at once. Past sessions stay (attendance belongs to them), no longer linked to a slot.
 * Returns { sessionsRemoved }.
 */
export async function removeLectureSlot(courseId, slotId) {
  return withTransaction(async (tx) => {
    const { rows: [slot] } = await tx.query('SELECT id FROM lecture_slots WHERE id = $1 AND course_id = $2 FOR UPDATE', [slotId, courseId]);
    if (!slot) throw new AppError(404, 'SLOT_NOT_FOUND', 'This lecture time does not exist.');
    const { rows } = await tx.query(
      'DELETE FROM lecture_sessions WHERE slot_id = $1 AND start_time > $2::timestamptz RETURNING id',
      [slotId, currentInstant().toISOString()],
    );
    await tx.query('DELETE FROM lecture_slots WHERE id = $1', [slotId]);
    return { sessionsRemoved: rows.length };
  });
}

// ---- Registration (students) -------------------------------------------------------------

/**
 * Registers the student for a course. In one transaction, with the student's row and then
 * the course row locked (always in that order, so two transactions never wait for each
 * other):
 *   - the semester must not have ended: 409 REGISTRATION_CLOSED
 *   - a seat must be free: 409 COURSE_FULL. The course lock means two students asking
 *     for the last seat at the same moment are handled one after the other, and the
 *     second is told it is full.
 *   - none of its lectures may overlap a course they already have: 409 TIMETABLE_CLASH.
 *     The student lock means two clashing courses cannot be taken at the same moment.
 * Registering again for a course already taken changes nothing: 409 ALREADY_REGISTERED.
 */
export async function register(viewer, courseId) {
  await withTransaction(async (tx) => {
    await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [viewer.id]);
    const { rows: [course] } = await tx.query(
      `SELECT c.id, c.code, c.seat_limit, c.semester_id, s.ends_on >= $2::date AS is_open
       FROM courses c JOIN semesters s ON s.id = c.semester_id
       WHERE c.id = $1
       FOR UPDATE OF c`,
      [courseId, campusToday()],
    );
    if (!course) throw courseNotFound();
    if (!course.is_open) throw new AppError(409, 'REGISTRATION_CLOSED', 'This semester is over, so registration is closed.');

    const { rows: [mine] } = await tx.query(
      'SELECT status FROM course_registrations WHERE course_id = $1 AND student_id = $2',
      [courseId, viewer.id],
    );
    if (mine?.status === 'registered') throw new AppError(409, 'ALREADY_REGISTERED', 'You are already registered for this course.');

    const { rows: [{ taken }] } = await tx.query(
      "SELECT count(*)::int AS taken FROM course_registrations WHERE course_id = $1 AND status = 'registered'",
      [courseId],
    );
    if (taken >= course.seat_limit) throw new AppError(409, 'COURSE_FULL', 'This course is full. Every seat has been taken.');

    const { rows: [clash] } = await tx.query(
      `SELECT oc.code, oc.title
       FROM lecture_slots mine
       JOIN lecture_slots other ON other.weekday = mine.weekday
                               AND other.starts_at < mine.ends_at AND other.ends_at > mine.starts_at
       JOIN courses oc ON oc.id = other.course_id AND oc.semester_id = $3
       JOIN course_registrations r ON r.course_id = oc.id AND r.student_id = $2 AND r.status = 'registered'
       WHERE mine.course_id = $1 AND oc.id <> $1
       LIMIT 1`,
      [courseId, viewer.id, course.semester_id],
    );
    if (clash) {
      throw new AppError(409, 'TIMETABLE_CLASH', `${course.code} has a lecture at the same time as ${clash.code} ${clash.title}, which you already take.`);
    }

    await tx.query(
      `INSERT INTO course_registrations (course_id, student_id) VALUES ($1, $2)
       ON CONFLICT (course_id, student_id)
       DO UPDATE SET status = 'registered', registered_at = now(), dropped_at = NULL`,
      [courseId, viewer.id],
    );
  });
  return getCourse(viewer, courseId);
}

/** Drops a course the student is registered for, until the semester ends. 409 NOT_REGISTERED or REGISTRATION_CLOSED. */
export async function drop(viewer, courseId) {
  const { rows } = await query(
    `UPDATE course_registrations r
     SET status = 'dropped', dropped_at = now()
     FROM courses c JOIN semesters s ON s.id = c.semester_id
     WHERE r.course_id = $1 AND r.student_id = $2 AND r.status = 'registered'
       AND c.id = r.course_id AND s.ends_on >= $3::date
     RETURNING r.course_id`,
    [courseId, viewer.id, campusToday()],
  );
  if (rows.length === 0) {
    const course = await getCourse(viewer, courseId); // 404 if it does not exist
    if (!course.registrationOpen) throw new AppError(409, 'REGISTRATION_CLOSED', 'This semester is over, so courses can no longer be dropped.');
    throw new AppError(409, 'NOT_REGISTERED', 'You are not registered for this course.');
  }
  return getCourse(viewer, courseId);
}
