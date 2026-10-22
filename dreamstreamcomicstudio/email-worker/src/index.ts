// DreamStream Email Worker — the single egress point for transactional email.
//
// Sends branded mail through Cloudflare's Email Sending service (public beta, 2026):
// `env.EMAIL.send({ from, to, subject, html, text })`. Two entry points, both authenticated
// so the sender can never be abused from the open internet:
//
//   POST /send       — HMAC-signed (x-email-signature) calls from the backend.
//                      Body: { template, to, params?, subject?, replyTo?, brand? }.
//                      brand: 'stream-studio' renders + signs as Stream Studio (the backend's
//                      live-app auth emails); any other value is ignored.
//   POST /auth-hook   — Supabase "Send Email Hook" (Standard Webhooks signature). Turns every
//                      GoTrue email (signup, magic link/OTP, recovery, invite, email change,
//                      reauthentication, security notifications) into branded mail. The
//                      pure verify + payload→email logic lives in ./authHook.ts (unit-tested).
//   GET  /health      — liveness probe.
//
// Templates live in ../../shared/email (shared with the app + preview script) so the inbox
// matches the product's comic UI. Deploy: see README.md.

import {
  renderEmail,
  isEmailTemplateName,
  isMarketing,
  senderRoleFor,
  type BrandConfig,
  type EmailParams,
  type EmailTemplateName,
  type RenderedEmail
} from '../../shared/email';
import {
  brandForSend,
  maskEmail,
  planAuthEmails,
  timingSafeEqual,
  verifyStandardWebhook,
  webhookHeaders,
  type AuthHookPayload
} from './authHook';

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
  /** Shared HMAC secret with the backend. Rejects any unsigned /send call. */
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

/** Verify the backend's `x-email-signature: sha256=<hex>` over the raw body. */
async function verifyHmac(secret: string, signature: string | null, body: string): Promise<boolean> {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return timingSafeEqual(signature, 'sha256=' + bytesToHex(mac));
}

// Pick the FROM mailbox for a template's sender role (no-reply@ / hello@ / notifications@),
// all on the verified sending domain. Any address on that domain is allowed once the domain
// is onboarded — no per-address verification needed.
// `fromName` overrides the display name for one send (Stream Studio auth mail).
function senderFrom(env: Env, template: EmailTemplateName, fromName?: string): EmailAddress {
  const [defaultLocal, domain] = env.EMAIL_FROM.split('@');
  const zone = (domain || 'dreamstreamstudio.ai').trim();
  const role = senderRoleFor(template);
  const email =
    role === 'no-reply' ? `no-reply@${zone}` : role === 'hello' ? `hello@${zone}` : `${defaultLocal || 'notifications'}@${zone}`;
  const name = fromName || env.EMAIL_FROM_NAME;
  return name ? { email, name } : { email };
}

// ── Sending ───────────────────────────────────────────────────────────────────
async function dispatch(
  env: Env,
  to: string | EmailAddress,
  rendered: RenderedEmail,
  opts: { replyTo?: string; unsubscribeUrl?: string; from?: EmailAddress } = {}
) {
  // RFC 8058 one-click unsubscribe — only set for marketing mail, so Gmail/Apple show a
  // native "Unsubscribe" affordance that POSTs to our backend.
  const headers: Record<string, string> = {};
  if (opts.unsubscribeUrl && /^https?:\/\//i.test(opts.unsubscribeUrl)) {
    headers['List-Unsubscribe'] = `<${opts.unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  const result = await env.EMAIL.send({
    from: opts.from || (env.EMAIL_FROM_NAME ? { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME } : env.EMAIL_FROM),
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    // Replies always route to the support mailbox, even for no-reply senders (the body tells
    // recipients not to reply, but if they do, it lands somewhere a human can see).
    replyTo: opts.replyTo || env.EMAIL_REPLY_TO,
    headers: Object.keys(headers).length ? headers : undefined
  });
  return result.messageId;
}

// ── Supabase auth hook ─────────────────────────────────────────────────────────
// Status codes follow Supabase's HTTP-hook contract: 200 = handled (GoTrue reads an `error`
// key in a 200 body as a failure, so success bodies never carry one); any 4xx/5xx fails the
// user's auth action. Every response is application/json, which GoTrue requires.
const hookError = (status: number, message: string): Response => json({ error: { http_code: status, message } }, status);

async function handleAuthHook(req: Request, env: Env): Promise<Response> {
  // No secret ⇒ refuse rather than accept unsigned calls. Never enable the hook in Supabase
  // before this secret is set: while it's missing, every auth email fails.
  if (!env.SUPABASE_AUTH_HOOK_SECRET) return hookError(503, 'auth hook disabled');
  const body = await req.text();
  const verdict = await verifyStandardWebhook(env.SUPABASE_AUTH_HOOK_SECRET, webhookHeaders(req.headers), body);
  if (!verdict.ok) {
    console.warn(`[auth-hook] rejected request: ${verdict.reason}`);
    return hookError(401, 'invalid signature');
  }

  let payload: AuthHookPayload;
  try {
    payload = JSON.parse(body) as AuthHookPayload;
  } catch {
    return hookError(400, 'invalid json');
  }

  const plan = planAuthEmails(payload, { verifyBaseUrl: env.SUPABASE_VERIFY_URL, appUrl: env.APP_URL });
  if (plan.kind === 'skip') {
    // e.g. an email_action_type Supabase added after this deploy — log it, don't break the user's flow.
    console.warn(`[auth-hook] skipped ${plan.action || '(none)'}: ${plan.reason}`);
    return json({ ok: true, skipped: true, reason: plan.reason });
  }
  if (plan.kind === 'invalid') {
    console.error(`[auth-hook] invalid ${plan.action || '(none)'} payload: ${plan.reason}`);
    return hookError(400, plan.reason);
  }

  const brand = { ...brandFromEnv(env), ...plan.brand };
  // Send in parallel (Supabase gives the whole hook ~5s). An email change needs BOTH mails —
  // if either fails, report failure so the user retries instead of waiting on a dead link.
  const results = await Promise.allSettled(
    plan.emails.map(async (email) =>
      dispatch(env, email.to, renderEmail(email.template, email.params, brand), {
        from: senderFrom(env, email.template, plan.brand.productName)
      })
    )
  );
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [{ email: plan.emails[i], error: r.reason }] : []));
  results.forEach((r, i) => {
    const { label, to } = plan.emails[i];
    if (r.status === 'fulfilled') console.log(`[auth-hook] sent ${label} → ${maskEmail(to)} (${r.value})`);
  });
  if (failed.length) {
    for (const f of failed) {
      console.error(`[auth-hook] send failed ${f.email.label} → ${maskEmail(f.email.to)}: ${(f.error as Error)?.message || f.error}`);
    }
    // Returning 200 would tell Supabase the mail went out. Surface it so the user sees an error.
    return hookError(502, (failed[0].error as Error)?.message || 'send failed');
  }
  return json({ ok: true, sent: results.length });
}

// ── Backend /send ──────────────────────────────────────────────────────────────
async function handleSend(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (!(await verifyHmac(env.EMAIL_HMAC_SECRET, req.headers.get('x-email-signature'), body))) {
    return json({ error: 'invalid signature' }, 401);
  }

  let parsed: { template?: string; to?: string; params?: EmailParams; subject?: string; replyTo?: string; brand?: unknown };
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
    // Same merge as /auth-hook: a sub-brand overrides the env brand (name, home link, From name).
    const override = brandForSend(parsed.brand, env.APP_URL);
    const rendered = renderEmail(parsed.template, params, { ...brandFromEnv(env), ...override });
    if (parsed.subject) rendered.subject = parsed.subject;
    // Only marketing mail gets a one-click unsubscribe header.
    const unsubscribeUrl = isMarketing(parsed.template) ? params.unsubscribeUrl : undefined;
    const messageId = await dispatch(env, parsed.to, rendered, {
      replyTo: parsed.replyTo,
      unsubscribeUrl,
      from: senderFrom(env, parsed.template, override.productName)
    });
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
