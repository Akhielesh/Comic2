// Mailer — the backend's single entry point for sending branded transactional email.
//
// It does the safety + bookkeeping, then hands the actual send to the email-worker over an
// HMAC-signed POST (the worker owns Cloudflare Email Sending + template rendering):
//   1. dormant unless configured (EMAIL_WORKER_URL + EMAIL_HMAC_SECRET) — never throws;
//   2. marketing suppression — refuses 'marketing' mail to opted-out addresses;
//   3. HARD cost cap — refuses to send past EMAIL_MAX_PER_DAY / EMAIL_MAX_PER_MONTH (defaults
//      sit under Cloudflare's free 3,000/mo), emitting a cost alert to the logs. Part of each
//      cap is reserved for auth mail (EMAIL_AUTH_RESERVE_PER_*; abuse-ops-4): other templates
//      stop at the cap minus the reserve, and a send a signed-out request triggered counts
//      against that sender's daily allowance (EMAIL_ANON_MAX_PER_CLIENT_PER_DAY, per IPv4
//      address / IPv6 /64), so a stranger can never use up the mail sign-in needs — nor delay
//      it: auth mail is checked in a lane of its own (see "Cap gate");
//   4. logs every attempt to email_log (observability + the cost accounting above);
//   5. builds the working one-click unsubscribe link (marketing) + read-receipt pixel.
//
// Template names + their essential/marketing classification come straight from the shared
// module the worker renders with, so there's a single source of truth and no drift.

import crypto from 'crypto';
import {
  APP_PUBLIC_URL,
  EMAIL_ANON_MAX_PER_CLIENT_PER_DAY,
  EMAIL_AUTH_RESERVE_PER_DAY,
  EMAIL_AUTH_RESERVE_PER_MONTH,
  EMAIL_HMAC_SECRET,
  EMAIL_MAX_PER_DAY,
  EMAIL_MAX_PER_MONTH,
  EMAIL_PUBLIC_BASE_URL,
  EMAIL_REQUEST_TIMEOUT_MS,
  EMAIL_WORKER_URL
} from '../config.js';
import { TEMPLATE_KIND, type EmailParams, type EmailTemplateName, type StudioInviteId } from '../../../shared/email/index.js';
import { clientKey } from '../lib/clientKey.js';
import { getRateLimitStore } from '../middleware/rateLimitStore.js';
import { maskEmail } from './authEmailLinks.js';
import { getUsage, isAuthTemplate, isSuppressed, logSend, normalizeEmail, patchLog, type EmailUsage } from './emailStore.js';

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
  /**
   * Render with a sub-brand instead of the worker's env brand (subject, header, From name).
   * 'stream-studio' = live-app auth mail. An older worker ignores it and uses DreamStream.
   */
  brand?: 'stream-studio';
  /** false ⇒ no read-receipt pixel. Auth mail opts out: it carries sign-in links, not campaigns. */
  track?: boolean;
  /**
   * Set (to req.ip, even when empty) when a signed-out request triggered this send: it then
   * counts against that sender's EMAIL_ANON_MAX_PER_CLIENT_PER_DAY, per IPv4 address / IPv6 /64.
   * Leave it out for signed-in and admin sends.
   */
  anonymousClientIp?: string;
}

// ── Auth reserve (abuse-ops-4) ──────────────────────────────────────────────────
/** A reserve is never more than half its cap, so a small cap still leaves other mail room. */
const effectiveReserve = (cap: number, reserve: number): number => (cap > 0 ? Math.min(reserve, Math.floor(cap / 2)) : 0);

/** What non-auth templates may use of each cap (0 = that cap is off). */
const otherShare = () => ({
  day: EMAIL_MAX_PER_DAY > 0 ? EMAIL_MAX_PER_DAY - effectiveReserve(EMAIL_MAX_PER_DAY, EMAIL_AUTH_RESERVE_PER_DAY) : 0,
  month: EMAIL_MAX_PER_MONTH > 0 ? EMAIL_MAX_PER_MONTH - effectiveReserve(EMAIL_MAX_PER_MONTH, EMAIL_AUTH_RESERVE_PER_MONTH) : 0
});

const usageParts = (usage: EmailUsage) => {
  const authDay = usage.authDay ?? 0;
  const authMonth = usage.authMonth ?? 0;
  return { authDay, authMonth, otherDay: Math.max(0, usage.day - authDay), otherMonth: Math.max(0, usage.month - authMonth) };
};

// One warning per bucket, period and threshold (50%, 80%) — not one per send.
const warnedThresholds = new Set<string>();
const noteThreshold = (label: string, period: 'day' | 'month', used: number, cap: number): void => {
  if (cap <= 0) return;
  const now = new Date().toISOString();
  const periodKey = period === 'day' ? now.slice(0, 10) : now.slice(0, 7);
  for (const pct of [80, 50]) {
    if (used < Math.ceil((cap * pct) / 100)) continue;
    const key = `${label}:${period}:${periodKey}:${pct}`;
    if (!warnedThresholds.has(key)) {
      if (warnedThresholds.size > 200) warnedThresholds.clear();
      warnedThresholds.add(key);
      console.warn(
        `[email][COST] ${label}: ${used}/${cap} this ${period} (≥${pct}%).` +
          (label === 'all mail' ? " Cloudflare's free tier is 3,000/mo, then $0.35/1,000." : ' The rest is kept for sign-in and password mail.')
      );
    }
    return;
  }
};

/** Test hook: forget which thresholds were already reported and which caps were last seen closed. */
export const resetMailerWarnings = (): void => {
  warnedThresholds.clear();
  closedLanes.auth = null;
  closedLanes.other = null;
};

const ANON_WINDOW_MS = 24 * 60 * 60_000;
/** True when this signed-out sender has used up its daily allowance (and counts this try). */
const anonymousSenderOverLimit = async (ip: string): Promise<boolean> => {
  if (EMAIL_ANON_MAX_PER_CLIENT_PER_DAY <= 0) return false;
  try {
    const hit = await getRateLimitStore().hit(`email_anon:${clientKey(ip) ?? 'unknown'}`, ANON_WINDOW_MS, EMAIL_ANON_MAX_PER_CLIENT_PER_DAY);
    return hit.count > EMAIL_ANON_MAX_PER_CLIENT_PER_DAY;
  } catch {
    return false; // a limiter-store hiccup never blocks mail; the global caps still stand
  }
};

// ── Cap gate ────────────────────────────────────────────────────────────────────
// The check-then-log step of a send (read usage → apply the caps → log `queued`) runs one at a
// time per lane in this process, so parallel requests at the edge of a cap cannot all read the
// same count and all pass: the next one reads the `queued` row the previous one wrote. Only that
// step is serialized — not a refusal's log row, not the round trip to the email Worker.
//
// Auth mail has a lane of its own, so sign-in, confirm and reset mail never waits behind a queue
// of other mail. One send from each lane can pass at the same moment, so the hard cap (and, when
// an auth row lands between the four counts, the non-auth share) may be passed by one email per
// process; auth may use the whole cap anyway.
type Lane = 'auth' | 'other';
const laneOf = (template: string): Lane => (isAuthTemplate(template) ? 'auth' : 'other');
const laneGates: Record<Lane, Promise<unknown>> = { auth: Promise.resolve(), other: Promise.resolve() };
const oneAtATime = <T>(lane: Lane, step: () => Promise<T>): Promise<T> => {
  const run = laneGates[lane].then(step, step);
  laneGates[lane] = run.catch(() => undefined);
  return run;
};

// Once the caps refuse a lane, its later sends are refused without reading usage or waiting in
// the gate (sends already queued drain the same way), so a flood of refused mail costs only its
// own log rows. The lane is checked again after a minute — a queued send that failed frees its
// place — and at the next UTC midnight, when the day count starts over.
const CLOSED_RECHECK_MS = 60_000;
interface ClosedLane {
  until: number;
  /** The email_log error a refusal carries: 'auth_reserve' for the share, none for the hard cap. */
  error?: string;
}
const closedLanes: Record<Lane, ClosedLane | null> = { auth: null, other: null };
const closeLanes = (lanes: Lane[], error?: string): void => {
  const now = Date.now();
  const d = new Date(now);
  const nextUtcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  for (const lane of lanes) closedLanes[lane] = { until: Math.min(now + CLOSED_RECHECK_MS, nextUtcMidnight), error };
};
const closedLane = (lane: Lane): ClosedLane | null => {
  const closed = closedLanes[lane];
  if (closed && Date.now() < closed.until) return closed;
  closedLanes[lane] = null;
  return null;
};

/** Usage snapshot + caps, for ops/cost dashboards and honest cost alerts. */
export const getEmailUsageStatus = async () => {
  const usage = await getUsage();
  const parts = usageParts(usage);
  const share = otherShare();
  const pct = (n: number, max: number) => (max > 0 ? Math.round((n / max) * 100) : 0);
  return {
    configured: mailerConfigured(),
    // day / month against maxPerDay / maxPerMonth is also the auth-mail rule: auth may use the
    // whole cap (routes/authEmail.ts emailReady reads exactly this).
    day: usage.day,
    month: usage.month,
    maxPerDay: EMAIL_MAX_PER_DAY,
    maxPerMonth: EMAIL_MAX_PER_MONTH,
    dayPct: pct(usage.day, EMAIL_MAX_PER_DAY),
    monthPct: pct(usage.month, EMAIL_MAX_PER_MONTH),
    // abuse-ops-4: auth mail's own count, and what every other template may use.
    authDay: parts.authDay,
    authMonth: parts.authMonth,
    otherDay: parts.otherDay,
    otherMonth: parts.otherMonth,
    otherMaxPerDay: share.day,
    otherMaxPerMonth: share.month,
    authReservePerDay: effectiveReserve(EMAIL_MAX_PER_DAY, EMAIL_AUTH_RESERVE_PER_DAY),
    authReservePerMonth: effectiveReserve(EMAIL_MAX_PER_MONTH, EMAIL_AUTH_RESERVE_PER_MONTH),
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
  const to = normalizeEmail(opts.to);
  const template = opts.template;
  const kind = TEMPLATE_KIND[template];
  const params: EmailParams = { ...(opts.params ?? {}) };
  const baseLog = { toEmail: to, template, kind, userId: opts.userId ?? null, requestId: opts.requestId ?? null };

  // (1) dormant — still leave an audit row, otherwise "no email and no trace" is undebuggable.
  if (!mailerConfigured()) {
    await logSend({ ...baseLog, status: 'skipped', error: 'not_configured' });
    return { ok: false, skipped: 'not_configured' };
  }

  // (2) marketing suppression
  if (kind === 'marketing' && (await isSuppressed(to))) {
    await logSend({ ...baseLog, status: 'suppressed' });
    return { ok: false, skipped: 'suppressed' };
  }

  // (3a) a signed-out sender's own daily allowance (abuse-ops-4) — checked before the DB counts
  if (opts.anonymousClientIp !== undefined && (await anonymousSenderOverLimit(opts.anonymousClientIp))) {
    console.warn(`[email][ANON-CAP] A signed-out sender reached ${EMAIL_ANON_MAX_PER_CLIENT_PER_DAY} emails today. Skipping ${template} → ${maskEmail(to)}.`);
    await logSend({ ...baseLog, status: 'rate_limited', error: 'anon_sender_cap' });
    return { ok: false, skipped: 'rate_limited' };
  }

  // (3b)–(4) under the cap gate: the caps read in-flight sends, and this send is logged `queued`
  // before the next one in its lane reads them. A refusal is logged after the gate is released.
  type Refusal = { refused: SendResult; log: { status: 'rate_limited' | 'skipped'; error?: string } };
  type Admission = { logId: string | null; unsubscribeUrl?: string };
  const lane = laneOf(template);
  const refusedByClosedLane = (): Refusal | null => {
    const closed = closedLane(lane);
    return closed ? { refused: { ok: false, skipped: 'rate_limited' }, log: { status: 'rate_limited', error: closed.error } } : null;
  };
  const admitted: Refusal | Admission =
    refusedByClosedLane() ??
    (await oneAtATime(lane, async (): Promise<Refusal | Admission> => {
      const known = refusedByClosedLane();
      if (known) return known;
      // (3b) hard cost cap — never exceed the configured ceiling
      const usage = await getUsage();
      const overMonth = EMAIL_MAX_PER_MONTH > 0 && usage.month >= EMAIL_MAX_PER_MONTH;
      const overDay = EMAIL_MAX_PER_DAY > 0 && usage.day >= EMAIL_MAX_PER_DAY;
      if (overMonth || overDay) {
        console.error(
          `[email][COST-CAP] Hard send limit reached (day ${usage.day}/${EMAIL_MAX_PER_DAY}, ` +
            `month ${usage.month}/${EMAIL_MAX_PER_MONTH}). Skipping ${template} → ${maskEmail(to)}. ` +
            `Raise EMAIL_MAX_PER_* to allow more (Cloudflare bills past 3,000/mo).`
        );
        closeLanes(['auth', 'other']);
        return { refused: { ok: false, skipped: 'rate_limited' }, log: { status: 'rate_limited' } };
      }
      // (3c) the auth reserve: every other template stops at its share of the caps
      const parts = usageParts(usage);
      const share = otherShare();
      if (lane === 'other') {
        const overShareDay = EMAIL_MAX_PER_DAY > 0 && parts.otherDay >= share.day;
        const overShareMonth = EMAIL_MAX_PER_MONTH > 0 && parts.otherMonth >= share.month;
        if (overShareDay || overShareMonth) {
          console.warn(
            `[email][RESERVE] Non-auth mail reached its share (day ${parts.otherDay}/${share.day}, month ` +
              `${parts.otherMonth}/${share.month}); the rest is kept for sign-in and password mail. ` +
              `Skipping ${template} → ${maskEmail(to)}.`
          );
          closeLanes(['other'], 'auth_reserve');
          return { refused: { ok: false, skipped: 'rate_limited' }, log: { status: 'rate_limited', error: 'auth_reserve' } };
        }
      }
      // Honest early warnings at 50% and 80%: all mail against the caps, other mail against its share.
      noteThreshold('all mail', 'day', usage.day, EMAIL_MAX_PER_DAY);
      noteThreshold('all mail', 'month', usage.month, EMAIL_MAX_PER_MONTH);
      if (lane === 'other') {
        noteThreshold('non-auth mail', 'day', parts.otherDay, share.day);
        noteThreshold('non-auth mail', 'month', parts.otherMonth, share.month);
      }

      // (5) working unsubscribe (marketing only) — legally required, so refuse if we can't build it
      let unsubscribeUrl = params.unsubscribeUrl;
      if (kind === 'marketing' && !unsubscribeUrl) {
        if (!EMAIL_PUBLIC_BASE_URL) {
          console.warn(`[email] Refusing marketing send (${template}) — EMAIL_PUBLIC_BASE_URL unset; cannot build unsubscribe link.`);
          return { refused: { ok: false, skipped: 'no_unsub_base' }, log: { status: 'skipped', error: 'no_unsub_base' } };
        }
        unsubscribeUrl = `${EMAIL_PUBLIC_BASE_URL}/api/newsletter/unsubscribe?e=${encodeURIComponent(to)}&t=${unsubscribeToken(to)}`;
      }

      // (4) log 'queued' first so we have an id for the read-receipt pixel (and the next send's caps see it)
      return { logId: await logSend({ ...baseLog, status: 'queued' }), unsubscribeUrl };
    }));
  if ('refused' in admitted) {
    // Refusals are not counted by the caps (they read queued / sent), so this row needs no gate.
    await logSend({ ...baseLog, ...admitted.log });
    return admitted.refused;
  }
  const { logId } = admitted;
  if (admitted.unsubscribeUrl) params.unsubscribeUrl = admitted.unsubscribeUrl;
  if (opts.track === false) {
    delete params.pixelUrl;
  } else if (logId && EMAIL_PUBLIC_BASE_URL) {
    params.pixelUrl = `${EMAIL_PUBLIC_BASE_URL}/api/email/o/${logId}.gif`;
  }

  const body = JSON.stringify({
    template,
    to,
    params,
    subject: opts.subject,
    replyTo: opts.replyTo,
    ...(opts.brand ? { brand: opts.brand } : {})
  });
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
    console.warn(`[email] send failed (${template} → ${maskEmail(to)}): ${error}`);
    return { ok: false, error };
  } catch (err) {
    const error = (err as Error)?.message || 'network error';
    if (logId) await patchLog(logId, { status: 'failed', error });
    console.warn(`[email] send error (${template} → ${maskEmail(to)}): ${error}`);
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
};

// ── Typed convenience wrappers ──────────────────────────────────────────────────
const meta = (req?: { userId?: string | null; requestId?: string | null; anonymousClientIp?: string }) => ({
  userId: req?.userId ?? null,
  requestId: req?.requestId ?? null,
  ...(req?.anonymousClientIp !== undefined ? { anonymousClientIp: req.anonymousClientIp } : {})
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
  // `studios` (comma-separated product ids) makes the email name the included studios,
  // walk their features, and mark the rest "coming soon". Omitted ⇒ generic beta copy.
  invite: { inviteUrl: string; inviterName?: string; personalNote?: string; code?: string; studios?: string },
  req?: Parameters<typeof meta>[0]
) => sendEmail({ to: email, template: 'beta-invite', params: { ...invite }, ...meta(req) });

export const sendStudioInvite = (
  email: string,
  // `studio` picks the per-studio feature cards + deep link in the shared template;
  // omitted ⇒ the template's Stream Studio default (existing calls are unchanged).
  invite: { inviteUrl: string; studio?: StudioInviteId; studioName?: string; inviterName?: string; personalNote?: string; firstName?: string },
  req?: Parameters<typeof meta>[0]
) => sendEmail({ to: email, template: 'studio-invite', params: { ...invite }, ...meta(req) });
