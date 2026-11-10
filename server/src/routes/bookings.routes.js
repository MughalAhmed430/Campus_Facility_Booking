import { Router } from 'express';
import * as bookingsController from '../controllers/bookings.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.post('/', requireAuth, requireRole('student'), bookingsController.create);

export default router;
