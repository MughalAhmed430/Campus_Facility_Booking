import { Router } from 'express';
import * as notificationsController from '../controllers/notifications.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

// Notifications tell students what happened to their bookings. Administrators get
// none: the Requests page is already their list of what needs attention.
const router = Router();

router.use(requireAuth, requireRole('student'));
router.get('/', notificationsController.list);
router.get('/unread-count', notificationsController.unreadCount);
router.post('/read-all', notificationsController.markAllRead);
router.post('/:id/read', notificationsController.markRead);

export default router;
