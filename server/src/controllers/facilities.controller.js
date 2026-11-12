import * as facilityService from '../services/facility.service.js';
import { FACILITY_STATUSES, FACILITY_TYPES } from '../services/facility.service.js';
import { campusToday, hasPassed } from '../utils/campus-time.js';
import { FieldValidator, MAX_INTEGER } from '../utils/validation.js';

const FREE_AT_FIELDS = ['date', 'startTime', 'endTime'];

function parseListQuery(queryParams) {
  const v = new FieldValidator(queryParams);
  const filters = {
    search: v.string('q', { label: 'Search', required: false, max: 100 }),
    type: v.oneOf('type', FACILITY_TYPES, { label: 'Type', required: false }),
    buildingId: v.integer('building', { label: 'Building', required: false, min: 1, max: MAX_INTEGER }),
    minCapacity: v.integer('minCapacity', { label: 'Minimum capacity', required: false, min: 1, max: 1000 }),
    equipmentIds: v.integerList('equipment', { label: 'Equipment', required: false, max: MAX_INTEGER, maxItems: 20 }),
    statuses: v.oneOfList('status', FACILITY_STATUSES, { label: 'Status', required: false }),
    freeAt: parseFreeAt(v, queryParams),
  };
  v.assertValid();
  return filters;
}

/**
 * "Free at": a date, a start time and an end time, all three or none. Checked like the
 * times of a booking request, except for its length: any stretch of time may be searched.
 */
function parseFreeAt(v, queryParams) {
  const wanted = FREE_AT_FIELDS.some((name) => queryParams[name] !== undefined && queryParams[name] !== '');
  const date = v.date('date', { label: 'Date', required: wanted });
  const startTime = v.time('startTime', { label: 'Start time', required: wanted });
  const endTime = v.time('endTime', { label: 'End time', required: wanted });
  if (!wanted) return undefined;

  if (date !== undefined && date < campusToday()) {
    v.addError('date', 'Choose today or a later date.');
  } else if (date !== undefined && startTime !== undefined && hasPassed(date, startTime)) {
    v.addError('startTime', 'This start time has already passed. Choose a later time.');
  }
  if (startTime !== undefined && endTime !== undefined && endTime <= startTime) {
    v.addError('endTime', 'End time must be after the start time.');
  }
  return { date, startTime, endTime };
}

function parseFacilityId(params) {
  const v = new FieldValidator(params);
  const id = v.integer('id', { label: 'Facility id', min: 1, max: MAX_INTEGER });
  v.assertValid();
  return id;
}

/**
 * GET /api/facilities?q=&type=&building=&minCapacity=&equipment=1,3&status=active
 *                    &date=YYYY-MM-DD&startTime=HH:MM&endTime=HH:MM  (free then; all three or none)
 * -> 200 { facilities: [...], total }
 */
export async function list(req, res) {
  const filters = parseListQuery(req.query);
  const facilities = await facilityService.listFacilities(filters);
  res.json({ success: true, data: { facilities, total: facilities.length } });
}

/** GET /api/facilities/:id -> 200 { facility }, 404 FACILITY_NOT_FOUND */
export async function getById(req, res) {
  const id = parseFacilityId(req.params);
  const facility = await facilityService.getFacilityById(id);
  res.json({ success: true, data: { facility } });
}
