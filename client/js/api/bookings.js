import { api } from './client.js';

/**
 * fields: { facilityId, date, startTime, endTime, participantCount, purpose, notes? }.
 * Resolves to { booking } (always pending). Rejects with ApiError: 400 with details per
 * field, or 409 BOOKING_CONFLICT when an approved booking already covers the time.
 */
export function createBooking(fields) {
  return api.post('/bookings', fields);
}

/** Resolves to { date, bookings: [{ startTime, endTime }] }: the approved bookings on that day. */
export function listApprovedTimes(facilityId, date, { signal } = {}) {
  return api.get(`/facilities/${encodeURIComponent(facilityId)}/bookings`, { query: { date }, signal });
}
