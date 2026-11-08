import { Router } from 'express';
import * as lookupController from '../controllers/lookup.controller.js';
import { requireAuth } from '../middleware/auth.js';

// Reference lists for filters and forms, for signed-in users only.
const router = Router();

router.get('/buildings', requireAuth, lookupController.buildings);
router.get('/equipment', requireAuth, lookupController.equipment);

export default router;
