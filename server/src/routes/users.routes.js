import { Router } from 'express';
import * as profileController from '../controllers/profile.controller.js';
import * as usersController from '../controllers/users.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

// Accounts are managed by administrators only. A photo is also visible to its owner (the
// service checks), so that route comes before the administrator-only rule.
const router = Router();

router.get('/:id/photo', requireAuth, profileController.userPhoto);

router.use(requireAuth, requireRole('admin'));
router.get('/', usersController.list);
router.patch('/:id/status', usersController.setStatus);

export default router;
