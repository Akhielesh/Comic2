// DreamStream Email Worker — the single egress point for transactional email.
//
// Sends branded mail through Cloudflare's Email Sending service (public beta, 2026):
// `env.EMAIL.send({ from, to, subject, html, text })`. Two entry points, both authenticated
// so the sender can never be abused from the open internet:
//
//   POST /send       — HMAC-signed (x-email-signature) calls from the Railway backend.
//                      Body: { template, to, params?, subject?, replyTo? }.
//   POST /auth-hook   — Supabase "Send Email Hook" (Standard Webhooks signature). Turns
//                      GoTrue's signup/magic-link/recovery/… into branded mail.
//   GET  /health      — liveness probe.
//
// Templates live in ../../shared/email (shared with the app + preview script) so the inbox
// matches the product's comic UI. Deploy: see README.md.

import {
  renderEmail,
  isEmailTemplateName,
  isMarketing,
  type BrandConfig,
  type EmailParams,
  type EmailTemplateName,
  type RenderedEmail
} from '../../shared/email';

interface EmailAddress {
  email: string;
  name?: string;
}

/** The new Cloudflare Email Sending binding (object API). Declared locally so this builds
 *  regardless of which `SendEmail` shape ships in @cloudflare/workers-types. */
interface EmailSender {
  send(message: {
    from: string | EmailAddress;
    to: string | EmailAddress | (string | EmailAddress)[];
    subject: string;
    html?: string;
    text?: string;
    cc?: string | EmailAddress | (string | EmailAddress)[];
    bcc?: string | EmailAddress | (string | EmailAddress)[];
    replyTo?: string | EmailAddress;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export interface Env {
  /** Cloudflare Email Sending binding (wrangler `send_email` → name "EMAIL"). */
  EMAIL: EmailSender;

  // ── Secrets (set with `wrangler secret put`) ──
  /** Shared HMAC secret with the Railway backend. Rejects any unsigned /send call. */
  EMAIL_HMAC_SECRET: string;
  /** Supabase auth-hook signing secret (`v1,whsec_…`). Empty ⇒ /auth-hook is disabled. */
  SUPABASE_AUTH_HOOK_SECRET?: string;

  // ── Vars (wrangler.jsonc `vars`) ──
  /** Verified sender, e.g. notifications@dreamstreamstudio.ai. */
  EMAIL_FROM: string;
  EMAIL_FROM_NAME?: string;
  EMAIL_REPLY_TO?: string;
  /** Base URL Supabase verify links hang off (the project URL or custom auth domain). */
  SUPABASE_VERIFY_URL?: string;
  // Brand overrides → shared/email BrandConfig.
  PRODUCT_NAME?: string;
  APP_URL?: string;
  SUPPORT_EMAIL?: string;
  COMPANY_NAME?: string;
  COMPANY_ADDRESS?: string;
  LOGO_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const brandFromEnv = (env: Env): Partial<BrandConfig> => ({
  productName: env.PRODUCT_NAME,
  appUrl: env.APP_URL,
  supportEmail: env.SUPPORT_EMAIL,
  companyName: env.COMPANY_NAME,
  companyAddress: env.COMPANY_ADDRESS,
  logoUrl: env.LOGO_URL
});

// ── Crypto helpers (Web Crypto, edge-native) ──────────────────────────────────
const enc = new TextEncoder();
const bytesToHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Verify the backend's `x-email-signature: sha256=<hex>` over the raw body. */
async function verifyHmac(secret: string, signature: string | null, body: string): Promise<boolean> {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return timingSafeEqual(signature, 'sha256=' + bytesToHex(mac));
}

/** Verify a Standard Webhooks signature (the scheme Supabase auth hooks use). */
async function verifyStandardWebhook(secret: string, headers: Headers, body: string): Promise<boolean> {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const sigHeader = headers.get('webhook-signature');
  if (!secret || !id || !timestamp || !sigHeader) return false;

  // Replay window: reject timestamps more than 5 minutes from now.
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(Number(timestamp)) || Math.abs(now - Number(timestamp)) > 300) return false;

  // Secret arrives as `v1,whsec_<base64>` (Supabase) — strip the known prefixes.
  let raw = secret;
  if (raw.startsWith('v1,')) raw = raw.slice(3);
  if (raw.startsWith('whsec_')) raw = raw.slice(6);

  const key = await crypto.subtle.importKey('raw', b64ToBytes(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${timestamp}.${body}`));
  const expected = bytesToB64(new Uint8Array(mac));

  // Header is a space-separated list of `v1,<base64sig>`.
  return sigHeader
    .split(' ')
    .map((part) => (part.includes(',') ? part.split(',')[1] : part))
    .some((candidate) => timingSafeEqual(candidate, expected));
}

// ── Sending ───────────────────────────────────────────────────────────────────
async function dispatch(
  env: Env,
  to: string | EmailAddress,
  rendered: RenderedEmail,
  opts: { replyTo?: string; unsubscribeUrl?: string } = {}
) {
  // RFC 8058 one-click unsubscribe — only set for marketing mail, so Gmail/Apple show a
  // native "Unsubscribe" affordance that POSTs to our backend.
  const headers: Record<string, string> = {};
  if (opts.unsubscribeUrl && /^https?:\/\//i.test(opts.unsubscribeUrl)) {
    headers['List-Unsubscribe'] = `<${opts.unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  const result = await env.EMAIL.send({
    from: env.EMAIL_FROM_NAME ? { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME } : env.EMAIL_FROM,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: opts.replyTo || env.EMAIL_REPLY_TO,
    headers: Object.keys(headers).length ? headers : undefined
  });
  return result.messageId;
}

// ── Supabase auth-hook mapping ─────────────────────────────────────────────────
interface AuthHookPayload {
  user?: { email?: string; new_email?: string; user_metadata?: Record<string, unknown> };
  email_data?: {
    token?: string;
    token_hash?: string;
    token_hash_new?: string;
    redirect_to?: string;
    email_action_type?: string;
    site_url?: string;
  };
}

const ACTION_TO_TEMPLATE: Record<string, EmailTemplateName> = {
  signup: 'auth-confirm-signup',
  magiclink: 'auth-magic-link',
  recovery: 'auth-recovery',
  invite: 'auth-invite',
  email_change: 'auth-email-change',
  email_change_new: 'auth-email-change',
  reauthentication: 'auth-reauthentication'
};

function buildVerifyUrl(env: Env, data: NonNullable<AuthHookPayload['email_data']>): string {
  const base = (env.SUPABASE_VERIFY_URL || data.site_url || '').replace(/\/$/, '');
  const type = data.email_action_type || 'signup';
  const tokenHash = data.token_hash_new || data.token_hash || '';
  const redirect = data.redirect_to ? `&redirect_to=${encodeURIComponent(data.redirect_to)}` : '';
  return `${base}/auth/v1/verify?token=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(type)}${redirect}`;
}

async function handleAuthHook(req: Request, env: Env): Promise<Response> {
  if (!env.SUPABASE_AUTH_HOOK_SECRET) return json({ error: 'auth hook disabled' }, 503);
  const body = await req.text();
  if (!(await verifyStandardWebhook(env.SUPABASE_AUTH_HOOK_SECRET, req.headers, body))) {
    return json({ error: 'invalid signature' }, 401);
  }

  let payload: AuthHookPayload;
  try {
    payload = JSON.parse(body) as AuthHookPayload;
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const data = payload.email_data;
  const to = payload.user?.email;
  const action = data?.email_action_type || '';
  const template = ACTION_TO_TEMPLATE[action];
  if (!data || !to || !template) return json({ error: `unsupported action: ${action}` }, 400);

  const meta = payload.user?.user_metadata ?? {};
  const params: EmailParams = {
    actionUrl: buildVerifyUrl(env, data),
    token: data.token,
    firstName: (meta.first_name as string) || (meta.name as string) || '',
    newEmail: payload.user?.new_email || ''
  };

  try {
    const rendered = renderEmail(template, params, brandFromEnv(env));
    const messageId = await dispatch(env, to, rendered);
    return json({ ok: true, messageId });
  } catch (err) {
    // Returning 200 here would tell Supabase the mail was sent. Surface the failure so
    // GoTrue can fall back / the dashboard shows the error.
    return json({ error: (err as Error)?.message || 'send failed' }, 502);
  }
}

// ── Backend /send ──────────────────────────────────────────────────────────────
async function handleSend(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (!(await verifyHmac(env.EMAIL_HMAC_SECRET, req.headers.get('x-email-signature'), body))) {
    return json({ error: 'invalid signature' }, 401);
  }

  let parsed: { template?: string; to?: string; params?: EmailParams; subject?: string; replyTo?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  if (!parsed.to || !isEmailTemplateName(parsed.template)) {
    return json({ error: 'template and to are required' }, 400);
  }

  try {
    const params = parsed.params ?? {};
    const rendered = renderEmail(parsed.template, params, brandFromEnv(env));
    if (parsed.subject) rendered.subject = parsed.subject;
    // Only marketing mail gets a one-click unsubscribe header.
    const unsubscribeUrl = isMarketing(parsed.template) ? params.unsubscribeUrl : undefined;
    const messageId = await dispatch(env, parsed.to, rendered, { replyTo: parsed.replyTo, unsubscribeUrl });
    return json({ ok: true, messageId });
  } catch (err) {
    return json({ error: (err as Error)?.message || 'send failed' }, 502);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'dreamstream-email-worker' });
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      return handleSend(req, env);
    }
    if (req.method === 'POST' && url.pathname === '/auth-hook') {
      return handleAuthHook(req, env);
    }
    return json({ error: 'not found' }, 404);
  }
};
