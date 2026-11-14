import * as userService from '../services/user.service.js';
import { FieldValidator, MAX_INTEGER } from '../utils/validation.js';

const ACCOUNT_STATES = ['active', 'inactive'];

/**
 * GET /api/users?q=kim&role=student&status=active&page=2
 * -> 200 { users, total, page, pageSize, totalPages }: accounts by name. q searches the
 * name, email and student number; status is 'active' or 'inactive' (deactivated).
 */
export async function list(req, res) {
  const v = new FieldValidator(req.query);
  const status = v.oneOf('status', ACCOUNT_STATES, { label: 'Status', required: false });
  const filters = {
    search: v.string('q', { label: 'Search', required: false, max: 100 }),
    role: v.oneOf('role', userService.USER_ROLES, { label: 'Role', required: false }),
    active: status === undefined ? undefined : status === 'active',
    page: v.integer('page', { label: 'Page', required: false, min: 1, max: 1_000_000 }) ?? 1,
  };
  v.assertValid();
  res.json({ success: true, data: await userService.listUsers(filters) });
}

/**
 * PATCH /api/users/:id/status { active: true | false } -> 200 { user }
 * 400, 404 USER_NOT_FOUND, 409 CANNOT_DEACTIVATE_SELF
 */
export async function setStatus(req, res) {
  const v = new FieldValidator({ id: req.params.id });
  const id = v.integer('id', { label: 'User id', min: 1, max: MAX_INTEGER });
  const active = req.body?.active;
  if (typeof active !== 'boolean') v.addError('active', 'Active must be true or false.');
  v.assertValid();
  const user = await userService.setUserActive(req.user.id, id, active);
  res.json({ success: true, data: { user } });
}
