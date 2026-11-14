import { Router } from 'express';
import * as facilitiesController from '../controllers/facilities.controller.js';
import * as scheduleController from '../controllers/schedule.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

// Browsing is for every signed-in user (students and administrators); creating and
// changing facilities is for administrators only.
const router = Router();
const admin = requireRole('admin');

router.use(requireAuth);
router.get('/', facilitiesController.list);
router.post('/', admin, facilitiesController.create);
router.get('/:id', facilitiesController.getById);
router.put('/:id', admin, facilitiesController.update);
router.patch('/:id/status', admin, facilitiesController.setStatus);
router.get('/:id/usage', admin, facilitiesController.usage);
router.get('/:id/schedule', scheduleController.facilitySchedule);

export default router;
