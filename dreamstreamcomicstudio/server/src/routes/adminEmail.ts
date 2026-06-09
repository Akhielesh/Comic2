import { Router } from 'express';
import {
  renderEmail,
  isEmailTemplateName,
  TEMPLATE_KIND,
  EMAIL_TEMPLATE_NAMES,
  type EmailParams
} from '../../../shared/email/index.js';
import { APP_PUBLIC_URL, getEmailUsageStatus, mailerConfigured, sendBetaInvite, sendEmail } from '../services/mailer.js';
import { normalizeEmail, recentLog } from '../services/emailStore.js';
import { generateInvites } from '../services/invites.js';

// Admin Email Console API. Mounted under /api/admin/email behind requireAuth + requireAdmin,
// so every handler here is admin-only. Sends always go through the mailer (cost caps,
// marketing suppression, and per-send logging all apply). Previews render server-side with
// the default brand — nothing is sent.
export const adminEmailRouter = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS_PER_SEND = 100;

// Templates an admin may compose/broadcast from the console. Auth-* and double-opt-in flows
// are driven by the system, not hand-sent, so they're hidden from the picker.
const SYSTEM_ONLY = new Set<string>([
  'auth-confirm-signup',
  'auth-magic-link',
  'auth-recovery',
  'auth-email-change',
  'auth-reauthentication',
  'auth-invite',
  'newsletter-confirm'
]);

adminEmailRouter.get('/templates', (_req, res) => {
  const templates = EMAIL_TEMPLATE_NAMES.map((name) => ({
    name,
    kind: TEMPLATE_KIND[name],
    composable: !SYSTEM_ONLY.has(name)
  }));
  res.json({ configured: mailerConfigured(), templates });
});

adminEmailRouter.get('/usage', async (_req, res, next) => {
  try {
    res.json(await getEmailUsageStatus());
  } catch (err) {
    next(err);
  }
});

adminEmailRouter.get('/log', async (req, res, next) => {
  try {
    res.json({ items: await recentLog(Number(req.query.limit) || 50) });
  } catch (err) {
    next(err);
  }
});

// Render a template to {subject, html, text} without sending — powers the live preview.
adminEmailRouter.post('/preview', (req, res) => {
  const template = req.body?.template;
  if (!isEmailTemplateName(template)) return res.status(400).json({ error: { message: 'Unknown template' } });
  try {
    const rendered = renderEmail(template, (req.body?.params ?? {}) as EmailParams);
    res.json({ ...rendered, kind: TEMPLATE_KIND[template] });
  } catch (err) {
    res.status(400).json({ error: { message: (err as Error)?.message || 'Could not render' } });
  }
});

// Send the chosen template to the signed-in admin only — the "Send test to me" button.
adminEmailRouter.post('/test', async (req, res, next) => {
  try {
    const template = req.body?.template;
    const to = normalizeEmail(req.user?.email || '');
    if (!isEmailTemplateName(template)) return res.status(400).json({ error: { message: 'Unknown template' } });
    if (!to) return res.status(400).json({ error: { message: 'Your account has no email to send a test to.' } });
    const result = await sendEmail({
      to,
      template,
      params: (req.body?.params ?? {}) as EmailParams,
      userId: req.user?.id ?? null,
      requestId: req.requestId
    });
    res.json({ to, ...result });
  } catch (err) {
    next(err);
  }
});

// Send to one address or a pasted list. Each recipient is an independent, logged send.
adminEmailRouter.post('/send', async (req, res, next) => {
  try {
    const template = req.body?.template;
    if (!isEmailTemplateName(template)) return res.status(400).json({ error: { message: 'Unknown template' } });
    if (SYSTEM_ONLY.has(template)) {
      return res.status(400).json({ error: { message: 'That template is system-managed and cannot be hand-sent.' } });
    }

    const raw = req.body?.to;
    const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/))
      .map((e) => normalizeEmail(String(e)))
      .filter((e) => EMAIL_REGEX.test(e));
    const recipients = [...new Set(list)];
    if (recipients.length === 0) return res.status(400).json({ error: { message: 'Add at least one valid email.' } });
    if (recipients.length > MAX_RECIPIENTS_PER_SEND) {
      return res.status(400).json({ error: { message: `Too many recipients (max ${MAX_RECIPIENTS_PER_SEND} per send).` } });
    }

    const params = (req.body?.params ?? {}) as EmailParams;
    const results = [];
    for (const to of recipients) {
      const r = await sendEmail({ to, template, params, userId: req.user?.id ?? null, requestId: req.requestId });
      results.push({ to, ok: r.ok, messageId: r.messageId, skipped: r.skipped, error: r.error });
    }
    const sent = results.filter((r) => r.ok).length;
    console.info('[ADMIN_ACTION] email_broadcast', { actorId: req.user?.id, template, recipients: recipients.length, sent });
    res.json({ requested: recipients.length, sent, results });
  } catch (err) {
    next(err);
  }
});

// Admin "invite by email": mint a fresh invite code and email the branded link to one person.
adminEmailRouter.post('/invite', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email || '');
    if (!EMAIL_REGEX.test(email)) return res.status(400).json({ error: { message: 'Enter a valid email.' } });
    const [invite] = await generateInvites({
      createdBy: req.user?.id || '',
      count: 1,
      label: req.body?.label || 'admin-invite',
      note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      maxUses: req.body?.maxUses,
      expiresInDays: req.body?.expiresInDays
    });
    const inviteUrl = `${APP_PUBLIC_URL}/?invite=${encodeURIComponent(String(invite.code))}`;
    const result = await sendBetaInvite(
      email,
      {
        inviteUrl,
        code: String(invite.code),
        personalNote: typeof req.body?.personalNote === 'string' ? req.body.personalNote.slice(0, 500) : undefined,
        inviterName: typeof req.body?.inviterName === 'string' ? req.body.inviterName.slice(0, 80) : undefined
      },
      { userId: req.user?.id ?? null, requestId: req.requestId }
    );
    console.info('[ADMIN_ACTION] invite_emailed', { actorId: req.user?.id, code: invite.code, to: email });
    res.json({ code: invite.code, inviteUrl, email, ...result });
  } catch (err) {
    next(err);
  }
});
