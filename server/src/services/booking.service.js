import { query } from '../db/pool.js';
import AppError from '../utils/app-error.js';
import { campusInstant, campusToday, hasPassed, isWeekend } from '../utils/campus-time.js';
import { findBookingRules, getFacilityById } from './facility.service.js';

// Long enough for a real meeting; short enough that one request cannot hold a room for
// most of a day. The longest booking in the sample data is 3 hours.
export const MIN_BOOKING_MINUTES = 30;
export const MAX_BOOKING_MINUTES = 240;

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
