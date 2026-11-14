import { api } from './client.js';

/**
 * Administrators. filters (all optional): { q, role, status, page }. q searches the name,
 * email and student number; status is 'active' or 'inactive' (deactivated).
 * Resolves to { users, total, page, pageSize, totalPages }, by name. Each user has
 * id, fullName, email, role, studentNumber, isActive, createdAt, upcomingApprovedBookings
 * and pendingRequests.
 */
export function listUsers(filters = {}, { signal } = {}) {
  return api.get('/users', { query: filters, signal });
}

/**
 * Administrators. Activates (true) or deactivates (false) an account. Resolves to { user }.
 * Rejects with ApiError: 404 USER_NOT_FOUND, or 409 CANNOT_DEACTIVATE_SELF.
 */
export function setUserActive(id, active) {
  return api.patch(`/users/${encodeURIComponent(id)}/status`, { active });
}
