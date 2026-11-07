import { api } from './client.js';

/**
 * filters (all optional): { q, type, building, minCapacity, equipment: [ids], status }
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

/** Resolves to { buildings: [{ id, code, name }] }. */
export function listBuildings() {
  return api.get('/buildings');
}

/** Resolves to { equipment: [{ id, name }] }. */
export function listEquipment() {
  return api.get('/equipment');
}
