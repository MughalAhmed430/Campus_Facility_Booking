import { query } from '../db/pool.js';
import { addDays, campusInstant, isWeekend } from '../utils/campus-time.js';
import { BOOKING_STATUSES } from './booking.service.js';

/** The longest range a report covers: one year, counting both end dates. */
export const REPORT_MAX_DAYS = 366;
/** The range used when none is asked for: today and the 29 days before it. */
export const REPORT_DEFAULT_DAYS = 30;

/**
 * Key figures for bookings whose date (Korea time) is from `from` to `to`, inclusive.
 * Read-only. Returns { range, totals, byStatus, facilities }:
 *
 *   range       { from, to, days, weekdays }
 *   totals      requests            every booking request in the range, whatever became of it
 *               decided             requests an administrator approved or rejected
 *               approved            of those, the approved ones (including bookings that were
 *                                   completed, or cancelled after approval)
 *               approvalRatePercent approved / decided, or null when nothing was decided
 *               bookedHours         hours of approved and completed bookings, all facilities
 *               openHours           hours the counted facilities were open (see below)
 *               utilizationPercent  booked hours of the counted facilities / openHours, or null
 *   byStatus    { pending, approved, rejected, cancelled, completed }: a count for each
 *   facilities  every facility, busiest first: id, name, building { code, name }, roomNumber,
 *               type, status, bookings (approved and completed), bookedHours, openHours and
 *               utilizationPercent (both null for an inactive facility)
 *
 * UTILIZATION IS A SIMPLIFICATION. Open hours are a facility's daily opening hours times
 * the days of the range it is open (weekends skipped when it is closed at weekends), using
 * its hours and status AS THEY ARE NOW: the schema keeps no history of earlier hours,
 * closures or holidays. Inactive facilities are left out of the totals; a facility under
 * maintenance is counted, because it is expected back. The page and the README say so.
 */
export async function getSummary({ from, to }) {
  // Bookings never cross midnight (they lie inside one day's opening hours), so a
  // booking belongs to the day it starts on.
  const range = [campusInstant(from, '00:00'), campusInstant(addDays(to, 1), '00:00')];

  const [{ rows: statusRows }, { rows: facilityRows }] = await Promise.all([
    query(
      `SELECT status,
              count(*)::int AS total,
              count(*) FILTER (WHERE decided_at IS NOT NULL)::int AS decided
       FROM bookings
       WHERE start_time >= $1::timestamptz AND start_time < $2::timestamptz
       GROUP BY status`,
      range,
    ),
    query(
      `SELECT f.id, f.name, f.room_number, f.facility_type, f.status, f.is_open_weekends,
              (extract(epoch FROM f.closes_at - f.opens_at) / 60)::int AS open_minutes_per_day,
              b.code AS building_code, b.name AS building_name,
              count(k.id)::int AS bookings,
              coalesce(sum(extract(epoch FROM k.end_time - k.start_time) / 60), 0)::int AS booked_minutes
       FROM facilities f
       JOIN buildings b ON b.id = f.building_id
       LEFT JOIN bookings k ON k.facility_id = f.id
                           AND k.status IN ('approved', 'completed')
                           AND k.start_time >= $1::timestamptz AND k.start_time < $2::timestamptz
       GROUP BY f.id, b.id
       ORDER BY booked_minutes DESC, f.name, f.id`,
      range,
    ),
  ]);

  const byStatus = Object.fromEntries(BOOKING_STATUSES.map((status) => [status, 0]));
  let decided = 0;
  let approved = 0;
  for (const row of statusRows) {
    byStatus[row.status] = row.total;
    // decided_at is set on approval or rejection and kept afterwards, so a cancelled
    // booking counts only if it was approved before it was cancelled. Pending rows have none.
    decided += row.decided;
    if (row.status !== 'rejected') approved += row.decided;
  }

  const { days, weekdays } = countDays(from, to);
  let bookedMinutes = 0;
  let countedBookedMinutes = 0;
  let openMinutes = 0;
  const facilities = facilityRows.map((row) => {
    const counted = row.status !== 'inactive';
    const open = counted ? row.open_minutes_per_day * (row.is_open_weekends ? days : weekdays) : null;
    bookedMinutes += row.booked_minutes;
    if (counted) {
      countedBookedMinutes += row.booked_minutes;
      openMinutes += open;
    }
    return {
      id: row.id,
      name: row.name,
      building: { code: row.building_code, name: row.building_name },
      roomNumber: row.room_number,
      type: row.facility_type,
      status: row.status,
      bookings: row.bookings,
      bookedHours: hours(row.booked_minutes),
      openHours: counted ? hours(open) : null,
      utilizationPercent: counted ? percent(row.booked_minutes, open) : null,
    };
  });

  return {
    range: { from, to, days, weekdays },
    totals: {
      requests: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      decided,
      approved,
      approvalRatePercent: percent(approved, decided),
      bookedHours: hours(bookedMinutes),
      openHours: hours(openMinutes),
      utilizationPercent: percent(countedBookedMinutes, openMinutes),
    },
    byStatus,
    facilities,
  };
}

/** The days from `from` to `to`, inclusive, and how many of them are Monday to Friday. */
function countDays(from, to) {
  let days = 0;
  let weekdays = 0;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    days += 1;
    if (!isWeekend(date)) weekdays += 1;
  }
  return { days, weekdays };
}

/** 90 minutes -> 1.5 (two decimals at most). */
function hours(minutes) {
  return Math.round((minutes / 60) * 100) / 100;
}

/** part / whole as a percentage with one decimal; null when there is nothing to divide by. */
function percent(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}
