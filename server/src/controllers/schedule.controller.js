import { FACILITY_TYPES } from '../services/facility.service.js';
import * as scheduleService from '../services/schedule.service.js';
import { MAX_SCHEDULE_DAYS } from '../services/schedule.service.js';
import { addDays } from '../utils/campus-time.js';
import { FieldValidator, MAX_INTEGER } from '../utils/validation.js';

/**
 * GET /api/facilities/:id/schedule?from=YYYY-MM-DD&days=1..7 (days defaults to 7)
 * -> 200 { facilityId, from, openingHours, isBookable, days: [{ date, isOpen, bookings }] }
 *    400 VALIDATION_ERROR, 404 FACILITY_NOT_FOUND
 */
export async function facilitySchedule(req, res) {
  const v = new FieldValidator({ id: req.params.id, from: req.query.from, days: req.query.days });
  const facilityId = v.integer('id', { label: 'Facility id', min: 1, max: MAX_INTEGER });
  const from = v.date('from', { label: 'Start date' });
  const days = v.integer('days', { label: 'Days', required: false, min: 1, max: MAX_SCHEDULE_DAYS }) ?? MAX_SCHEDULE_DAYS;
  // The calendar stops at the year 9999, and so do dates written YYYY-MM-DD.
  if (from !== undefined && !/^\d{4}-/.test(addDays(from, days - 1))) {
    v.addError('from', 'The schedule cannot go past 31 December 9999.');
  }
  v.assertValid();
  const schedule = await scheduleService.facilitySchedule(facilityId, { from, days, viewerId: req.user.id });
  res.json({ success: true, data: schedule });
}

/**
 * Administrators. GET /api/bookings/schedule?date=YYYY-MM-DD&type=laboratory (type optional)
 * -> 200 { date, facilities: [{ ..., isOpen, bookings: [{ id, status, student, ... }] }] }
 */
export async function daySchedule(req, res) {
  const v = new FieldValidator(req.query);
  const date = v.date('date', { label: 'Date' });
  const type = v.oneOf('type', FACILITY_TYPES, { label: 'Type', required: false });
  v.assertValid();
  const schedule = await scheduleService.daySchedule({ date, type });
  res.json({ success: true, data: schedule });
}
