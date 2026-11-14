import { Router } from 'express';
import authRoutes from './auth.routes.js';
import bookingsRoutes from './bookings.routes.js';
import facilitiesRoutes from './facilities.routes.js';
import healthRoutes from './health.routes.js';
import lookupRoutes from './lookup.routes.js';
import notificationsRoutes from './notifications.routes.js';
import usersRoutes from './users.routes.js';

// Mounted at /api in app.js. Each feature module adds its router here.
const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/facilities', facilitiesRoutes);
router.use('/bookings', bookingsRoutes);
router.use('/users', usersRoutes);
router.use('/notifications', notificationsRoutes);
router.use(lookupRoutes); // /buildings, /equipment

export default router;
