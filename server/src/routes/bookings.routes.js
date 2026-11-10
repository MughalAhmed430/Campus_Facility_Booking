import { Router } from 'express';
import * as bookingsController from '../controllers/bookings.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// Students only: administrators do not make bookings. Their own booking routes (review,
// cancel any booking) come with the admin pages.
const student = [requireAuth, requireRole('student')];

router.post('/', ...student, bookingsController.create);
router.get('/mine', ...student, bookingsController.listMine);
router.post('/:id/cancel', ...student, bookingsController.cancel);

export default router;
