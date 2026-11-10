import * as bookingService from '../services/booking.service.js';
import { FieldValidator, MAX_INTEGER } from '../utils/validation.js';

const PURPOSE_MIN_LENGTH = 5;
const TEXT_MAX_LENGTH = 500; // bookings.purpose and bookings.notes are VARCHAR(500)

// Only the fields below are read. Anything else in the body (status, userId, decidedBy, ...)
// is ignored: a request is always pending and always belongs to whoever is signed in.
async function parseBookingRequest(body) {
  const v = new FieldValidator(body);
  const request = {
    facilityId: v.integer('facilityId', { label: 'Facility', min: 1, max: MAX_INTEGER }),
    date: v.date('date', { label: 'Date' }),
    startTime: v.time('startTime', { label: 'Start time' }),
    endTime: v.time('endTime', { label: 'End time' }),
    participantCount: v.integer('participantCount', { label: 'Number of participants', min: 1, max: 1000 }),
    purpose: v.string('purpose', { label: 'Purpose', min: PURPOSE_MIN_LENGTH, max: TEXT_MAX_LENGTH }),
    notes: v.string('notes', { label: 'Notes', required: false, max: TEXT_MAX_LENGTH }),
  };
  await bookingService.checkBookingRules(v, request);
  v.assertValid();
  return request;
}

function parseDayQuery(params, queryParams) {
  const v = new FieldValidator({ id: params.id, date: queryParams.date });
  const facilityId = v.integer('id', { label: 'Facility id', min: 1, max: MAX_INTEGER });
  const date = v.date('date', { label: 'Date' });
  v.assertValid();
  return { facilityId, date };
}

/** POST /api/bookings -> 201 { booking }, 400 VALIDATION_ERROR, 409 BOOKING_CONFLICT */
export async function create(req, res) {
  const request = await parseBookingRequest(req.body);
  const booking = await bookingService.createBookingRequest(req.user.id, request);
  res.status(201).json({ success: true, data: { booking } });
}

/** GET /api/facilities/:id/bookings?date=YYYY-MM-DD -> 200 { date, bookings: [{ startTime, endTime }] } */
export async function listApprovedForDay(req, res) {
  const { facilityId, date } = parseDayQuery(req.params, req.query);
  const bookings = await bookingService.listApprovedTimes(facilityId, date);
  res.json({ success: true, data: { date, bookings } });
}
