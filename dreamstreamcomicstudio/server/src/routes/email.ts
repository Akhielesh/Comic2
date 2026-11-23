import { Router, urlencoded } from 'express';
import { acknowledgeMessage, recordImageRequest } from '../services/emailStore.js';

export const emailRouter = Router();
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LEGACY_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

emailRouter.use((_req, res, next) => {
  res.set({
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Content-Type-Options': 'nosniff'
  });
  next();
});

// A GET can come from an image proxy or prefetcher. HEAD probes return identical headers without an event.
emailRouter.get('/o/:token.gif', async (req, res) => {
  const token = String(req.params.token ?? '');
  const legacy = LEGACY_ID.test(token);
  if (req.method === 'GET' && process.env.EMAIL_OPEN_SIGNALS === 'on' && (TOKEN.test(token) || legacy)) {
    try { await recordImageRequest(token, legacy); } catch { /* The public image is always available. */ }
  }
  res.status(200).type('image/gif').end(req.method === 'HEAD' ? undefined : PIXEL);
});

const page = (title: string, message: string, showForm = false): string =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · DreamStream Studio</title><style>html{color-scheme:light dark}body{max-width:34rem;margin:12vh auto;padding:0 1.4rem;font:1.05rem/1.6 system-ui,sans-serif}h1{font-size:1.65rem;line-height:1.2}button{font:inherit;cursor:pointer;padding:.6rem 1rem;border-radius:.4rem}</style>
<main><p>DreamStream Studio</p><h1>${title}</h1><p>${message}</p>${showForm ?
  '<form method="post"><button type="submit" name="acknowledge" value="yes">Acknowledge this message</button></form>' : ''}</main></html>`;

emailRouter.use('/ack', (_req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY'
  }).type('html');
  next();
});

const unavailable = () => page('This receipt link is unavailable', 'It may have expired or been disabled. You can close this page.');
emailRouter.get('/ack/:token', (req, res) => {
  if (!TOKEN.test(String(req.params.token)) || process.env.EMAIL_ACKNOWLEDGEMENTS === 'off') {
    return res.status(410).send(unavailable());
  }
  return res.send(page('Acknowledge this message?', 'If you choose to acknowledge, the sender will see the time the button was pressed. You can close this page without sending a receipt.', true));
});

emailRouter.post('/ack/:token', urlencoded({ extended: false, limit: '1kb' }), async (req, res) => {
  const token = String(req.params.token);
  if (!TOKEN.test(token) || process.env.EMAIL_ACKNOWLEDGEMENTS === 'off') return res.status(410).send(unavailable());
  if (req.get('sec-fetch-site') === 'cross-site' || !req.is('application/x-www-form-urlencoded') || req.body?.acknowledge !== 'yes') {
    return res.status(400).send(page('Confirmation required', 'Open the link in your message and use its confirmation button.'));
  }
  try {
    if (!await acknowledgeMessage(token)) return res.status(410).send(unavailable());
    return res.send(page('Message acknowledged', 'Your acknowledgement was recorded. You can close this page.'));
  } catch {
    return res.status(503).send(page('Please try again', 'We could not confirm your acknowledgement. Reopen the email link and try again.'));
  }
});
