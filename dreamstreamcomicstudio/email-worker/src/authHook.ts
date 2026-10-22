// Supabase Auth "Send Email Hook" — the pure half of POST /auth-hook. No env, no I/O, no
// Worker globals beyond WebCrypto/atob/btoa (all present in Node 18+), so every rule here is
// unit-tested in authHook.test.ts and the Worker route stays a thin shell.
//
//   verifyStandardWebhook()  Standard Webhooks signature + replay-window check.
//   planAuthEmails()         Supabase payload → exactly which email(s) to send, to whom,
//                            with which template/link/code — or a reasoned skip/reject.
//
// Sources of truth (re-check them when Supabase changes the hook):
//   https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook   (payload, action types,
//       email-change token pairing, verify-link format)
//   https://supabase.com/docs/guides/auth/auth-hooks                    (signing + status codes)
//   github.com/supabase/auth internal/api/mail.go + internal/mailer     (what GoTrue really sends)

import {
  DEFAULT_BRAND,
  type BrandConfig,
  type EmailParams,
  type EmailTemplateName
} from '../../shared/email';

// ── Standard Webhooks signature ────────────────────────────────────────────────

/** Standard Webhooks' default tolerance (also what Supabase's own examples use). */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export const webhookHeaders = (headers: Headers): WebhookHeaders => ({
  id: headers.get('webhook-id'),
  timestamp: headers.get('webhook-timestamp'),
  signature: headers.get('webhook-signature')
});

// `reason?: undefined` on the ok arm keeps `.reason` readable under the root (non-strict) tsconfig.
export type WebhookVerdict =
  | { ok: true; reason?: undefined }
  | { ok: false; reason: 'no-secret' | 'bad-secret' | 'missing-headers' | 'bad-timestamp' | 'stale-timestamp' | 'bad-signature' };

const enc = new TextEncoder();

const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** Constant-time string compare (length leak only — fine for fixed-size MACs). */
export const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * Decode the hook secret(s) to raw HMAC keys. Supabase shows the secret as
 * `v1,whsec_<standard-base64>`; the Standard Webhooks form is `whsec_<base64>`. Several secrets
 * may be joined with `|` (Supabase's own multi-secret format) so a rotation can overlap.
 * Returns null when any part isn't valid base64.
 */
export function parseHookSecrets(secret: string): Uint8Array[] | null {
  const parts = String(secret || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const keys: Uint8Array[] = [];
  for (let raw of parts) {
    if (raw.startsWith('v1,')) raw = raw.slice(3);
    if (raw.startsWith('whsec_')) raw = raw.slice(6);
    try {
      const bin = atob(raw);
      if (!bin.length) return null;
      keys.push(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } catch {
      return null;
    }
  }
  return keys;
}

/**
 * `webhook-signature` is a delimited list of `v1,<base64>` entries. The spec separates them
 * with spaces; GoTrue joins with ", " — so split on whitespace, drop stray trailing commas,
 * and keep only v1 (symmetric) signatures, mirroring the reference standardwebhooks library.
 */
export const parseSignatureHeader = (header: string): string[] =>
  header
    .split(/\s+/)
    .map((part) => part.replace(/,+$/, ''))
    .map((part) => {
      const comma = part.indexOf(',');
      return comma > 0 && part.slice(0, comma) === 'v1' ? part.slice(comma + 1) : '';
    })
    .filter(Boolean);

/** Verify a Standard Webhooks request (the scheme Supabase HTTP auth hooks use). */
export async function verifyStandardWebhook(
  secret: string | undefined,
  headers: WebhookHeaders,
  body: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<WebhookVerdict> {
  if (!secret) return { ok: false, reason: 'no-secret' };
  const keys = parseHookSecrets(secret);
  if (!keys) return { ok: false, reason: 'bad-secret' };
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing-headers' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'bad-timestamp' };
  // Replay window, both directions (a far-future timestamp is as suspect as an old one).
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: 'stale-timestamp' };

  const candidates = parseSignatureHeader(signature);
  if (!candidates.length) return { ok: false, reason: 'bad-signature' };
  const signed = enc.encode(`${id}.${timestamp}.${body}`);
  for (const key of keys) {
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expected = bytesToB64(new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, signed)));
    // Check every candidate (no early exit inside the compare loop's timing).
    let match = false;
    for (const candidate of candidates) match = timingSafeEqual(candidate, expected) || match;
    if (match) return { ok: true };
  }
  return { ok: false, reason: 'bad-signature' };
}

// ── Payload → email plan ───────────────────────────────────────────────────────

/** The `email_action_type` enum from Supabase's Send Email Hook schema. */
export const VERIFICATION_ACTIONS = ['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email', 'reauthentication'] as const;
export const NOTIFICATION_ACTIONS = [
  'password_changed_notification',
  'email_changed_notification',
  'phone_changed_notification',
  'identity_linked_notification',
  'identity_unlinked_notification',
  'mfa_factor_enrolled_notification',
  'mfa_factor_unenrolled_notification'
] as const;
export type AuthEmailAction = (typeof VERIFICATION_ACTIONS)[number] | (typeof NOTIFICATION_ACTIONS)[number];
export const SUPPORTED_ACTIONS: readonly AuthEmailAction[] = [...VERIFICATION_ACTIONS, ...NOTIFICATION_ACTIONS];

export const isNotificationAction = (action: string): action is (typeof NOTIFICATION_ACTIONS)[number] =>
  (NOTIFICATION_ACTIONS as readonly string[]).includes(action);

export interface AuthHookPayload {
  user?: {
    id?: string;
    email?: string;
    /** Pending address during an email change (GoTrue's `email_change` column). */
    new_email?: string;
    phone?: string;
    user_metadata?: Record<string, unknown>;
  };
  email_data?: {
    token?: string;
    token_hash?: string;
    token_new?: string;
    token_hash_new?: string;
    redirect_to?: string;
    email_action_type?: string;
    site_url?: string;
    old_email?: string;
    old_phone?: string;
    provider?: string;
    factor_type?: string;
  };
  /** Hook metadata GoTrue attaches (request time, client IP). Optional — not in the doc schema. */
  metadata?: { time?: string; ip_address?: string };
}

export interface PlannedEmail {
  to: string;
  template: EmailTemplateName;
  params: EmailParams;
  /** Log label, e.g. "email_change→current". Never contains tokens or addresses. */
  label: string;
}

export type AuthEmailPlan =
  /** Send every email (all must succeed — a half-sent email change can't complete). */
  | { kind: 'send'; action: string; brand: Partial<BrandConfig>; emails: PlannedEmail[] }
  /** Nothing to send, but the user's action must not fail (→ 200). */
  | { kind: 'skip'; action: string; reason: string }
  /** Malformed payload for a known action (→ 400; Supabase surfaces an error to the user). */
  | { kind: 'invalid'; action: string; reason: string };

export interface PlanOptions {
  /** Where verify links hang off: the Supabase project URL (`SUPABASE_VERIFY_URL`). Falls back to `email_data.site_url`. */
  verifyBaseUrl?: string;
  /** Public app origin (`APP_URL`) — used for brand deep links. */
  appUrl?: string;
}

export const STREAM_STUDIO_NAME = 'Stream Studio';

/** True when the (GoTrue-validated) redirect lands in the live app: /live, /live/…, /live.html. */
export const isLiveRedirect = (redirectTo: string | undefined): boolean => {
  if (!redirectTo) return false;
  try {
    return /^\/live(?:\.html)?(?:\/|$)/.test(new URL(redirectTo).pathname);
  } catch {
    return false;
  }
};

/** The Stream Studio sub-brand: product name + the live app as the brand's home link. */
export const streamStudioBrand = (appUrl?: string): Partial<BrandConfig> => ({
  productName: STREAM_STUDIO_NAME,
  appUrl: `${(appUrl || DEFAULT_BRAND.appUrl).replace(/\/+$/, '')}/live`
});

/** Brand overrides for this send: Stream Studio for live-app flows, the env brand otherwise. */
export const brandForRedirect = (redirectTo: string | undefined, appUrl?: string): Partial<BrandConfig> =>
  isLiveRedirect(redirectTo) ? streamStudioBrand(appUrl) : {};

/**
 * Brand a backend `/send` may ask for by name (`body.brand`). Only 'stream-studio' exists —
 * the backend's own auth emails for the live app; anything else keeps the env brand.
 */
export const brandForSend = (brand: unknown, appUrl?: string): Partial<BrandConfig> =>
  brand === 'stream-studio' ? streamStudioBrand(appUrl) : {};

/**
 * `{base}/auth/v1/verify?token=<token_hash>&type=<type>&redirect_to=<redirect>` — the link
 * shape Supabase's docs build (GET /verify takes the *hash* in `token`). Accepts a base that
 * already ends in /auth/v1 (some GoTrue deployments report site_url that way).
 */
export function buildVerifyUrl(base: string, tokenHash: string, type: string, redirectTo?: string): string {
  let root = base.trim().replace(/\/+$/, '');
  if (!/\/auth\/v1$/.test(root)) root += '/auth/v1';
  const redirect = redirectTo ? `&redirect_to=${encodeURIComponent(redirectTo)}` : '';
  return `${root}/verify?token=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(type)}${redirect}`;
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const firstNameOf = (meta: Record<string, unknown>): string =>
  str(meta.first_name) ||
  str(meta.given_name) ||
  str(meta.name).split(/\s+/)[0] ||
  str(meta.full_name).split(/\s+/)[0] ||
  str(meta.display_name).split(/\s+/)[0] ||
  '';

const formatWhen = (iso: string | undefined): string => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC`;
};

/** Link-based actions: template + the `type` GET /verify expects. */
const LINK_ACTIONS: Record<string, { template: EmailTemplateName; params?: EmailParams }> = {
  signup: { template: 'auth-confirm-signup' },
  invite: { template: 'auth-invite' },
  magiclink: { template: 'auth-magic-link' },
  recovery: { template: 'auth-recovery' },
  // Email OTP: same template as the magic link, code-first (GET /verify accepts type=email
  // and resolves it to signup/magiclink server-side).
  email: { template: 'auth-magic-link', params: { codeFirst: '1' } }
};

/** Turn a verified Supabase Send Email Hook payload into the email(s) to send. */
export function planAuthEmails(payload: AuthHookPayload, opts: PlanOptions = {}): AuthEmailPlan {
  const data = payload?.email_data;
  const user = payload?.user ?? {};
  const action = str(data?.email_action_type);
  if (!data || !action) return { kind: 'invalid', action, reason: 'missing email_data.email_action_type' };

  const redirectTo = str(data.redirect_to) || undefined;
  const brand = brandForRedirect(redirectTo, opts.appUrl);
  const base = str(opts.verifyBaseUrl) || str(data.site_url);
  const current = str(user.email);
  const common: EmailParams = { firstName: firstNameOf(user.user_metadata ?? {}) };
  const send = (emails: PlannedEmail[]): AuthEmailPlan => ({ kind: 'send', action, brand, emails });
  const invalid = (reason: string): AuthEmailPlan => ({ kind: 'invalid', action, reason });

  const link = LINK_ACTIONS[action];
  if (link) {
    if (!current) return invalid('user.email is empty');
    if (!str(data.token_hash)) return invalid('email_data.token_hash is empty');
    if (!base) return invalid('no verify base URL (set SUPABASE_VERIFY_URL)');
    return send([
      {
        to: current,
        template: link.template,
        label: action,
        params: {
          ...common,
          ...link.params,
          actionUrl: buildVerifyUrl(base, str(data.token_hash), action, redirectTo),
          token: str(data.token) || undefined
        }
      }
    ]);
  }

  if (action === 'reauthentication') {
    if (!current) return invalid('user.email is empty');
    if (!str(data.token)) return invalid('email_data.token is empty');
    return send([{ to: current, template: 'auth-reauthentication', label: action, params: { ...common, token: str(data.token) } }]);
  }

  if (action === 'email_change') {
    // Supabase's field names are reversed for backward compatibility (see the docs' caution):
    //   token_hash_new + token     → the CURRENT address (user.email)
    //   token_hash     + token_new → the NEW address     (user.new_email)
    // Secure Email Change ON  ⇒ both pairs present ⇒ two emails, both must be confirmed.
    // Secure Email Change OFF ⇒ only token_hash (+ token or token_new) ⇒ one email, new address.
    const next = str(user.new_email);
    if (!base) return invalid('no verify base URL (set SUPABASE_VERIFY_URL)');
    if (!next) return invalid('user.new_email is empty');
    if (!str(data.token_hash)) return invalid('email_data.token_hash is empty');
    const secure = Boolean(str(data.token_hash_new));
    const toNew: PlannedEmail = {
      to: next,
      template: 'auth-email-change',
      label: 'email_change→new',
      params: {
        ...common,
        emailChangeStep: 'new',
        bothRequired: secure ? '1' : undefined,
        currentEmail: current || undefined,
        newEmail: next,
        actionUrl: buildVerifyUrl(base, str(data.token_hash), 'email_change', redirectTo),
        token: (secure ? str(data.token_new) : str(data.token) || str(data.token_new)) || undefined
      }
    };
    if (!secure) return send([toNew]);
    if (!current) return invalid('user.email is empty (secure email change needs the current address)');
    const toCurrent: PlannedEmail = {
      to: current,
      template: 'auth-email-change',
      label: 'email_change→current',
      params: {
        ...common,
        emailChangeStep: 'current',
        bothRequired: '1',
        currentEmail: current,
        newEmail: next,
        actionUrl: buildVerifyUrl(base, str(data.token_hash_new), 'email_change', redirectTo),
        token: str(data.token) || undefined
      }
    };
    return send([toCurrent, toNew]);
  }

  if (isNotificationAction(action)) {
    // GoTrue's own mailer sends the email-changed notice to the OLD address (so the previous
    // owner learns of it); every other notice goes to the account's current address.
    const oldEmail = str(data.old_email);
    const to = action === 'email_changed_notification' ? oldEmail || current : current;
    if (!to) return { kind: 'skip', action, reason: 'no recipient address for notification' };
    return send([
      {
        to,
        template: 'auth-security-notice',
        label: action,
        params: {
          ...common,
          notice: action.replace(/_notification$/, ''),
          email: current || undefined,
          oldEmail: oldEmail || undefined,
          newEmail: action === 'email_changed_notification' ? current || undefined : undefined,
          oldPhone: str(data.old_phone) || undefined,
          phone: str(user.phone) || undefined,
          provider: str(data.provider) || undefined,
          factorType: str(data.factor_type) || undefined,
          time: formatWhen(payload.metadata?.time) || undefined,
          ip: str(payload.metadata?.ip_address) || undefined
        }
      }
    ]);
  }

  // A type Supabase added after this code was written: never fail the user's action over it.
  return { kind: 'skip', action, reason: `unsupported email_action_type "${action}"` };
}

/** `ada@example.com` → `a***@example.com` — enough to correlate logs without storing addresses. */
export const maskEmail = (email: string): string => {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
};
