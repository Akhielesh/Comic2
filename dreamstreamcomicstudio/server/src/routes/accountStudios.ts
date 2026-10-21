import { Router } from 'express';
import { loadAccountAccess } from '../services/studioAccess.js';

// GET /api/account/studios — the signed-in person's access to every studio (one
// answer for DreamStream and Stream Studio alike). Mounted after requireAuth.
export const accountStudiosRouter = Router();

accountStudiosRouter.get('/', async (req, res, next) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: { message: 'User not authenticated' } });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await loadAccountAccess({ id: req.user.id, email: req.user.email }));
  } catch (err) {
    next(err);
  }
});
