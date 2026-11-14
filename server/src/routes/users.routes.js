import { Router } from 'express';
import * as usersController from '../controllers/users.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

// Accounts are managed by administrators only.
const router = Router();

router.use(requireAuth, requireRole('admin'));
router.get('/', usersController.list);
router.patch('/:id/status', usersController.setStatus);

export default router;
