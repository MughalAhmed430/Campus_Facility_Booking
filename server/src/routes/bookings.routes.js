import { Router } from 'express';
import * as bookingsController from '../controllers/bookings.controller.js';
import * as scheduleController from '../controllers/schedule.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// Students make and cancel their own bookings; administrators review requests, see the
// day schedule and every booking, and cancel approved bookings.
const student = [requireAuth, requireRole('student')];
const admin = [requireAuth, requireRole('admin')];

router.post('/', ...student, bookingsController.create);
router.get('/mine', ...student, bookingsController.listMine);
// Both roles, each under its own rule (see bookingsController.cancel).
router.post('/:id/cancel', requireAuth, requireRole('student', 'admin'), bookingsController.cancel);

router.get('/', ...admin, bookingsController.listAll);
router.get('/requests', ...admin, bookingsController.listRequests);
router.get('/schedule', ...admin, scheduleController.daySchedule);
router.post('/:id/approve', ...admin, bookingsController.approve);
router.post('/:id/reject', ...admin, bookingsController.reject);

export default router;
