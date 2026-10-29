// Plain words for Settings → Security: devices, sign-ins and times. Never a raw user-agent string
// (the same rules as the new-sign-in email, email-worker/src/securityAlert.ts).
import type { MyDevice, SecurityEvent } from '../../account';

/** "Chrome on macOS", "Safari on iPhone"… */
export function describeBrowser(ua: string | null | undefined): string {
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

const PLATFORM: Record<string, string> = { web: 'Browser', ios: 'iPhone or iPad', android: 'Android', watchos: 'Apple Watch', wearos: 'Wear OS watch' };
export const platformLabel = (p: string): string => PLATFORM[p] ?? 'Device';
export const platformIcon = (p: string): string => (p === 'watchos' || p === 'wearos' ? 'clock' : p === 'web' ? 'monitor' : 'phone');

/** "28 Oct 2026, 21:05" in the reader's own time zone. */
export function formatWhen(at: string | number, now: Date = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === now.getFullYear();
  try {
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit' });
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function timeAgo(at: string | number, now: number = Date.now()): string {
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) {
    const d = Math.floor(s / 86400);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }
  return formatWhen(t, new Date(now));
}

const METHOD: Record<string, string> = {
  password: 'with the password',
  otp: 'with a one-time code',
  magiclink: 'with an email link',
  recovery: 'with a password-reset link',
  invite: 'from an invitation',
  email_change: 'after an email change',
  'email/signup': 'from a sign-up link',
};

/** One history line: what happened, and the small print under it. */
export function describeEvent(e: SecurityEvent): { title: string; detail: string; icon: string; warn?: boolean } {
  const name = typeof e.detail?.name === 'string' ? e.detail.name : null;
  switch (e.kind) {
    case 'sign_in': {
      const how = e.method ? (METHOD[e.method] ?? (e.method.startsWith('oauth') ? 'with Google or another provider' : null)) : null;
      const where = [describeBrowser(e.ua), e.ip ? `near ${e.ip}` : null].filter(Boolean).join(' · ');
      return { title: `Signed in${how ? ` ${how}` : ''}`, detail: `${where} · ${formatWhen(e.at)}`, icon: 'user' };
    }
    case 'secured': {
      const n = typeof e.detail?.sessions === 'number' && e.detail.sessions >= 0 ? e.detail.sessions : null;
      const f = typeof e.detail?.factors === 'number' && e.detail.factors > 0 ? e.detail.factors : 0;
      return {
        title: 'Account secured from a “Not you?” email',
        detail: `${n == null ? 'Every session was asked to end' : `Every session was signed out (${n})`}${f ? ` · ${f === 1 ? 'an authenticator' : `${f} authenticators`} removed` : ''} · ${formatWhen(e.at)}`,
        icon: 'shield',
        warn: true,
      };
    }
    case 'mfa_on':
      return { title: 'Two-step sign-in turned on', detail: `${describeBrowser(e.ua)} · ${formatWhen(e.at)}`, icon: 'shield' };
    case 'mfa_added':
      return { title: 'Authenticator added', detail: `${describeBrowser(e.ua)} · ${formatWhen(e.at)}`, icon: 'phone' };
    case 'mfa_removed':
      return { title: 'Authenticator removed', detail: formatWhen(e.at), icon: 'phone' };
    case 'mfa_codes':
      return { title: 'New recovery codes made', detail: `The old ones stopped working · ${formatWhen(e.at)}`, icon: 'lock' };
    case 'mfa_recovered':
      return {
        title: 'Two-step sign-in switched off with a recovery code',
        detail: `${describeBrowser(e.ua)} · ${formatWhen(e.at)}`,
        icon: 'alert',
        warn: true,
      };
    case 'device_added':
      return { title: `Device added${name ? `: ${name}` : ''}`, detail: formatWhen(e.at), icon: 'plus' };
    case 'device_revoked':
      return { title: `Device signed out${name ? `: ${name}` : ''}`, detail: formatWhen(e.at), icon: 'logout' };
    default:
      return { title: 'Account activity', detail: formatWhen(e.at), icon: 'info' };
  }
}

/** "Added 3 Oct · last used 5 min ago", or when it was signed out. */
export function describeDevice(d: MyDevice, now: number = Date.now()): string {
  if (d.revoked_at) return `${platformLabel(d.platform)} · signed out ${formatWhen(d.revoked_at, new Date(now))}`;
  return `${platformLabel(d.platform)} · added ${formatWhen(d.created_at, new Date(now))} · last used ${timeAgo(d.last_seen, now)}`;
}

/** The setup key in groups of four, easier to read aloud or type ("JBSW Y3DP EHPK 3PXP"). */
export const groupKey = (secret: string): string => (secret.replace(/\s+/g, '').match(/.{1,4}/g) ?? []).join(' ');
