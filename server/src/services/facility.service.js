import { query } from '../db/pool.js';
import AppError from '../utils/app-error.js';
import { campusInstant, isWeekend } from '../utils/campus-time.js';

export const FACILITY_TYPES = Object.freeze(['classroom', 'laboratory', 'meeting_room']);
export const FACILITY_STATUSES = Object.freeze(['active', 'maintenance', 'inactive']);

// Columns shared by the list and the detail view. Times are formatted in SQL ("09:00")
// so every driver returns the same text. Equipment is collected per facility as JSON.
const FACILITY_COLUMNS = `
  f.id, f.name, f.facility_type, f.room_number, f.floor, f.capacity, f.status,
  to_char(f.opens_at, 'HH24:MI') AS opens_at,
  to_char(f.closes_at, 'HH24:MI') AS closes_at,
  f.is_open_weekends,
  b.id AS building_id, b.code AS building_code, b.name AS building_name`;

/**
 * Lists facilities matching every given filter (all are optional):
 *   search        text found in the name, room number, building code/name, or "ENG 310"
 *   type          'classroom' | 'laboratory' | 'meeting_room'
 *   buildingId    one building
 *   minCapacity   at least this many seats
 *   equipmentIds  facilities that have ALL of these equipment types
 *   statuses      e.g. ['active'] for bookable facilities only
 *   freeAt        { date, startTime, endTime } (campus time): only facilities that could
 *                 take a booking then. They are bookable, open that day for that whole
 *                 time, and no approved booking takes any of it. Pending requests do
 *                 not count: they hold no time until one is approved.
 * Bookable facilities come first, then by building and room.
 */
export async function listFacilities({ search, type, buildingId, minCapacity, equipmentIds, statuses, freeAt } = {}) {
  const conditions = [];
  const params = [];
  // Adds a value to the parameter list and returns its placeholder ($1, $2, ...).
  // User input only ever travels as a parameter, never inside the SQL text.
  const param = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (search) {
    const pattern = param(`%${escapeLikePattern(search)}%`);
    conditions.push(`(
      f.name ILIKE ${pattern} OR f.room_number ILIKE ${pattern}
      OR b.code ILIKE ${pattern} OR b.name ILIKE ${pattern}
      OR (b.code || ' ' || f.room_number) ILIKE ${pattern}
    )`);
  }
  if (type) conditions.push(`f.facility_type = ${param(type)}`);
  if (buildingId) conditions.push(`f.building_id = ${param(buildingId)}`);
  if (minCapacity) conditions.push(`f.capacity >= ${param(minCapacity)}`);
  if (statuses?.length) conditions.push(`f.status = ANY(${param(statuses)}::text[])`);
  if (equipmentIds?.length) {
    // (facility_id, equipment_id) is the primary key, so counting the matching rows
    // tells whether the facility has every requested type.
    const ids = param(equipmentIds);
    conditions.push(`(
      SELECT count(*) FROM facility_equipment fe
      WHERE fe.facility_id = f.id AND fe.equipment_id = ANY(${ids}::int[])
    ) = cardinality(${ids}::int[])`);
  }
  if (freeAt) {
    const { date, startTime, endTime } = freeAt;
    conditions.push(`f.status = ANY(${param(FACILITY_STATUSES.filter(isBookable))}::text[])`);
    if (isWeekend(date)) conditions.push('f.is_open_weekends');
    // The same rule as a booking request: start at or after opening, end by closing time.
    conditions.push(`f.opens_at <= ${param(startTime)}::time AND f.closes_at >= ${param(endTime)}::time`);
    // Approved and completed bookings hold time (the statuses bookings_no_overlap covers).
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM bookings x
      WHERE x.facility_id = f.id
        AND x.status IN ('approved', 'completed')
        AND tstzrange(x.start_time, x.end_time, '[)')
            && tstzrange(${param(campusInstant(date, startTime))}::timestamptz, ${param(campusInstant(date, endTime))}::timestamptz, '[)')
    )`);
  }

  const { rows } = await query(
    `SELECT ${FACILITY_COLUMNS},
            COALESCE((
              SELECT json_agg(json_build_object('id', e.id, 'name', e.name, 'quantity', fe.quantity) ORDER BY e.name)
              FROM facility_equipment fe
              JOIN equipment e ON e.id = fe.equipment_id
              WHERE fe.facility_id = f.id
            ), '[]'::json) AS equipment
     FROM facilities f
     JOIN buildings b ON b.id = f.building_id
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY CASE f.status WHEN 'active' THEN 1 WHEN 'maintenance' THEN 2 ELSE 3 END,
              b.name, f.room_number, f.id`,
    params,
  );
  return rows.map(toFacilitySummary);
}

/** One facility with its description, building details and equipment. 404 if it does not exist. */
export async function getFacilityById(id) {
  const { rows } = await query(
    `SELECT ${FACILITY_COLUMNS},
            f.description, f.updated_at,
            b.description AS building_description,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'id', e.id, 'name', e.name, 'quantity', fe.quantity, 'description', e.description
                     ) ORDER BY e.name)
              FROM facility_equipment fe
              JOIN equipment e ON e.id = fe.equipment_id
              WHERE fe.facility_id = f.id
            ), '[]'::json) AS equipment
     FROM facilities f
     JOIN buildings b ON b.id = f.building_id
     WHERE f.id = $1`,
    [id],
  );
  if (rows.length === 0) throw facilityNotFound();
  const row = rows[0];
  const summary = toFacilitySummary(row);
  return {
    ...summary,
    description: row.description,
    building: { ...summary.building, description: row.building_description },
    updatedAt: row.updated_at.toISOString(),
  };
}

/** What a booking request is checked against, or null if the facility does not exist. */
export async function findBookingRules(id) {
  const { rows } = await query(
    `SELECT status, capacity, is_open_weekends,
            to_char(opens_at, 'HH24:MI') AS opens_at,
            to_char(closes_at, 'HH24:MI') AS closes_at
     FROM facilities
     WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const [row] = rows;
  return {
    isBookable: isBookable(row.status),
    capacity: row.capacity,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    openWeekends: row.is_open_weekends,
  };
}

export function facilityNotFound() {
  return new AppError(404, 'FACILITY_NOT_FOUND', 'This facility does not exist or has been removed.');
}

// Only active facilities accept booking requests; maintenance and inactive ones are
// listed so students know they exist, but cannot be requested or approved.
export function isBookable(status) {
  return status === 'active';
}

function toFacilitySummary(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.facility_type,
    roomNumber: row.room_number,
    floor: row.floor,
    capacity: row.capacity,
    status: row.status,
    isBookable: isBookable(row.status),
    // Korea time. openWeekends false: closed on Saturday and Sunday. The same hours
    // apply on every day the facility is open.
    openingHours: { opensAt: row.opens_at, closesAt: row.closes_at, openWeekends: row.is_open_weekends },
    building: { id: row.building_id, code: row.building_code, name: row.building_name },
    equipment: row.equipment,
  };
}

/** In ILIKE patterns % and _ are wildcards; a search for "50%" must match the literal text. */
function escapeLikePattern(text) {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}
