import { api } from './client.js';

/**
 * fields: { facilityId, date, startTime, endTime, participantCount, purpose, notes? }.
 * Resolves to { booking } (always pending). Rejects with ApiError: 400 with details per
 * field, or 409 BOOKING_CONFLICT when an approved booking already covers the time.
 */
export function createBooking(fields) {
  return api.post('/bookings', fields);
}

/**
 * Resolves to { bookings }: every booking of the signed-in student, latest start first.
 * Each has status, facility, date, times, hasStarted, canCancel, decision and cancellation.
 */
export function listMyBookings({ signal } = {}) {
  return api.get('/bookings/mine', { signal });
}

/**
 * Cancels one of the student's own bookings. reason is optional. Resolves to { booking }.
 * Rejects with ApiError: 404 BOOKING_NOT_FOUND, or 409 BOOKING_NOT_CANCELLABLE (with why).
 */
export function cancelBooking(id, { reason } = {}) {
  return api.post(`/bookings/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {});
}

/** Resolves to { date, bookings: [{ startTime, endTime }] }: the approved bookings on that day. */
export function listApprovedTimes(facilityId, date, { signal } = {}) {
  return api.get(`/facilities/${encodeURIComponent(facilityId)}/bookings`, { query: { date }, signal });
}
