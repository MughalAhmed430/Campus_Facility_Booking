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
 * Cancels a booking. Resolves to { booking }, as that role sees it.
 *   student        one of their own; reason is optional
 *   administrator  any approved booking until it ends; reason is required (5 to 500 characters)
 * Rejects with ApiError: 404 BOOKING_NOT_FOUND, or 409 BOOKING_NOT_CANCELLABLE (with why).
 */
export function cancelBooking(id, { reason } = {}) {
  return api.post(`/bookings/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {});
}

/**
 * Administrators. filters (all optional): { status: [statuses], facility, from, to, q, page }.
 * from and to are booking dates (Korea time, inclusive); q searches the student's name,
 * email and student number. Resolves to { bookings, total, page, pageSize, totalPages }:
 * every booking, latest start first, each with student, facility, decision, cancellation
 * and canCancel.
 */
export function listAllBookings(filters = {}, { signal } = {}) {
  const { status, ...rest } = filters;
  const query = { ...rest, status: status?.length ? status.join(',') : undefined };
  return api.get('/bookings', { query, signal });
}

/**
 * Administrators. Resolves to { requests }: pending requests that have not started,
 * soonest first, each with student, facility, overlappingRequests, timeTaken, canApprove.
 */
export function listRequests({ signal } = {}) {
  return api.get('/bookings/requests', { signal });
}

/**
 * Administrators. note is optional. Resolves to { booking, autoRejected: [ids] }: the
 * overlapping requests rejected along with the approval. Rejects with ApiError 404, or
 * 409 BOOKING_NOT_PENDING / BOOKING_STARTED / FACILITY_NOT_BOOKABLE / BOOKING_CONFLICT.
 */
export function approveRequest(id, { note } = {}) {
  return api.post(`/bookings/${encodeURIComponent(id)}/approve`, note ? { note } : {});
}

/** Administrators. reason is required (5 to 500 characters). Resolves to { booking }. */
export function rejectRequest(id, { reason }) {
  return api.post(`/bookings/${encodeURIComponent(id)}/reject`, { reason });
}

/**
 * Administrators. Resolves to { date, facilities }: every facility (type optional) with
 * its opening hours, isOpen that day, and its approved, completed and pending bookings
 * that day, each with student, times, participantCount, purpose and notes.
 */
export function getDaySchedule({ date, type }, { signal } = {}) {
  return api.get('/bookings/schedule', { query: { date, type: type || undefined }, signal });
}
