import { Router } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter, registerLimiter, resendVerificationLimiter } from '../middleware/rate-limit.js';

const router = Router();

router.post('/register', registerLimiter, authController.register);
// The link in the email opens verify-email.html, which calls this. Tokens are 256-bit
// random values, so guessing one is not feasible and no rate limit is needed.
router.get('/verify-email', authController.verifyEmail);
router.post('/resend-verification', resendVerificationLimiter, authController.resendVerification);
router.post('/login', loginLimiter, authController.login);
router.post('/logout', authController.logout);
router.get('/me', requireAuth, authController.me);

export default router;
