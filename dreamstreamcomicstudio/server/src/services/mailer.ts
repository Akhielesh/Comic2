// Mailer — the backend's single entry point for sending branded transactional email.
//
// It does the safety + bookkeeping, then hands the actual send to the email-worker over an
// HMAC-signed POST (the worker owns Cloudflare Email Sending + template rendering):
//   1. dormant unless configured (EMAIL_WORKER_URL + EMAIL_HMAC_SECRET) — never throws;
//   2. marketing suppression — refuses 'marketing' mail to opted-out addresses;
//   3. HARD cost cap — refuses to send past EMAIL_MAX_PER_DAY / EMAIL_MAX_PER_MONTH (defaults
//      sit under Cloudflare's free 3,000/mo), emitting a cost alert to the logs;
//   4. logs every attempt to email_log (observability + the cost accounting above);
//   5. builds the working one-click unsubscribe link (marketing) + read-receipt pixel.
//
// Template names + their essential/marketing classification come straight from the shared
// module the worker renders with, so there's a single source of truth and no drift.

import crypto from 'crypto';
import {
  APP_PUBLIC_URL,
  EMAIL_HMAC_SECRET,
  EMAIL_MAX_PER_DAY,
  EMAIL_MAX_PER_MONTH,
  EMAIL_PUBLIC_BASE_URL,
  EMAIL_REQUEST_TIMEOUT_MS,
  EMAIL_WORKER_URL
} from '../config.js';
import { TEMPLATE_KIND, type EmailParams, type EmailTemplateName } from '../../../shared/email/index.js';
import { getUsage, isSuppressed, logSend, normalizeEmail, patchLog } from './emailStore.js';

export { APP_PUBLIC_URL };

/** True once the owner has wired the worker URL + shared secret (and it isn't the placeholder). */
export const mailerConfigured = (): boolean =>
  Boolean(EMAIL_WORKER_URL && EMAIL_HMAC_SECRET && !EMAIL_WORKER_URL.includes('<'));

const sign = (raw: string): string => 'sha256=' + crypto.createHmac('sha256', EMAIL_HMAC_SECRET).update(raw).digest('hex');

/** Deterministic, unforgeable unsubscribe token (HMAC over the address). */
export const unsubscribeToken = (email: string): string =>
  crypto.createHmac('sha256', EMAIL_HMAC_SECRET).update(`unsub:${normalizeEmail(email)}`).digest('hex');

export const verifyUnsubscribeToken = (email: string, token: string): boolean => {
  if (!token) return false;
  const expected = unsubscribeToken(email);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export type SendSkipReason = 'not_configured' | 'suppressed' | 'rate_limited' | 'no_unsub_base';

export interface SendResult {
  ok: boolean;
  messageId?: string;
  skipped?: SendSkipReason;
  error?: string;
}

export interface SendOptions {
  to: string;
  template: EmailTemplateName;
  params?: EmailParams;
  subject?: string;
  replyTo?: string;
  userId?: string | null;
  requestId?: string | null;
}

/** Usage snapshot + caps, for ops/cost dashboards and honest cost alerts. */
export const getEmailUsageStatus = async () => {
  const usage = await getUsage();
  const pct = (n: number, max: number) => (max > 0 ? Math.round((n / max) * 100) : 0);
  return {
    configured: mailerConfigured(),
    day: usage.day,
    month: usage.month,
    maxPerDay: EMAIL_MAX_PER_DAY,
    maxPerMonth: EMAIL_MAX_PER_MONTH,
    dayPct: pct(usage.day, EMAIL_MAX_PER_DAY),
    monthPct: pct(usage.month, EMAIL_MAX_PER_MONTH),
    // Cloudflare bills $0.35/1k only past 3,000/mo; under that it's free.
    freeTierRemaining: Math.max(0, 3000 - usage.month)
  };
};

/**
 * Send a branded email. Never throws — returns a structured result so callers (e.g. the
 * newsletter route) can treat email as best-effort. Essential mail bypasses the suppression
 * list; both essential and marketing respect the hard cost cap.
 */
export const sendEmail = async (opts: SendOptions): Promise<SendResult> => {
  if (!mailerConfigured()) return { ok: false, skipped: 'not_configured' };

  const to = normalizeEmail(opts.to);
  const template = opts.template;
  const kind = TEMPLATE_KIND[template];
  const params: EmailParams = { ...(opts.params ?? {}) };
  const baseLog = { toEmail: to, template, kind, userId: opts.userId ?? null, requestId: opts.requestId ?? null };

  // (2) marketing suppression
  if (kind === 'marketing' && (await isSuppressed(to))) {
    await logSend({ ...baseLog, status: 'suppressed' });
    return { ok: false, skipped: 'suppressed' };
  }

  // (3) hard cost cap — never exceed the configured ceiling
  const usage = await getUsage();
  const overMonth = EMAIL_MAX_PER_MONTH > 0 && usage.month >= EMAIL_MAX_PER_MONTH;
  const overDay = EMAIL_MAX_PER_DAY > 0 && usage.day >= EMAIL_MAX_PER_DAY;
  if (overMonth || overDay) {
    console.error(
      `[email][COST-CAP] Hard send limit reached (day ${usage.day}/${EMAIL_MAX_PER_DAY}, ` +
        `month ${usage.month}/${EMAIL_MAX_PER_MONTH}). Skipping ${template} → ${to}. ` +
        `Raise EMAIL_MAX_PER_* to allow more (Cloudflare bills past 3,000/mo).`
    );
    await logSend({ ...baseLog, status: 'rate_limited' });
    return { ok: false, skipped: 'rate_limited' };
  }
  // Honest early warning at 80% of the monthly cap.
  if (EMAIL_MAX_PER_MONTH > 0 && usage.month >= Math.floor(EMAIL_MAX_PER_MONTH * 0.8)) {
    console.warn(
      `[email][COST] ${usage.month}/${EMAIL_MAX_PER_MONTH} emails this month (≥80%). ` +
        `Cloudflare's free tier is 3,000/mo, then $0.35/1,000.`
    );
  }

  // (5) working unsubscribe (marketing only) — legally required, so refuse if we can't build it
  let unsubscribeUrl = params.unsubscribeUrl;
  if (kind === 'marketing' && !unsubscribeUrl) {
    if (!EMAIL_PUBLIC_BASE_URL) {
      console.warn(`[email] Refusing marketing send (${template}) — EMAIL_PUBLIC_BASE_URL unset; cannot build unsubscribe link.`);
      await logSend({ ...baseLog, status: 'skipped', error: 'no_unsub_base' });
      return { ok: false, skipped: 'no_unsub_base' };
    }
    unsubscribeUrl = `${EMAIL_PUBLIC_BASE_URL}/api/newsletter/unsubscribe?e=${encodeURIComponent(to)}&t=${unsubscribeToken(to)}`;
  }
  if (unsubscribeUrl) params.unsubscribeUrl = unsubscribeUrl;

  // (4) log 'queued' first so we have an id for the read-receipt pixel
  const logId = await logSend({ ...baseLog, status: 'queued' });
  if (logId && EMAIL_PUBLIC_BASE_URL) {
    params.pixelUrl = `${EMAIL_PUBLIC_BASE_URL}/api/email/o/${logId}.gif`;
  }

  const body = JSON.stringify({ template, to, params, subject: opts.subject, replyTo: opts.replyTo });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMAIL_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${EMAIL_WORKER_URL.replace(/\/+$/, '')}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-email-signature': sign(body) },
      body,
      signal: controller.signal
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; messageId?: string; error?: string } | null;
    if (res.ok && json?.ok) {
      if (logId) await patchLog(logId, { status: 'sent', messageId: json.messageId });
      return { ok: true, messageId: json.messageId };
    }
    const error = json?.error || `worker responded ${res.status}`;
    if (logId) await patchLog(logId, { status: 'failed', error });
    console.warn(`[email] send failed (${template} → ${to}): ${error}`);
    return { ok: false, error };
  } catch (err) {
    const error = (err as Error)?.message || 'network error';
    if (logId) await patchLog(logId, { status: 'failed', error });
    console.warn(`[email] send error (${template} → ${to}): ${error}`);
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
};

// ── Typed convenience wrappers ──────────────────────────────────────────────────
const meta = (req?: { userId?: string | null; requestId?: string | null }) => ({
  userId: req?.userId ?? null,
  requestId: req?.requestId ?? null
});

export const sendNewsletterConfirm = (email: string, confirmUrl: string, firstName?: string, req?: Parameters<typeof meta>[0]) =>
  sendEmail({ to: email, template: 'newsletter-confirm', params: { confirmUrl, firstName }, ...meta(req) });

export const sendNewsletterWelcome = (email: string, firstName?: string, req?: Parameters<typeof meta>[0]) =>
  sendEmail({ to: email, template: 'newsletter-welcome', params: { firstName }, ...meta(req) });

export const sendAccessRequested = (email: string, firstName?: string, req?: Parameters<typeof meta>[0]) =>
  sendEmail({ to: email, template: 'access-requested', params: { firstName }, ...meta(req) });

export const sendWelcome = (email: string, firstName?: string, ctaUrl?: string, req?: Parameters<typeof meta>[0]) =>
  sendEmail({ to: email, template: 'welcome', params: { firstName, ctaUrl: ctaUrl || APP_PUBLIC_URL }, ...meta(req) });

export const sendSigninAlert = (
  email: string,
  details: { firstName?: string; time?: string; device?: string; location?: string; ip?: string; secureUrl?: string },
  req?: Parameters<typeof meta>[0]
) => sendEmail({ to: email, template: 'signin-alert', params: { ...details }, ...meta(req) });

export const sendProductUpdate = (
  email: string,
  content: { title?: string; body?: string; bodyHtml?: string; ctaUrl?: string; ctaLabel?: string; subject?: string; firstName?: string },
  req?: Parameters<typeof meta>[0]
) => sendEmail({ to: email, template: 'product-update', params: { ...content }, ...meta(req) });

export const sendAnnouncement = (
  email: string,
  content: { heading?: string; body?: string; ctaUrl?: string; ctaLabel?: string; subject?: string; preheader?: string; firstName?: string },
  req?: Parameters<typeof meta>[0]
) => sendEmail({ to: email, template: 'announcement', params: { ...content }, ...meta(req) });

export const sendBetaInvite = (
  email: string,
  invite: { inviteUrl: string; inviterName?: string; personalNote?: string; code?: string },
  req?: Parameters<typeof meta>[0]
) => sendEmail({ to: email, template: 'beta-invite', params: { ...invite }, ...meta(req) });

export const sendStudioInvite = (
  email: string,
  invite: { inviteUrl: string; studioName?: string; inviterName?: string; personalNote?: string; firstName?: string },
  req?: Parameters<typeof meta>[0]
) => sendEmail({ to: email, template: 'studio-invite', params: { ...invite }, ...meta(req) });
