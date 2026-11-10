import { Router } from 'express';
import * as facilitiesController from '../controllers/facilities.controller.js';
import * as scheduleController from '../controllers/schedule.controller.js';
import { requireAuth } from '../middleware/auth.js';

// Facility browsing is for signed-in users only (students and administrators).
const router = Router();

router.use(requireAuth);
router.get('/', facilitiesController.list);
router.get('/:id', facilitiesController.getById);
router.get('/:id/schedule', scheduleController.facilitySchedule);

export default router;
