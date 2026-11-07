import { Router } from 'express';
import * as facilitiesController from '../controllers/facilities.controller.js';
import { requireAuth } from '../middleware/auth.js';

// Facility browsing is for signed-in users only (students and administrators).
const router = Router();

router.use(requireAuth);
router.get('/', facilitiesController.list);
router.get('/:id', facilitiesController.getById);

export default router;
