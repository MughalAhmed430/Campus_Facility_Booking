import { Router } from 'express';
import authRoutes from './auth.routes.js';
import healthRoutes from './health.routes.js';
import roleCheckRoutes from './role-check.routes.js';

// Mounted at /api in app.js. Each feature module adds its router here.
const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/test', roleCheckRoutes);

export default router;
