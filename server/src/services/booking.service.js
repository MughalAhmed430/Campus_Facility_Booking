import { query, withTransaction } from '../db/pool.js';
import AppError from '../utils/app-error.js';
import { campusInstant, campusToday, currentInstant, hasPassed, isWeekend } from '../utils/campus-time.js';
import { findBookingRules, getFacilityById, isBookable } from './facility.service.js';

// Long enough for a real meeting; short enough that one request cannot hold a room for
// most of a day. The longest booking in the sample data is 3 hours.
export const MIN_BOOKING_MINUTES = 30;
export const MAX_BOOKING_MINUTES = 240;

/**
 * Every status change a booking can make. A new booking always starts as 'pending'.
 * Each UPDATE that changes a status matches only rows whose current status allows that
 * change, so when two requests race to change the same booking, at most one succeeds.
 */
export const STATUS_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['approved', 'rejected', 'cancelled']),
  approved: Object.freeze(['completed', 'cancelled']),
  rejected: Object.freeze([]),
  cancelled: Object.freeze([]),
  completed: Object.freeze([]),
});

/** The statuses a booking can move to `target` from: statusesLeadingTo('cancelled') -> ['pending', 'approved']. */
export function statusesLeadingTo(target) {
  return Object.keys(STATUS_TRANSITIONS).filter((status) => STATUS_TRANSITIONS[status].includes(target));
}

/**
 * The cancellation rule. A pending request can be cancelled at any time, even after its
 * start time: it never held the slot. An approved booking only until it starts.
 * cancelOwnBooking applies the same rule in its UPDATE.
 */
function isCancellable(status, hasStarted) {
  return statusesLeadingTo('cancelled').includes(status) && (status !== 'approved' || !hasStarted);
}

// Why a cancellation was refused, by the booking's current status.
const NOT_CANCELLABLE = {
  approved: 'This booking has already started, so it can no longer be cancelled.',
  rejected: 'This request was rejected, so there is nothing to cancel.',
  cancelled: 'This booking has already been cancelled.',
  completed: 'This booking is over, so it can no longer be cancelled.',
};

function minutesOf(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Adds an error to `v` for every rule the request breaks. Fields that already failed
 * their format check arrive as undefined and are skipped, so each problem is reported
 * once and they all reach the client in the same 400.
 */
export async function checkBookingRules(v, { facilityId, date, startTime, endTime, participantCount }) {
  if (date !== undefined && date < campusToday()) {
    v.addError('date', 'Choose today or a later date.');
  } else if (date !== undefined && startTime !== undefined && hasPassed(date, startTime)) {
    v.addError('startTime', 'This start time has already passed. Choose a later time.');
  }

  if (startTime !== undefined && endTime !== undefined) {
    const length = minutesOf(endTime) - minutesOf(startTime);
    if (length <= 0) v.addError('endTime', 'End time must be after the start time.');
    else if (length < MIN_BOOKING_MINUTES) v.addError('endTime', `A booking must last at least ${MIN_BOOKING_MINUTES} minutes.`);
    else if (length > MAX_BOOKING_MINUTES) v.addError('endTime', `A booking can last at most ${MAX_BOOKING_MINUTES / 60} hours.`);
  }

  if (facilityId === undefined) return;
  const facility = await findBookingRules(facilityId);
  if (!facility) {
    v.addError('facilityId', 'This facility does not exist.');
    return;
  }
  if (!facility.isBookable) {
    v.addError('facilityId', 'This facility is not taking booking requests at the moment.');
  }
  if (participantCount !== undefined && participantCount > facility.capacity) {
    v.addError('participantCount', `This facility holds at most ${facility.capacity} ${facility.capacity === 1 ? 'person' : 'people'}.`);
  }
  if (date !== undefined && !facility.openWeekends && isWeekend(date)) {
    v.addError('date', 'This facility is closed on Saturdays and Sundays.');
  }

  // "HH:MM" text sorts in time order. The end of the booking may be the closing time itself.
  const { opensAt, closesAt } = facility;
  const outsideHours = `Must be inside the opening hours, ${opensAt}–${closesAt}.`;
  if (startTime !== undefined && (startTime < opensAt || startTime >= closesAt)) v.addError('startTime', outsideHours);
  if (endTime !== undefined && (endTime <= opensAt || endTime > closesAt)) v.addError('endTime', outsideHours);
}

/**
 * Creates a request for `userId`, always as 'pending'. Rejected with 409 BOOKING_CONFLICT
 * if an approved or completed booking already covers any of the time.
 *
 * bookings_no_overlap only covers approved and completed rows, so inserting a pending row
 * can never violate it (no 23P01 here). The overlap check is therefore part of this one
 * statement instead. An approval committing at the same instant could slip past it, which
 * is harmless: this request is only pending, and approving it later fails on the constraint.
 */
export async function createBookingRequest(userId, { facilityId, date, startTime, endTime, participantCount, purpose, notes }) {
  const { rows } = await query(
    `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, notes, status)
     SELECT $1::int, $2::int, $3::timestamptz, $4::timestamptz, $5::int, $6::varchar, $7::varchar, 'pending'
     WHERE NOT EXISTS (
       SELECT 1
       FROM bookings
       WHERE facility_id = $2::int
         AND status IN ('approved', 'completed')
         AND tstzrange(start_time, end_time, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
     )
     RETURNING id, status, created_at`,
    [userId, facilityId, campusInstant(date, startTime), campusInstant(date, endTime), participantCount, purpose, notes ?? null],
  );
  if (rows.length === 0) {
    throw new AppError(409, 'BOOKING_CONFLICT', 'This time is already booked. Choose a different time.');
  }
  const [row] = rows;
  return {
    id: row.id,
    facilityId,
    date,
    startTime,
    endTime,
    participantCount,
    purpose,
    notes: notes ?? null,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

/** The times of a facility's approved bookings on one campus date. Says nothing about who booked. 404 if it does not exist. */
export async function listApprovedTimes(facilityId, date) {
  await getFacilityById(facilityId);
  const { rows } = await query(
    `SELECT to_char(start_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS starts,
            to_char(end_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS ends
     FROM bookings
     WHERE facility_id = $1
       AND status = 'approved'
       AND start_time >= $2::timestamptz
       AND start_time < $2::timestamptz + interval '24 hours'
     ORDER BY start_time`,
    [facilityId, campusInstant(date, '00:00')],
  );
  return rows.map((row) => ({ startTime: row.starts, endTime: row.ends }));
}

/**
 * Marks approved bookings that have ended as completed. Nothing else does this: it runs
 * whenever bookings are listed, instead of on a timer. Running it again changes nothing.
 * userId: only that student's bookings (omit it for everyone's).
 */
export async function completeEndedBookings({ userId = null, now = currentInstant() } = {}) {
  await query(
    `UPDATE bookings
     SET status = 'completed'
     WHERE status = ANY($1::text[])
       AND end_time <= $2::timestamptz
       AND ($3::int IS NULL OR user_id = $3::int)`,
    [statusesLeadingTo('completed'), now.toISOString(), userId],
  );
}

/** Every booking of one student, latest start first, with what they may do with each. */
export async function listOwnBookings(userId) {
  const now = currentInstant();
  await completeEndedBookings({ userId, now });
  return selectOwnBookings({ userId, now });
}

/**
 * Cancels one of the student's own bookings (the rule is isCancellable above). Returns
 * the booking as it is now. 404 BOOKING_NOT_FOUND if it does not exist or belongs to
 * someone else: the two look the same, so ids reveal nothing about other students.
 * 409 BOOKING_NOT_CANCELLABLE otherwise, saying why.
 *
 * One conditional UPDATE decides, so two cancellations sent at once cannot both succeed,
 * and a booking cannot be cancelled after its status has changed somewhere else.
 */
export async function cancelOwnBooking(userId, bookingId, { reason } = {}) {
  const now = currentInstant();
  const { rows: cancelled } = await query(
    `UPDATE bookings
     SET status = 'cancelled', cancelled_by = $2, cancelled_at = now(), cancellation_reason = $3
     WHERE id = $1
       AND user_id = $2
       AND status = ANY($4::text[])
       AND (status <> 'approved' OR start_time > $5::timestamptz)
     RETURNING id`,
    [bookingId, userId, reason ?? null, statusesLeadingTo('cancelled'), now.toISOString()],
  );

  if (cancelled.length === 0) {
    const { rows } = await query('SELECT user_id, status FROM bookings WHERE id = $1', [bookingId]);
    if (rows.length === 0 || rows[0].user_id !== userId) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'This booking does not exist, or it is not one of yours.');
    }
    throw new AppError(409, 'BOOKING_NOT_CANCELLABLE', NOT_CANCELLABLE[rows[0].status] ?? 'This booking can no longer be cancelled.');
  }

  const [booking] = await selectOwnBookings({ userId, bookingId, now });
  return booking;
}

async function selectOwnBookings({ userId, bookingId = null, now }) {
  const { rows } = await query(
    `SELECT b.id, b.status, b.attendees, b.purpose, b.notes,
            b.decided_at, b.decision_note,
            b.cancelled_at, b.cancellation_reason, b.cancelled_by = b.user_id AS cancelled_by_owner,
            b.created_at,
            to_char(b.start_time AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS date,
            to_char(b.start_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS starts,
            to_char(b.end_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS ends,
            b.start_time <= $2::timestamptz AS has_started,
            f.id AS facility_id, f.name AS facility_name, f.room_number,
            bl.code AS building_code, bl.name AS building_name
     FROM bookings b
     JOIN facilities f ON f.id = b.facility_id
     JOIN buildings bl ON bl.id = f.building_id
     WHERE b.user_id = $1
       AND ($3::int IS NULL OR b.id = $3::int)
     ORDER BY b.start_time DESC, b.id DESC`,
    [userId, now.toISOString(), bookingId],
  );
  return rows.map(toOwnBooking);
}

// ---- Reviewing requests (administrators) ---------------------------------------------

/** SQL: the booking rows `a` and `b` overlap in time ('[)': back-to-back is not an overlap). */
function overlapSql(a, b) {
  return `tstzrange(${a}.start_time, ${a}.end_time, '[)') && tstzrange(${b}.start_time, ${b}.end_time, '[)')`;
}

// The note recorded on requests rejected because an overlapping one was approved.
export const AUTO_REJECT_NOTE = 'Another request for this time was approved.';

// Why an approval or rejection was refused, by the request's current status.
const NOT_PENDING = {
  approved: 'This request has already been approved.',
  rejected: 'This request has already been rejected.',
  cancelled: 'The student has cancelled this request.',
  completed: 'This booking is already over.',
};

function requestNotFound() {
  return new AppError(404, 'BOOKING_NOT_FOUND', 'This request does not exist.');
}

function notPending(status) {
  return new AppError(409, 'BOOKING_NOT_PENDING', NOT_PENDING[status] ?? 'This request is no longer waiting for a decision.');
}

/**
 * The review queue: pending requests that have not started yet, soonest first (those
 * need a decision first). Each lists the other pending requests it overlaps (approving
 * it rejects them) and whether an approved booking already takes part of its time (it
 * cannot be approved then).
 */
export async function listPendingRequests() {
  const { rows } = await query(
    `SELECT b.id, b.attendees, b.purpose, b.notes, b.created_at,
            to_char(b.start_time AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS date,
            to_char(b.start_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS starts,
            to_char(b.end_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS ends,
            u.id AS student_id, u.full_name, u.email, u.student_number,
            f.id AS facility_id, f.name AS facility_name, f.room_number, f.capacity, f.status AS facility_status,
            bl.code AS building_code, bl.name AS building_name,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'id', o.id,
                       'studentName', ou.full_name,
                       'startTime', to_char(o.start_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI'),
                       'endTime', to_char(o.end_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI')
                     ) ORDER BY o.start_time, o.id)
              FROM bookings o
              JOIN users ou ON ou.id = o.user_id
              WHERE o.facility_id = b.facility_id
                AND o.id <> b.id
                AND o.status = 'pending'
                AND ${overlapSql('o', 'b')}
            ), '[]'::json) AS overlapping,
            EXISTS (
              SELECT 1
              FROM bookings a
              WHERE a.facility_id = b.facility_id
                AND a.status IN ('approved', 'completed')
                AND ${overlapSql('a', 'b')}
            ) AS time_taken
     FROM bookings b
     JOIN users u ON u.id = b.user_id
     JOIN facilities f ON f.id = b.facility_id
     JOIN buildings bl ON bl.id = f.building_id
     WHERE b.status = 'pending'
       AND b.start_time > $1::timestamptz
     ORDER BY b.start_time, b.id`,
    [currentInstant().toISOString()],
  );
  return rows.map(toReviewRequest);
}

/**
 * Approves a pending request for `adminId`, and in the same transaction rejects every
 * other pending request that overlaps it in the same facility (they could never be
 * approved now). Returns { booking, autoRejected: [ids] }. Either all of it happens or
 * none of it does.
 *
 * Refused with 404 BOOKING_NOT_FOUND, or 409: BOOKING_NOT_PENDING (decided or cancelled
 * already), BOOKING_STARTED, FACILITY_NOT_BOOKABLE, or BOOKING_CONFLICT when an approved
 * booking already takes part of the time. That last check is bookings_no_overlap itself:
 * the database refuses the UPDATE, whatever else is happening at the same moment.
 */
export async function approveRequest(adminId, bookingId, { note } = {}) {
  const now = currentInstant();
  try {
    return await withTransaction(async (tx) => {
      // Lock the request and every pending request overlapping it, in id order, before
      // deciding anything. A second approval, rejection or cancellation touching any of
      // them waits here until this transaction ends, then sees its result. Taking the
      // locks in one fixed order means two approvals can never wait for each other.
      await tx.query(
        `SELECT o.id
         FROM bookings b
         JOIN bookings o ON o.facility_id = b.facility_id
                        AND (o.id = b.id OR (o.status = 'pending' AND ${overlapSql('o', 'b')}))
         WHERE b.id = $1
         ORDER BY o.id
         FOR UPDATE OF o`,
        [bookingId],
      );

      const { rows: [request] } = await tx.query(
        `SELECT b.status, b.start_time <= $2::timestamptz AS has_started, f.status AS facility_status
         FROM bookings b
         JOIN facilities f ON f.id = b.facility_id
         WHERE b.id = $1`,
        [bookingId, now.toISOString()],
      );
      if (!request) throw requestNotFound();
      if (request.status !== 'pending') throw notPending(request.status);
      if (request.has_started) {
        throw new AppError(409, 'BOOKING_STARTED', 'This request\'s start time has passed, so it can no longer be approved.');
      }
      if (!isBookable(request.facility_status)) {
        throw new AppError(409, 'FACILITY_NOT_BOOKABLE', 'This facility is not taking bookings at the moment, so the request cannot be approved.');
      }

      const { rows: [approved] } = await tx.query(
        `UPDATE bookings
         SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3
         WHERE id = $1 AND status = ANY($4::text[])
         RETURNING decided_at`,
        [bookingId, adminId, note ?? null, statusesLeadingTo('approved')],
      );

      const { rows: rejected } = await tx.query(
        `UPDATE bookings o
         SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
         FROM bookings b
         WHERE b.id = $1
           AND o.facility_id = b.facility_id
           AND o.id <> b.id
           AND o.status = ANY($4::text[])
           AND ${overlapSql('o', 'b')}
         RETURNING o.id`,
        [bookingId, adminId, AUTO_REJECT_NOTE, statusesLeadingTo('rejected')],
      );

      return {
        booking: { id: bookingId, status: 'approved', decision: { decidedAt: approved.decided_at.toISOString(), note: note ?? null } },
        autoRejected: rejected.map((row) => row.id).sort((a, b) => a - b),
      };
    });
  } catch (err) {
    if (err.code === '23P01') { // exclusion_violation: bookings_no_overlap
      throw new AppError(409, 'BOOKING_CONFLICT', 'Another booking has already been approved for part of this time, so this request cannot be approved.', { cause: err });
    }
    if (err.code === '40P01') { // deadlock_detected: should not happen with the lock order above
      throw new AppError(409, 'BOOKING_CONFLICT', 'Another decision about this time was being saved at the same moment. Reload the list and try again.', { cause: err });
    }
    throw err;
  }
}

/**
 * Rejects a pending request with the administrator's reason. One conditional UPDATE
 * decides, so it cannot overwrite a decision or cancellation made at the same moment.
 * 404 BOOKING_NOT_FOUND, or 409 BOOKING_NOT_PENDING. A request whose start time has
 * passed can still be rejected, to clear it.
 */
export async function rejectRequest(adminId, bookingId, { reason }) {
  const { rows: [rejected] } = await query(
    `UPDATE bookings
     SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
     WHERE id = $1 AND status = ANY($4::text[])
     RETURNING decided_at`,
    [bookingId, adminId, reason, statusesLeadingTo('rejected')],
  );
  if (!rejected) {
    const { rows: [current] } = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    throw current ? notPending(current.status) : requestNotFound();
  }
  return { booking: { id: bookingId, status: 'rejected', decision: { decidedAt: rejected.decided_at.toISOString(), note: reason } } };
}

// What an administrator sees of a request in the review queue.
function toReviewRequest(row) {
  const facilityBookable = isBookable(row.facility_status);
  return {
    id: row.id,
    date: row.date,
    startTime: row.starts,
    endTime: row.ends,
    participantCount: row.attendees,
    purpose: row.purpose,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    student: { id: row.student_id, fullName: row.full_name, email: row.email, studentNumber: row.student_number },
    facility: {
      id: row.facility_id,
      name: row.facility_name,
      roomNumber: row.room_number,
      capacity: row.capacity,
      isBookable: facilityBookable,
      building: { code: row.building_code, name: row.building_name },
    },
    overlappingRequests: row.overlapping,
    timeTaken: row.time_taken,
    canApprove: facilityBookable && !row.time_taken,
  };
}

// What a student sees of their own booking. Administrators appear only as "an
// administrator": no names or ids.
function toOwnBooking(row) {
  return {
    id: row.id,
    status: row.status,
    facility: {
      id: row.facility_id,
      name: row.facility_name,
      roomNumber: row.room_number,
      building: { code: row.building_code, name: row.building_name },
    },
    date: row.date,
    startTime: row.starts,
    endTime: row.ends,
    participantCount: row.attendees,
    purpose: row.purpose,
    notes: row.notes,
    hasStarted: row.has_started,
    canCancel: isCancellable(row.status, row.has_started),
    createdAt: row.created_at.toISOString(),
    decision: row.decided_at ? { decidedAt: row.decided_at.toISOString(), note: row.decision_note } : null,
    cancellation: row.status === 'cancelled'
      ? { cancelledAt: row.cancelled_at.toISOString(), byYou: row.cancelled_by_owner, reason: row.cancellation_reason }
      : null,
  };
}
