import { Router } from 'express';
import * as profileController from '../controllers/profile.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { passwordChangeLimiter } from '../middleware/rate-limit.js';

// Every signed-in user (student or administrator) manages their own profile here.
const router = Router();

router.use(requireAuth);
router.get('/', profileController.show);
router.patch('/', profileController.update);
router.post('/password', passwordChangeLimiter, profileController.changePassword);
router.get('/photo', profileController.ownPhoto);
router.put('/photo', profileController.receivePhoto, profileController.setPhoto);
router.delete('/photo', profileController.removePhoto);

export default router;
