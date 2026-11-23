import multer from 'multer';
import * as facilityImageService from '../services/facility-image.service.js';
import * as facilityService from '../services/facility.service.js';
import AppError from '../utils/app-error.js';
import { FACILITY_STATUSES, FACILITY_TYPES } from '../services/facility.service.js';
import { campusToday, hasPassed } from '../utils/campus-time.js';
import { FieldValidator, isValidEmail, MAX_INTEGER } from '../utils/validation.js';

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

// ---- Managing facilities (administrators) --------------------------------------------

const DESCRIPTION_MAX_LENGTH = 1000;
const MAX_EQUIPMENT_TYPES = 50;

/**
 * Reads a facility from a request body. Only the fields below are read; anything else
 * (an id, timestamps) is ignored. withStatus: a new facility may be given a status; an
 * existing one changes status through PATCH /:id/status only.
 */
function parseFacility(body, { withStatus }) {
  const v = new FieldValidator(body);
  const facility = {
    name: v.string('name', { label: 'Name', max: 100 }),
    buildingId: v.integer('buildingId', { label: 'Building', min: 1, max: MAX_INTEGER }),
    roomNumber: v.string('roomNumber', { label: 'Room number', max: 20 }),
    type: v.oneOf('type', FACILITY_TYPES, { label: 'Type' }),
    capacity: v.integer('capacity', { label: 'Capacity', min: 1, max: 1000 }),
    floor: v.integer('floor', { label: 'Floor', min: -5, max: 50 }),
    description: v.string('description', { label: 'Description', required: false, max: DESCRIPTION_MAX_LENGTH }),
    opensAt: v.time('opensAt', { label: 'Opening time' }),
    closesAt: v.time('closesAt', { label: 'Closing time' }),
    openWeekends: body.openWeekends,
    equipment: parseEquipment(v, body.equipment),
    rules: v.string('rules', { label: 'Rules', required: false, max: 2000 }),
    services: v.string('services', { label: 'Services', required: false, max: 2000 }),
    locationNotes: v.string('locationNotes', { label: 'How to find it', required: false, max: 500 }),
    contactEmail: v.string('contactEmail', { label: 'Contact email', required: false, max: 254 })?.toLowerCase(),
    contactPhone: v.string('contactPhone', { label: 'Contact phone', required: false, max: 30 }),
  };
  if (facility.contactEmail !== undefined && !isValidEmail(facility.contactEmail)) v.addError('contactEmail', 'Enter a valid email address.');
  if (facility.contactPhone !== undefined && !/^[0-9+()\- ]{4,30}$/.test(facility.contactPhone)) v.addError('contactPhone', 'Use digits, spaces, +, - and brackets only.');
  if (withStatus) facility.status = v.oneOf('status', FACILITY_STATUSES, { label: 'Status', required: false });
  if (typeof body.openWeekends !== 'boolean') v.addError('openWeekends', 'Open at weekends must be true or false.');
  // Bookings start and end on the hour or half hour, so the opening hours do too.
  for (const [name, label] of [['opensAt', 'Opening time'], ['closesAt', 'Closing time']]) {
    if (facility[name] !== undefined && !/:(00|30)$/.test(facility[name])) {
      v.addError(name, `${label} must be on the hour or half hour, for example 09:00 or 09:30.`);
    }
  }
  if (facility.opensAt !== undefined && facility.closesAt !== undefined && facility.closesAt <= facility.opensAt) {
    v.addError('closesAt', 'Closing time must be after the opening time.');
  }
  v.assertValid();
  return facility;
}

/** equipment: [{ id, quantity }], each type at most once. Missing or [] means none. */
function parseEquipment(v, raw) {
  if (raw === undefined || raw === null) return [];
  const whole = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;
  const valid = Array.isArray(raw) && raw.length <= MAX_EQUIPMENT_TYPES
    && raw.every((item) => item !== null && typeof item === 'object' && whole(item.id, MAX_INTEGER) && whole(item.quantity, 1000))
    && new Set(raw.map((item) => item.id)).size === raw.length;
  if (!valid) {
    v.addError('equipment', 'Equipment must be a list of { id, quantity }, each type once, with quantities from 1 to 1000.');
    return [];
  }
  return raw.map((item) => ({ id: item.id, quantity: item.quantity }));
}

/** POST /api/facilities -> 201 { facility }, 400 VALIDATION_ERROR, 409 ROOM_TAKEN */
export async function create(req, res) {
  const facility = await facilityService.createFacility(parseFacility(req.body, { withStatus: true }));
  res.status(201).json({ success: true, data: { facility } });
}

/** PUT /api/facilities/:id -> 200 { facility }, 400, 404 FACILITY_NOT_FOUND, 409 ROOM_TAKEN */
export async function update(req, res) {
  const id = parseFacilityId(req.params);
  const facility = await facilityService.updateFacility(id, parseFacility(req.body, { withStatus: false }));
  res.json({ success: true, data: { facility } });
}

/**
 * PATCH /api/facilities/:id/status { status } -> 200 { facility, usage }, 400, 404
 * usage: { upcomingApprovedBookings, pendingRequests }, which the change left in place.
 */
export async function setStatus(req, res) {
  const id = parseFacilityId(req.params);
  const v = new FieldValidator(req.body ?? {});
  const status = v.oneOf('status', FACILITY_STATUSES, { label: 'Status' });
  v.assertValid();
  res.json({ success: true, data: await facilityService.setFacilityStatus(id, status) });
}

/** GET /api/facilities/:id/usage -> 200 { usage: { upcomingApprovedBookings, pendingRequests } }, 404 */
export async function usage(req, res) {
  const id = parseFacilityId(req.params);
  res.json({ success: true, data: { usage: await facilityService.getFacilityUsage(id) } });
}

// ---- Photos -----------------------------------------------------------------------------

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: facilityImageService.IMAGE_MAX_BYTES, files: 1, fields: 2, fieldSize: 1000 },
}).single('image');

/** Runs multer for one photo in "image" plus "caption" and "credit"; its errors become 400s. */
export function receiveImage(req, res, next) {
  imageUpload(req, res, (err) => {
    if (!err) return next();
    const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
      ? `The photo must be at most ${facilityImageService.IMAGE_MAX_BYTES / 1024 / 1024} MB.`
      : 'Send one photo in the field "image", with "caption" and "credit".';
    return next(new AppError(400, 'VALIDATION_ERROR', message, { details: { image: message }, cause: err }));
  });
}

/** POST /api/facilities/:id/images (administrators; multipart: image, caption, credit) -> 201 { image } */
export async function addImage(req, res) {
  const id = parseFacilityId(req.params);
  const v = new FieldValidator(req.body ?? {});
  const caption = v.string('caption', { label: 'Caption', max: 200 });
  const credit = v.string('credit', { label: 'Credit', min: 3, max: 200 });
  if (!req.file) v.addError('image', 'Choose a photo to upload.');
  v.assertValid();
  res.status(201).json({ success: true, data: { image: await facilityImageService.addImage(id, req.file.buffer, { caption, credit }) } });
}

/** DELETE /api/facilities/:id/images/:imageId (administrators) -> 200 {} */
export async function removeImage(req, res) {
  const id = parseFacilityId(req.params);
  const imageId = parseFacilityId({ id: req.params.imageId });
  await facilityImageService.removeImage(id, imageId);
  res.json({ success: true, data: {} });
}

/** GET /api/facility-images/:id -> the photo, to any signed-in user */
export async function image(req, res) {
  const { buffer, type } = await facilityImageService.readImage(parseFacilityId(req.params));
  res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': 'inline' });
  res.send(buffer);
}
