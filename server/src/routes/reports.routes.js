import { Router } from 'express';
import * as reportsController from '../controllers/reports.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

// Usage figures are for administrators only.
const router = Router();

router.use(requireAuth, requireRole('admin'));
router.get('/summary', reportsController.summary);

export default router;
