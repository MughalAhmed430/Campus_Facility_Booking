import { Router } from 'express';
import authRoutes from './auth.routes.js';
import facilitiesRoutes from './facilities.routes.js';
import healthRoutes from './health.routes.js';
import lookupRoutes from './lookup.routes.js';

// Mounted at /api in app.js. Each feature module adds its router here.
const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/facilities', facilitiesRoutes);
router.use(lookupRoutes); // /buildings, /equipment

export default router;
