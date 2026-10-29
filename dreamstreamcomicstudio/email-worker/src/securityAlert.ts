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
// What the email asks someone to do if it wasn't them depends on what exists:
//   * securePage (the Worker's SECURE_ACCOUNT_PAGE = "on", set once WS-5's #/secure page has
//     shipped): "Not you? Secure my account" — a one-time link (7 days) into the live app, whose
//     landing page posts the token to the backend (POST /api/auth/email/secure), which ends every
//     session, revokes devices added since, and emails a password-reset link.
//   * otherwise (today): no such button — a button to a page that doesn't exist would leave
//     someone whose account was taken over with nothing. It sends them to the main site's
//     Settings → Security, which exists: change the password and "Sign out everywhere" (or
//     "Forgot password?" on the sign-in page if they're locked out). The token in the payload
//     is simply not shown; it lapses after 7 days.
// Either way it says "a new sign-in", never "a device we haven't seen": the database emails every
// genuinely new session and doesn't know whether the browser or network is familiar.

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

/**
 * What happened: a new sign-in (the access-token hook), or a change to two-step sign-in made from
 * a signed-in session (server/sql/live_security_v2.sql live_mfa_activate / live_mfa_recover) —
 * switched on, another authenticator added, or switched off with a recovery code. Each carries
 * its own one-time "Not you?" token: securing the account from it also removes an authenticator
 * an intruder switched on, so a stolen password can't lock the parent out.
 */
export type SecurityAlertKind = 'sign_in' | 'mfa_on' | 'mfa_added' | 'mfa_recovered';
const ALERT_KINDS: readonly string[] = ['sign_in', 'mfa_on', 'mfa_added', 'mfa_recovered'];

export interface SignInAlert {
  kind: SecurityAlertKind;
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
  if (!d || typeof d !== 'object' || d.v !== 1 || typeof d.kind !== 'string' || !ALERT_KINDS.includes(d.kind)) return null;
  const email = typeof d.email === 'string' ? d.email.trim() : '';
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) return null;
  const token = typeof d.token === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(d.token) ? d.token : null;
  const at = typeof d.at === 'number' && Number.isFinite(d.at) && d.at > 0 ? d.at : null;
  if (!token || at == null) return null;
  return { kind: d.kind as SecurityAlertKind, email, name: str(d.name, 40), at, ua: str(d.ua, 300), ip: maskIp(str(d.ip, 64)), method: str(d.method, 40), token };
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

/** Where account security lives today: the main site's Settings → Security (password, sign out everywhere). */
export function securitySettingsUrl(appUrl: string = MAIN_ORIGIN): string {
  return `${(appUrl || MAIN_ORIGIN).replace(/\/+$/, '')}/?view=settings&tab=security`;
}

export interface RenderedSecurityEmail {
  subject: string;
  html: string;
  text: string;
}

export interface SignInAlertOptions {
  /** The live app's "Not you?" page (#/secure) exists: offer the one-time secure-my-account link. */
  securePage?: boolean;
}

export function renderSignInAlert(a: SignInAlert, brand: BrandConfig, opts: SignInAlertOptions = {}): RenderedSecurityEmail {
  if (a.kind && a.kind !== 'sign_in') return renderMfaAlert(a, brand, opts);
  const device = describeDevice(a.ua);
  const when = formatWhen(a.at);
  const how = describeMethod(a.method);
  const hi = a.name ? `Hi ${a.name},` : 'Hi,';
  const subject = `New sign-in to your ${brand.productName} account`;
  const intro = `there was a new sign-in to your ${brand.productName} account.`;
  const rows: [string, string][] = [
    ['Device', device],
    ['When', when],
    ...(a.ip ? ([['Network', `${a.ip} (approximate — not a location)`]] as [string, string][]) : []),
    ...(how ? ([['How', how]] as [string, string][]) : []),
  ];

  // If it wasn't them: the one-time link when its page exists, otherwise the settings that do.
  const secure = opts.securePage === true;
  const link = secure ? secureAccountUrl(a.token, brand.appUrl) : securitySettingsUrl(brand.appUrl);
  const ifNotHtml = secure
    ? paragraph(
        '<strong>If it wasn’t</strong>, secure your account now. It signs you out on every device (yours included), removes any devices added since this sign-in, and emails you a link to choose a new password.',
      ) + button('Not you? Secure my account', link, 'blue')
    : paragraph(
        `<strong>If it wasn’t</strong>, change your password now, then choose <strong>Sign out everywhere</strong> — both are in Settings → Security on ${escapeHtml(brand.productName)}. Signing out everywhere ends every session, including the one that just signed in. If you can’t sign in, use <strong>Forgot password?</strong> on the sign-in page.`,
      ) + button('Open security settings', link, 'blue');
  const footHtml = secure
    ? muted('The link works once, for 7 days. We will never ask for your password by email. Turning on two-step sign-in (Settings → Security) stops a stolen password from being enough.')
    : muted('We will never ask for your password by email.');
  const content =
    heading('New sign-in') +
    paragraph(`${escapeHtml(hi)} ${escapeHtml(intro)}`) +
    infoBox(rows.map(([k, v]) => `<strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}`).join('<br/>')) +
    paragraph('<strong>If this was you</strong>, there’s nothing to do.') +
    ifNotHtml +
    linkFallback(link) +
    footHtml;
  const html = wrapHtml({ brand, preheader: `${device} · ${when}. If this was you, there’s nothing to do.`, content, essential: true, noReply: true });
  const ifNotText = secure
    ? [
        "If it wasn't, secure your account now. It signs you out on every device (yours included), removes any devices added since this sign-in, and emails you a link to choose a new password:",
        link,
        '',
        'The link works once, for 7 days. We will never ask for your password by email.',
      ]
    : [
        `If it wasn't, change your password now, then choose Sign out everywhere — both are in Settings → Security on ${brand.productName}. Signing out everywhere ends every session, including the one that just signed in:`,
        link,
        '',
        "If you can't sign in, use Forgot password? on the sign-in page. We will never ask for your password by email.",
      ];
  const text = [
    subject,
    '',
    `${hi} ${intro}`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    "If this was you, there's nothing to do.",
    '',
    ...ifNotText,
    '',
    `This is a required ${brand.productName} account notification.`,
  ].join('\n');
  return { subject, html, text };
}

/** The words for each two-step sign-in change. */
const MFA_COPY: Record<Exclude<SecurityAlertKind, 'sign_in'>, { subject: (p: string) => string; heading: string; intro: (p: string) => string; ok: string; secure: string }> = {
  mfa_on: {
    subject: (p) => `Two-step sign-in was turned on for your ${p} account`,
    heading: 'Two-step sign-in turned on',
    intro: (p) => `two-step sign-in was just turned on for your ${p} account. From now on, signing in on a new device asks for a code from an authenticator app.`,
    ok: '<strong>If this was you</strong>, there’s nothing to do — keep your recovery codes somewhere safe. Devices that were already signed in stay signed in.',
    secure:
      '<strong>If it wasn’t</strong>, someone may have your password. Secure your account now: it signs you out on every device (yours included), switches off the two-step sign-in they just turned on, and emails you a link to choose a new password.',
  },
  mfa_added: {
    subject: (p) => `An authenticator was added to your ${p} account`,
    heading: 'Authenticator added',
    intro: (p) => `another authenticator app was just added to two-step sign-in on your ${p} account. Codes from it now work for signing in.`,
    ok: '<strong>If this was you</strong>, there’s nothing to do.',
    secure:
      '<strong>If it wasn’t</strong>, secure your account now: it signs you out on every device (yours included), removes the authenticator that was just added, and emails you a link to choose a new password.',
  },
  mfa_recovered: {
    subject: (p) => `Two-step sign-in was switched off on your ${p} account`,
    heading: 'Two-step sign-in switched off',
    intro: (p) => `a recovery code was just used to get into your ${p} account, which switches two-step sign-in off. Signing in now needs only the password.`,
    ok: '<strong>If this was you</strong>, turn two-step sign-in on again with your new phone (Settings → Security) — you’ll get new recovery codes.',
    secure:
      '<strong>If it wasn’t</strong>, secure your account now: it signs you out on every device (yours included) and emails you a link to choose a new password. Then turn two-step sign-in on again.',
  },
};

const plain = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');

/** A change to two-step sign-in, with the same one-time "Not you?" link as a sign-in alert. */
export function renderMfaAlert(a: SignInAlert, brand: BrandConfig, opts: SignInAlertOptions = {}): RenderedSecurityEmail {
  const copy = MFA_COPY[a.kind as Exclude<SecurityAlertKind, 'sign_in'>] ?? MFA_COPY.mfa_on;
  const device = describeDevice(a.ua);
  const when = formatWhen(a.at);
  const hi = a.name ? `Hi ${a.name},` : 'Hi,';
  const subject = copy.subject(brand.productName);
  const intro = copy.intro(brand.productName);
  const rows: [string, string][] = [
    ['From', device],
    ['When', when],
    ...(a.ip ? ([['Network', `${a.ip} (approximate — not a location)`]] as [string, string][]) : []),
  ];
  const secure = opts.securePage === true;
  const link = secure ? secureAccountUrl(a.token, brand.appUrl) : null;
  const support = brand.supportEmail || 'support@dreamstreamstudio.ai';
  // Without the "Not you?" page there's no safe self-serve undo: signing out everywhere could
  // leave the parent facing a code only the intruder has. Support can — so say exactly that.
  const notYouHtml = link
    ? paragraph(copy.secure) + button('Not you? Secure my account', link, 'blue') + linkFallback(link)
    : paragraph(
        `<strong>If it wasn’t</strong>, email <a href="mailto:${escapeHtml(support)}">${escapeHtml(support)}</a> from this address straight away and we’ll secure your account with you. Don’t sign out of your other devices first.`,
      );
  const content =
    heading(copy.heading) +
    paragraph(`${escapeHtml(hi)} ${escapeHtml(intro)}`) +
    infoBox(rows.map(([k, v]) => `<strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}`).join('<br/>')) +
    paragraph(copy.ok) +
    notYouHtml +
    muted(link ? 'The link works once, for 7 days. We will never ask for your password or a code by email.' : 'We will never ask for your password or a code by email.');
  const html = wrapHtml({ brand, preheader: `${device} · ${when}. If this was you, there’s nothing to do.`, content, essential: true, noReply: true });
  const text = [
    subject,
    '',
    `${hi} ${intro}`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    plain(copy.ok),
    '',
    ...(link
      ? [plain(copy.secure), link, '', 'The link works once, for 7 days. We will never ask for your password or a code by email.']
      : [`If it wasn't, email ${support} from this address straight away and we'll secure your account with you. Don't sign out of your other devices first.`]),
    '',
    `This is a required ${brand.productName} account notification.`,
  ].join('\n');
  return { subject, html, text };
}
