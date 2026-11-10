import { Router } from 'express';
import * as bookingsController from '../controllers/bookings.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// Students make and cancel their own bookings; administrators review requests.
const student = [requireAuth, requireRole('student')];
const admin = [requireAuth, requireRole('admin')];

router.post('/', ...student, bookingsController.create);
router.get('/mine', ...student, bookingsController.listMine);
router.post('/:id/cancel', ...student, bookingsController.cancel);

router.get('/requests', ...admin, bookingsController.listRequests);
router.post('/:id/approve', ...admin, bookingsController.approve);
router.post('/:id/reject', ...admin, bookingsController.reject);

export default router;
