import * as facilityService from '../services/facility.service.js';
import { FACILITY_STATUSES, FACILITY_TYPES } from '../services/facility.service.js';
import { FieldValidator, MAX_INTEGER } from '../utils/validation.js';

function parseListQuery(queryParams) {
  const v = new FieldValidator(queryParams);
  const filters = {
    search: v.string('q', { label: 'Search', required: false, max: 100 }),
    type: v.oneOf('type', FACILITY_TYPES, { label: 'Type', required: false }),
    buildingId: v.integer('building', { label: 'Building', required: false, min: 1, max: MAX_INTEGER }),
    minCapacity: v.integer('minCapacity', { label: 'Minimum capacity', required: false, min: 1, max: 1000 }),
    equipmentIds: v.integerList('equipment', { label: 'Equipment', required: false, max: MAX_INTEGER, maxItems: 20 }),
    statuses: v.oneOfList('status', FACILITY_STATUSES, { label: 'Status', required: false }),
  };
  v.assertValid();
  return filters;
}

function parseFacilityId(params) {
  const v = new FieldValidator(params);
  const id = v.integer('id', { label: 'Facility id', min: 1, max: MAX_INTEGER });
  v.assertValid();
  return id;
}

/**
 * GET /api/facilities?q=&type=&building=&minCapacity=&equipment=1,3&status=active
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
