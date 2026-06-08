import { Router } from 'express';
import { getInviteStatusForUser, redeemInvite } from '../services/invites.js';

// Authenticated invite redemption for testers. Mounted under /api/invites after
// the global requireAuth, so req.user is always present here.
export const invitesRouter = Router();

invitesRouter.post('/redeem', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'Sign in to redeem an invite.' } });
    }
    const result = await redeemInvite({ code: req.body?.code, userId: req.user.id, email: req.user.email });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

invitesRouter.get('/me', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }
    res.json(await getInviteStatusForUser(req.user.id));
  } catch (err) {
    next(err);
  }
});
