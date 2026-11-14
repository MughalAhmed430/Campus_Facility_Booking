import { query, withTransaction } from '../db/pool.js';
import AppError from '../utils/app-error.js';
import { currentInstant } from '../utils/campus-time.js';
import { escapeLikePattern } from './facility.service.js';

export const USER_ROLES = Object.freeze(['student', 'admin']);
export const USERS_PAGE_SIZE = 20;

/**
 * One page of accounts, by name. All filters are optional and combine with AND:
 *   search  part of the name, email or student number
 *   role    'student' | 'admin'
 *   active  true (can sign in) | false (deactivated)
 * Returns { users, total, page, pageSize, totalPages }. Each user has the bookings that
 * still depend on them (upcomingApprovedBookings, pendingRequests). Password hashes are
 * never selected.
 */
export async function listUsers({ search, role, active, page = 1 } = {}) {
  const params = [];
  const param = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const conditions = [];
  if (search) {
    const pattern = param(`%${escapeLikePattern(search)}%`);
    conditions.push(`(u.full_name ILIKE ${pattern} OR u.email ILIKE ${pattern} OR u.student_number ILIKE ${pattern})`);
  }
  if (role) conditions.push(`u.role = ${param(role)}`);
  if (active !== undefined) conditions.push(`u.is_active = ${param(active)}`);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM users u ${where}`, params);
  const users = await selectUsers({ where, params, limit: USERS_PAGE_SIZE, offset: (page - 1) * USERS_PAGE_SIZE });
  return { users, total, page, pageSize: USERS_PAGE_SIZE, totalPages: Math.max(1, Math.ceil(total / USERS_PAGE_SIZE)) };
}

/**
 * Activates or deactivates an account for the administrator `adminId`. Returns the user.
 * Accounts are never deleted: their bookings keep their history.
 *
 * Deactivating signs the person out everywhere at once (their sessions are deleted, and
 * every session lookup checks is_active as well) and stops them signing in. Their
 * bookings are deliberately left as they are; the returned counts say what is left.
 *
 * 404 USER_NOT_FOUND; 409 CANNOT_DEACTIVATE_SELF: an administrator cannot lock
 * themselves out, so at least one active administrator always remains.
 */
export async function setUserActive(adminId, userId, active) {
  if (!active && userId === adminId) {
    throw new AppError(409, 'CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account. Ask another administrator.');
  }
  await withTransaction(async (tx) => {
    // Two administrators deactivating each other at the same moment would leave none.
    // Locking the administrator rows first makes them take turns: the second then finds
    // its own account deactivated, and is refused.
    const { rows: admins } = await tx.query("SELECT id, is_active FROM users WHERE role = 'admin' ORDER BY id FOR UPDATE");
    if (!admins.some((row) => row.id === adminId && row.is_active)) {
      throw new AppError(401, 'SESSION_INVALID', 'Your session has ended. Please log in again.');
    }
    const { rows } = await tx.query('UPDATE users SET is_active = $2 WHERE id = $1 RETURNING id', [userId, active]);
    if (rows.length === 0) throw new AppError(404, 'USER_NOT_FOUND', 'This account does not exist.');
    if (!active) await tx.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  });
  const [user] = await selectUsers({ where: 'WHERE u.id = $1::int', params: [userId] });
  return user;
}

/** `where` uses the alias u, with `params` as $1, $2, ... */
async function selectUsers({ where, params, limit = null, offset = 0 }) {
  const nowParam = `$${params.length + 1}`;
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.email, u.role, u.student_number, u.is_active, u.created_at,
            (SELECT count(*)::int FROM bookings b
              WHERE b.user_id = u.id AND b.status = 'approved' AND b.end_time > ${nowParam}::timestamptz) AS approved,
            (SELECT count(*)::int FROM bookings b
              WHERE b.user_id = u.id AND b.status = 'pending' AND b.start_time > ${nowParam}::timestamptz) AS pending
     FROM users u
     ${where}
     ORDER BY u.full_name, u.id
     LIMIT $${params.length + 2}::int OFFSET $${params.length + 3}::int`,
    [...params, currentInstant().toISOString(), limit, offset],
  );
  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    studentNumber: row.student_number,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    upcomingApprovedBookings: row.approved,
    pendingRequests: row.pending,
  }));
}
