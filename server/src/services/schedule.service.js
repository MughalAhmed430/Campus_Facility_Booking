import { query } from '../db/pool.js';
import { addDays, isWeekend } from '../utils/campus-time.js';
import { completeEndedBookings } from './booking.service.js';
import { facilityNotFound, findBookingRules, isBookable } from './facility.service.js';

// The longest stretch one facility schedule request returns: a week.
export const MAX_SCHEDULE_DAYS = 7;

/**
 * SQL: `column` falls within `days` campus dates from `date` (both SQL expressions, such
 * as placeholders). Days run from campus midnight to campus midnight. The date arithmetic
 * happens in SQL, which has no trouble with the day after 31 December 9999.
 */
function withinDaysSql(column, date, days) {
  return `${column} >= (${date}::date::timestamp AT TIME ZONE 'Asia/Seoul')
       AND ${column} < ((${date}::date + ${days}::int)::timestamp AT TIME ZONE 'Asia/Seoul')`;
}

/** Opening hours apply on every open day; a facility closed at weekends is closed on Saturday and Sunday. */
function isOpenOn(date, openWeekends) {
  return openWeekends || !isWeekend(date);
}

/**
 * One facility's bookings for `days` days from `from` (campus dates), as `viewerId`
 * sees them. 404 FACILITY_NOT_FOUND if it does not exist.
 *
 * Each day lists, in time order:
 *   kind 'booked'        someone's approved or completed booking: times only, never who
 *   kind 'yours'         the viewer's own approved or completed booking
 *   kind 'your-request'  the viewer's own pending request
 * Other people's pending requests are left out. They do not hold the time (only an
 * approved booking does), and who asked for what is not other students' business.
 */
export async function facilitySchedule(facilityId, { from, days, viewerId }) {
  const facility = await findBookingRules(facilityId);
  if (!facility) throw facilityNotFound();

  const { rows } = await query(
    `SELECT to_char(start_time AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS date,
            to_char(start_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS starts,
            to_char(end_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS ends,
            status = 'pending' AS is_request,
            user_id = $4 AS is_yours
     FROM bookings
     WHERE facility_id = $1
       AND ${withinDaysSql('start_time', '$2', '$3')}
       AND (status IN ('approved', 'completed') OR (status = 'pending' AND user_id = $4))
     ORDER BY start_time, id`,
    [facilityId, from, days, viewerId],
  );

  const { opensAt, closesAt, openWeekends } = facility;
  return {
    facilityId,
    from,
    openingHours: { opensAt, closesAt, openWeekends },
    isBookable: facility.isBookable,
    days: Array.from({ length: days }, (_, index) => {
      const date = addDays(from, index);
      return {
        date,
        isOpen: isOpenOn(date, openWeekends),
        bookings: rows.filter((row) => row.date === date).map((row) => ({
          startTime: row.starts,
          endTime: row.ends,
          kind: bookingKind(row),
        })),
      };
    }),
  };
}

function bookingKind(row) {
  if (row.is_request) return 'your-request';
  return row.is_yours ? 'yours' : 'booked';
}

// Facilities on the administrators' day schedule: every one that can be booked or is
// only closed for a while. Retired (inactive) ones appear only on a day they have bookings.
const ALWAYS_LISTED = ['active', 'maintenance'];

// What the day schedule shows: what holds the time, and what is waiting for a decision.
const SHOWN_STATUSES = ['approved', 'completed', 'pending'];

/**
 * Administrators: every facility's bookings on one campus date, with who booked and why,
 * so the whole campus day can be seen at once. Pending requests are included, so
 * competing requests for the same time are visible. type (optional) limits it to one
 * facility type. Facilities are in the same order as the facility list.
 */
export async function daySchedule({ date, type }) {
  await completeEndedBookings(); // so a booking that has ended shows as completed

  const { rows: facilities } = await query(
    `SELECT f.id, f.name, f.facility_type, f.room_number, f.capacity, f.status, f.is_open_weekends,
            to_char(f.opens_at, 'HH24:MI') AS opens_at,
            to_char(f.closes_at, 'HH24:MI') AS closes_at,
            b.code AS building_code, b.name AS building_name
     FROM facilities f
     JOIN buildings b ON b.id = f.building_id
     WHERE ($1::text IS NULL OR f.facility_type = $1::text)
       AND (f.status = ANY($3::text[]) OR EXISTS (
         SELECT 1 FROM bookings x
         WHERE x.facility_id = f.id
           AND x.status = ANY($4::text[])
           AND ${withinDaysSql('x.start_time', '$2', '1')}
       ))
     ORDER BY CASE f.status WHEN 'active' THEN 1 WHEN 'maintenance' THEN 2 ELSE 3 END,
              b.name, f.room_number, f.id`,
    [type ?? null, date, ALWAYS_LISTED, SHOWN_STATUSES],
  );

  const { rows: bookings } = await query(
    `SELECT bk.id, bk.facility_id, bk.status, bk.attendees, bk.purpose, bk.notes,
            to_char(bk.start_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS starts,
            to_char(bk.end_time AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS ends,
            u.id AS student_id, u.full_name, u.email, u.student_number
     FROM bookings bk
     JOIN users u ON u.id = bk.user_id
     WHERE bk.facility_id = ANY($1::int[])
       AND ${withinDaysSql('bk.start_time', '$2', '1')}
       AND bk.status = ANY($3::text[])
     ORDER BY bk.start_time, bk.id`,
    [facilities.map((row) => row.id), date, SHOWN_STATUSES],
  );

  return {
    date,
    facilities: facilities.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.facility_type,
      roomNumber: row.room_number,
      capacity: row.capacity,
      status: row.status,
      isBookable: isBookable(row.status),
      building: { code: row.building_code, name: row.building_name },
      openingHours: { opensAt: row.opens_at, closesAt: row.closes_at, openWeekends: row.is_open_weekends },
      isOpen: isOpenOn(date, row.is_open_weekends),
      bookings: bookings.filter((booking) => booking.facility_id === row.id).map(toScheduleBooking),
    })),
  };
}

function toScheduleBooking(row) {
  return {
    id: row.id,
    status: row.status,
    startTime: row.starts,
    endTime: row.ends,
    participantCount: row.attendees,
    purpose: row.purpose,
    notes: row.notes,
    student: { id: row.student_id, fullName: row.full_name, email: row.email, studentNumber: row.student_number },
  };
}
