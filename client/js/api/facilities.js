import { api } from './client.js';

/**
 * filters (all optional): { q, type, building, minCapacity, equipment: [ids], status,
 * date, startTime, endTime }. The last three go together: facilities free at that time.
 * Resolves to { facilities, total }.
 */
export function listFacilities(filters = {}, { signal } = {}) {
  const { equipment, ...rest } = filters;
  const query = { ...rest, equipment: equipment?.length ? equipment.join(',') : undefined };
  return api.get('/facilities', { query, signal });
}

/** Resolves to { facility }. Rejects with ApiError status 404 when it does not exist. */
export function getFacility(id, { signal } = {}) {
  return api.get(`/facilities/${encodeURIComponent(id)}`, { signal });
}

/**
 * Resolves to { facilityId, from, openingHours, isBookable, days: [{ date, isOpen, bookings }] }
 * for `days` days (1 to 7) from `from`. Each booking is { startTime, endTime, kind }, kind
 * being 'booked' (someone else's, times only), 'yours' or 'your-request' (your pending request).
 */
export function getFacilitySchedule(id, { from, days = 7 }, { signal } = {}) {
  return api.get(`/facilities/${encodeURIComponent(id)}/schedule`, { query: { from, days }, signal });
}

/**
 * Administrators. fields: { name, buildingId, roomNumber, type, capacity, floor,
 * description?, opensAt, closesAt, openWeekends, status?, equipment: [{ id, quantity }] }.
 * Resolves to { facility }. Rejects with ApiError: 400 with details per field, or
 * 409 ROOM_TAKEN (details.roomNumber) when the building already has that room number.
 */
export function createFacility(fields) {
  return api.post('/facilities', fields);
}

/** Administrators. Replaces the details and equipment; the status is not changed here. As createFacility, plus 404. */
export function updateFacility(id, fields) {
  return api.put(`/facilities/${encodeURIComponent(id)}`, fields);
}

/**
 * Administrators. status: 'active', 'maintenance' or 'inactive'. Resolves to
 * { facility, usage }: bookings are never cancelled by this, and usage says what is left.
 */
export function setFacilityStatus(id, status) {
  return api.patch(`/facilities/${encodeURIComponent(id)}/status`, { status });
}

/** Administrators. Resolves to { usage: { upcomingApprovedBookings, pendingRequests } }. */
export function getFacilityUsage(id) {
  return api.get(`/facilities/${encodeURIComponent(id)}/usage`);
}

/** Resolves to { buildings: [{ id, code, name }] }. */
export function listBuildings() {
  return api.get('/buildings');
}

/** Resolves to { equipment: [{ id, name }] }. */
export function listEquipment() {
  return api.get('/equipment');
}
