import { Router } from 'express';
import healthRoutes from './health.routes.js';

// Mounted at /api in app.js. Each feature module adds its router here.
const router = Router();

router.use('/health', healthRoutes);

export default router;
