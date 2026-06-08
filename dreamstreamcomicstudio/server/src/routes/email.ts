import { Router } from 'express';
import { markOpened } from '../services/emailStore.js';

// Public email tracking. Mounted with optionalAuth BEFORE the global requireAuth — the open
// pixel is fetched by the recipient's mail client, which carries no session. Open tracking is
// best-effort by nature (many clients block remote images), so a miss just means "unknown".
export const emailRouter = Router();

// A 1x1 transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// GET /api/email/o/:token.gif — :token is the email_log row id. Stamps opened_at, returns the pixel.
emailRouter.get('/o/:token', async (req, res) => {
  const id = String(req.params.token || '').split('.')[0];
  // Fire-and-forget so image delivery is never blocked by the DB write.
  if (id) void markOpened(id);
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': String(PIXEL.length),
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache'
  });
  res.status(200).end(PIXEL);
});
