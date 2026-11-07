import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';

// Temporary routes that only prove role-based authorization works. They will be
// removed once real student and admin endpoints exist (bookings, facility management).
const router = Router();

router.get('/student', requireAuth, requireRole('student'), (req, res) => {
  res.json({ success: true, data: { message: `Hello ${req.user.fullName}, you reached a student-only route.`, role: req.user.role } });
});

router.get('/admin', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ success: true, data: { message: `Hello ${req.user.fullName}, you reached an admin-only route.`, role: req.user.role } });
});

export default router;
