import { Router } from 'express';
import * as bookingsController from '../controllers/bookings.controller.js';
import * as facilitiesController from '../controllers/facilities.controller.js';
import { requireAuth } from '../middleware/auth.js';

// Facility browsing is for signed-in users only (students and administrators).
const router = Router();

router.use(requireAuth);
router.get('/', facilitiesController.list);
router.get('/:id', facilitiesController.getById);
router.get('/:id/bookings', bookingsController.listApprovedForDay);

export default router;
