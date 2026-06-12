import { Router } from 'express';
import {
  renderEmail,
  isEmailTemplateName,
  isStudioInviteId,
  STUDIO_INVITE_IDS,
  TEMPLATE_KIND,
  EMAIL_TEMPLATE_NAMES,
  type EmailParams,
  type StudioInviteId
} from '../../../shared/email/index.js';
import { APP_PUBLIC_URL, getEmailUsageStatus, mailerConfigured, sendBetaInvite, sendEmail } from '../services/mailer.js';
import { normalizeEmail, recentLog } from '../services/emailStore.js';
import { generateInvites, recordInviteSend } from '../services/invites.js';

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
// `products` (studio ids) selects what the invite unlocks: a proper subset is stored on the
// invite (redemption confines the account to those studios) and the email names the included
// studios with their features, marking the rest "coming soon". All studios (or none) selected
// ⇒ a full-access invite with every studio featured in the email.
adminEmailRouter.post('/invite', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email || '');
    if (!EMAIL_REGEX.test(email)) return res.status(400).json({ error: { message: 'Enter a valid email.' } });

    const rawProducts = Array.isArray(req.body?.products) ? req.body.products : [];
    const products = [...new Set(rawProducts.filter(isStudioInviteId))] as StudioInviteId[];
    if (rawProducts.length > 0 && products.length === 0) {
      return res.status(400).json({ error: { message: `products must be studio ids: ${STUDIO_INVITE_IDS.join(', ')}` } });
    }
    // Only a PROPER subset confines the redeemed account; selecting every studio (or none)
    // keeps the default full access, so future studios open up automatically too.
    const confineTo = products.length > 0 && products.length < STUDIO_INVITE_IDS.length ? products : [];
    // The email always spells out what's included: chosen studios, or all of them.
    const featured = products.length > 0 ? products : [...STUDIO_INVITE_IDS];

    const [invite] = await generateInvites({
      createdBy: req.user?.id || '',
      count: 1,
      label: req.body?.label || 'admin-invite',
      note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      maxUses: req.body?.maxUses,
      expiresInDays: req.body?.expiresInDays,
      products: confineTo
    });
    const inviteUrl = `${APP_PUBLIC_URL}/?invite=${encodeURIComponent(String(invite.code))}`;
    const result = await sendBetaInvite(
      email,
      {
        inviteUrl,
        code: String(invite.code),
        studios: featured.join(','),
        personalNote: typeof req.body?.personalNote === 'string' ? req.body.personalNote.slice(0, 500) : undefined,
        inviterName: typeof req.body?.inviterName === 'string' ? req.body.inviterName.slice(0, 80) : undefined
      },
      { userId: req.user?.id ?? null, requestId: req.requestId }
    );
    if (result.ok) {
      await recordInviteSend({
        inviteId: String(invite.id),
        code: String(invite.code),
        email,
        sentBy: req.user?.id ?? null,
        kind: 'admin'
      });
    }
    console.info('[ADMIN_ACTION] invite_emailed', { actorId: req.user?.id, code: invite.code, to: email, products: confineTo });
    res.json({ code: invite.code, inviteUrl, email, products: featured, confined: confineTo.length > 0, ...result });
  } catch (err) {
    next(err);
  }
});
