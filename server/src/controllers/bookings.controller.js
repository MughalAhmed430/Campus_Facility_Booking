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

/** POST /api/bookings -> 201 { booking }, 400 VALIDATION_ERROR, 409 BOOKING_CONFLICT */
export async function create(req, res) {
  const request = await parseBookingRequest(req.body);
  const booking = await bookingService.createBookingRequest(req.user.id, request);
  res.status(201).json({ success: true, data: { booking } });
}

function parseBookingId(params) {
  const v = new FieldValidator({ id: params.id });
  const id = v.integer('id', { label: 'Booking id', min: 1, max: MAX_INTEGER });
  v.assertValid();
  return id;
}

/** GET /api/bookings/mine -> 200 { bookings }: the signed-in student's own bookings */
export async function listMine(req, res) {
  const bookings = await bookingService.listOwnBookings(req.user.id);
  res.json({ success: true, data: { bookings } });
}

/** POST /api/bookings/:id/cancel { reason? } -> 200 { booking }, 404 BOOKING_NOT_FOUND, 409 BOOKING_NOT_CANCELLABLE */
export async function cancel(req, res) {
  const id = parseBookingId(req.params);
  // The body is optional: a cancellation without a reason may send none at all.
  const v = new FieldValidator(req.body ?? {});
  const reason = v.string('reason', { label: 'Reason', required: false, max: TEXT_MAX_LENGTH });
  v.assertValid();
  const booking = await bookingService.cancelOwnBooking(req.user.id, id, { reason });
  res.json({ success: true, data: { booking } });
}

// ---- Reviewing requests (administrators) ---------------------------------------------

const REASON_MIN_LENGTH = 5; // a rejection reason the student can act on, not "no"

/** GET /api/bookings/requests -> 200 { requests }: pending requests that have not started */
export async function listRequests(req, res) {
  const requests = await bookingService.listPendingRequests();
  res.json({ success: true, data: { requests } });
}

/** POST /api/bookings/:id/approve { note? } -> 200 { booking, autoRejected }, 404, 409 */
export async function approve(req, res) {
  const id = parseBookingId(req.params);
  const v = new FieldValidator(req.body ?? {});
  const note = v.string('note', { label: 'Note', required: false, max: TEXT_MAX_LENGTH });
  v.assertValid();
  const result = await bookingService.approveRequest(req.user.id, id, { note });
  res.json({ success: true, data: result });
}

/** POST /api/bookings/:id/reject { reason } -> 200 { booking }, 400, 404, 409 BOOKING_NOT_PENDING */
export async function reject(req, res) {
  const id = parseBookingId(req.params);
  const v = new FieldValidator(req.body ?? {});
  const reason = v.string('reason', { label: 'Reason', min: REASON_MIN_LENGTH, max: TEXT_MAX_LENGTH });
  v.assertValid();
  const result = await bookingService.rejectRequest(req.user.id, id, { reason });
  res.json({ success: true, data: result });
}
