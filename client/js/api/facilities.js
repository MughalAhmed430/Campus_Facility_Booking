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

/** Resolves to { buildings: [{ id, code, name }] }. */
export function listBuildings() {
  return api.get('/buildings');
}

/** Resolves to { equipment: [{ id, name }] }. */
export function listEquipment() {
  return api.get('/equipment');
}
