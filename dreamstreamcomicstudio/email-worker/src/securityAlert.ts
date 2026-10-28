// New-sign-in alerts — the pure half of POST /security (ADR 0006 D6.2 / D6.4: "every new sign-in
// is announced to you"). No env, no I/O: verify, parse and render are unit-tested in
// index.test.ts, and the Worker route stays a thin shell.
//
// Who calls it: Supabase's Custom Access Token hook (server/sql/live_security_v2.sql →
// public.live_access_token_hook → live__send_signin_alert) through pg_net, the first time it
// sees a new session that is a genuine sign-in (not a refresh, not the account's first session).
//
//   POST /security
//   x-ds-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(SECURITY_HOOK_SECRET, "<t>.<p>")>
//   {"p": "<payload JSON, as a string>"}
//
// The payload travels as a JSON *string* so its exact bytes survive pg_net's jsonb handling;
// the signature covers those bytes and a timestamp (±5 minutes), so a captured request can't
// be replayed later or pointed at another address.
//
// The email offers "Not you? Secure my account": a one-time link (7 days) into the live app,
// whose landing page posts the token to the backend (POST /api/auth/email/secure) — which ends
// every session, revokes devices added since, and emails a password-reset link.

import { button, escapeHtml, heading, infoBox, linkFallback, muted, paragraph, wrapHtml } from '../../shared/email/layout';
import type { BrandConfig } from '../../shared/email/theme';
import { MAIN_ORIGIN, STREAM_HOST_ON, toStreamUrl } from '../../shared/streamHost';
import { timingSafeEqual } from './authHook';

export const SECURITY_TOLERANCE_SECONDS = 5 * 60;
const MAX_BODY_BYTES = 16 * 1024;

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export type SecurityVerdict =
  | { ok: true; reason?: undefined }
  | { ok: false; reason: 'no-secret' | 'missing-signature' | 'bad-timestamp' | 'stale-timestamp' | 'bad-signature' | 'too-large' };

/**
 * Check `x-ds-signature` over `<t>.<p>`. `secret` may hold several values joined with `|` so a
 * rotation can overlap (same convention as the Supabase hook secret).
 */
export async function verifySecuritySignature(secret: string | undefined, header: string | null, p: string, nowMs = Date.now()): Promise<SecurityVerdict> {
  const secrets = String(secret || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!secrets.length) return { ok: false, reason: 'no-secret' };
  if (!header) return { ok: false, reason: 'missing-signature' };
  if (enc.encode(p).length > MAX_BODY_BYTES) return { ok: false, reason: 'too-large' };
  const fields = new Map<string, string[]>();
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    fields.set(k, [...(fields.get(k) ?? []), part.slice(i + 1).trim()]);
  }
  const t = fields.get('t')?.[0] ?? '';
  if (!/^\d{9,11}$/.test(t)) return { ok: false, reason: 'bad-timestamp' };
  if (Math.abs(Math.floor(nowMs / 1000) - Number(t)) > SECURITY_TOLERANCE_SECONDS) return { ok: false, reason: 'stale-timestamp' };
  const given = (fields.get('v1') ?? []).filter((v) => /^[0-9a-f]{64}$/.test(v));
  for (const s of secrets) {
    const key = await crypto.subtle.importKey('raw', enc.encode(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const want = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${p}`)));
    if (given.some((g) => timingSafeEqual(g, want))) return { ok: true };
  }
  return { ok: false, reason: 'bad-signature' };
}

export interface SignInAlert {
  email: string;
  name: string | null;
  /** When, epoch ms. */
  at: number;
  ua: string | null;
  /** Already masked by the database (/24 or /48); masked again here to be sure. */
  ip: string | null;
  /** How the session started (password, otp, oauth, recovery, …). */
  method: string | null;
  /** The one-time "Not you?" token. */
  token: string;
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** The signed payload → a sign-in alert, or null when it isn't one we send. */
export function parseSignInAlert(p: string): SignInAlert | null {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(p) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object' || d.v !== 1 || d.kind !== 'sign_in') return null;
  const email = typeof d.email === 'string' ? d.email.trim() : '';
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) return null;
  const token = typeof d.token === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(d.token) ? d.token : null;
  const at = typeof d.at === 'number' && Number.isFinite(d.at) && d.at > 0 ? d.at : null;
  if (!token || at == null) return null;
  return { email, name: str(d.name, 40), at, ua: str(d.ua, 300), ip: maskIp(str(d.ip, 64)), method: str(d.method, 40), token };
}

/** Never show a whole address: IPv4 → a.b.c.x, IPv6 → first three groups + /48. */
export function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}|x)$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`;
  if (ip.includes(':')) {
    const groups = ip.replace(/\/\d+$/, '').split(':').filter(Boolean).slice(0, 3);
    return groups.length && groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g)) ? `${groups.join(':')}::/48` : null;
  }
  return null;
}

/** "Chrome on macOS", "Safari on iPhone"… — never the raw user-agent string. */
export function describeDevice(ua: string | null): string {
  if (!ua) return 'An unknown device';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Mac OS X|Macintosh/.test(ua)
              ? 'macOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;
  const app = /DreamStream\//.test(ua)
    ? 'The DreamStream app'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /SamsungBrowser\//.test(ua)
        ? 'Samsung Internet'
        : /OPR\/|Opera/.test(ua)
          ? 'Opera'
          : /Firefox\/|FxiOS\//.test(ua)
            ? 'Firefox'
            : /CriOS\/|Chrome\//.test(ua)
              ? 'Chrome'
              : /Safari\//.test(ua)
                ? 'Safari'
                : null;
  if (app && os) return `${app} on ${os}`;
  if (app) return app;
  if (os) return `A browser on ${os}`;
  return 'An unrecognised browser or app';
}

const METHOD_WORDS: Record<string, string> = {
  password: 'with your password',
  otp: 'with a one-time code',
  magiclink: 'with an email link',
  recovery: 'with a password-reset link',
  oauth: 'with Google or another provider',
  invite: 'from an invitation',
  email_change: 'after an email change',
  'email/signup': 'from a sign-up link',
  'sso/saml': 'with single sign-on',
};

export const describeMethod = (m: string | null): string | null => (m ? (METHOD_WORDS[m] ?? (m.startsWith('oauth') ? METHOD_WORDS.oauth : null)) : null);

/** "28 Oct 2026, 21:05 UTC" — the reader's zone is unknown, so say UTC plainly. */
export function formatWhen(at: number): string {
  const d = new Date(at);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/**
 * The "Not you?" link: the live app's #/secure route with the token in the fragment (never
 * sent to a server or written to a log). Follows Stream Studio's host when it moves.
 */
export function secureAccountUrl(token: string, appUrl: string = MAIN_ORIGIN, streamHostOn: boolean = STREAM_HOST_ON): string {
  const path = `/live#/secure/${token}`;
  return streamHostOn ? toStreamUrl(path) : `${(appUrl || MAIN_ORIGIN).replace(/\/+$/, '')}${path}`;
}

export interface RenderedSecurityEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderSignInAlert(a: SignInAlert, brand: BrandConfig): RenderedSecurityEmail {
  const device = describeDevice(a.ua);
  const when = formatWhen(a.at);
  const how = describeMethod(a.method);
  const link = secureAccountUrl(a.token, brand.appUrl);
  const hi = a.name ? `Hi ${a.name},` : 'Hi,';
  const subject = `New sign-in to your ${brand.productName} account`;
  const rows: [string, string][] = [
    ['Device', device],
    ['When', when],
    ...(a.ip ? ([['Network', `${a.ip} (approximate — not a location)`]] as [string, string][]) : []),
    ...(how ? ([['How', how]] as [string, string][]) : []),
  ];
  const content =
    heading('New sign-in') +
    paragraph(`${escapeHtml(hi)} your ${escapeHtml(brand.productName)} account was just signed in to on a device we haven’t seen before.`) +
    infoBox(rows.map(([k, v]) => `<strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}`).join('<br/>')) +
    paragraph('<strong>If this was you</strong>, there’s nothing to do.') +
    paragraph(
      '<strong>If it wasn’t</strong>, secure your account now. It signs you out on every device (yours included), removes any devices added since this sign-in, and emails you a link to choose a new password.',
    ) +
    button('Not you? Secure my account', link, 'blue') +
    linkFallback(link) +
    muted('The link works once, for 7 days. We will never ask for your password by email. Turning on two-step sign-in (Settings → Security) stops a stolen password from being enough.');
  const html = wrapHtml({ brand, preheader: `${device} · ${when}. If this was you, there’s nothing to do.`, content, essential: true, noReply: true });
  const text = [
    subject,
    '',
    `${hi} your ${brand.productName} account was just signed in to on a device we haven't seen before.`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    "If this was you, there's nothing to do.",
    '',
    "If it wasn't, secure your account now. It signs you out on every device (yours included), removes any devices added since this sign-in, and emails you a link to choose a new password:",
    link,
    '',
    'The link works once, for 7 days. We will never ask for your password by email.',
    '',
    `This is a required ${brand.productName} account notification.`,
  ].join('\n');
  return { subject, html, text };
}
