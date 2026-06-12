const parseIntegerEnv = (raw: string | undefined, fallback: number, envName: string, min = 0) => {
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) {
    console.warn(`[CONFIG] Invalid ${envName}="${raw}". Falling back to ${fallback}.`);
    return fallback;
  }
  return Math.floor(parsed);
};

const parseBooleanEnv = (raw: string | undefined, fallback: boolean) => {
  if (!raw || !raw.trim()) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  console.warn(`[CONFIG] Invalid boolean value "${raw}". Falling back to ${fallback}.`);
  return fallback;
};

const parseCorsOrigins = (raw: string | undefined) => {
  const parsed = (raw || 'http://localhost:7000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : ['http://localhost:7000'];
};

const parseTrustProxy = (raw: string | undefined, fallback: boolean | number): boolean | number | string => {
  if (!raw || !raw.trim()) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  const asNumber = Number(normalized);
  if (Number.isInteger(asNumber) && asNumber >= 0) return asNumber;
  return raw.trim();
};

export const NODE_ENV = process.env.NODE_ENV || 'development';
export const IS_PRODUCTION = NODE_ENV === 'production';
export const BILLING_ENABLED = parseBooleanEnv(process.env.BILLING_ENABLED, true);

export const PORT = parseIntegerEnv(process.env.PORT, 7071, 'PORT', 1);
export const CORS_ORIGINS = parseCorsOrigins(process.env.CORS_ORIGIN);
export const CORS_ORIGIN = CORS_ORIGINS.join(',');

// Production brand domains that are ALWAYS trusted for CORS, in addition to whatever
// CORS_ORIGIN lists. This keeps the live site working even if CORS_ORIGIN is forgotten or
// misconfigured on the host (Railway), and covers tokenized Studio preview subdomains
// (`<port>-<id>-<token>.dreamstreamstudio.ai`). Apex, `www`, and any subdomain of these are
// matched. HTTPS-only — http://localhost dev origins still come through CORS_ORIGIN above.
//
// `comic2.pages.dev` is the live Cloudflare Pages frontend; trusting it here (plus its
// `<hash>.comic2.pages.dev` preview deploys) prevents the "network error" the chat/comic
// flows hit when the browser's CORS check fails because Railway's CORS_ORIGIN wasn't set.
// NOTE: only the project's own `*.comic2.pages.dev` is trusted, NOT all of `pages.dev`.
const TRUSTED_ORIGIN_DOMAINS = ['dreamstreamstudio.ai', 'dreamstreamstudio.com', 'comic2.pages.dev'];

export const isAllowedOrigin = (origin: string | undefined): boolean => {
  // No Origin header = non-browser / same-origin request — allow (matches prior behavior).
  if (!origin) return true;
  if (CORS_ORIGINS.includes(origin)) return true;
  let hostname: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return false;
    hostname = url.hostname.toLowerCase();
  } catch {
    return false;
  }
  return TRUSTED_ORIGIN_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
};
export const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || '10mb';
// Default to trusting exactly ONE proxy hop in production (Railway's edge), not
// `true`: trust=true takes the LEFTMOST X-Forwarded-For value — i.e. whatever the
// CLIENT sends — so every IP-keyed rate limit and guest quota could be bypassed
// by rotating a spoofed header. Set TRUST_PROXY explicitly if the topology differs.
export const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY, IS_PRODUCTION ? 1 : false);

export const RATE_LIMIT_WINDOW_MS = parseIntegerEnv(process.env.RATE_LIMIT_WINDOW_MS, 60_000, 'RATE_LIMIT_WINDOW_MS', 1_000);
export const RATE_LIMIT_MAX_REQUESTS = parseIntegerEnv(process.env.RATE_LIMIT_MAX_REQUESTS, 120, 'RATE_LIMIT_MAX_REQUESTS', 1);
export const RATE_LIMIT_TEXT_MAX_REQUESTS = parseIntegerEnv(
  process.env.RATE_LIMIT_TEXT_MAX_REQUESTS,
  RATE_LIMIT_MAX_REQUESTS,
  'RATE_LIMIT_TEXT_MAX_REQUESTS',
  1
);
export const RATE_LIMIT_IMAGE_MAX_REQUESTS = parseIntegerEnv(
  process.env.RATE_LIMIT_IMAGE_MAX_REQUESTS,
  Math.max(20, Math.floor(RATE_LIMIT_MAX_REQUESTS / 2)),
  'RATE_LIMIT_IMAGE_MAX_REQUESTS',
  1
);
export const RATE_LIMIT_SYSTEM_MAX_REQUESTS = parseIntegerEnv(
  process.env.RATE_LIMIT_SYSTEM_MAX_REQUESTS,
  RATE_LIMIT_MAX_REQUESTS * 2,
  'RATE_LIMIT_SYSTEM_MAX_REQUESTS',
  1
);
export const RATE_LIMIT_VISION_MAX_REQUESTS = parseIntegerEnv(
  process.env.RATE_LIMIT_VISION_MAX_REQUESTS,
  RATE_LIMIT_TEXT_MAX_REQUESTS,
  'RATE_LIMIT_VISION_MAX_REQUESTS',
  1
);

export const IDEMPOTENCY_TTL_MS = parseIntegerEnv(process.env.IDEMPOTENCY_TTL_MS, 15 * 60_000, 'IDEMPOTENCY_TTL_MS', 1_000);

// Foursquare Places API (optional). When set, find_places uses Foursquare for rich
// local results (ratings, price, photos); otherwise it falls back to keyless OSM.
export const FOURSQUARE_API_KEY = process.env.FOURSQUARE_API_KEY || '';
// API version date for the current Foursquare Places API (overridable if it changes).
export const FOURSQUARE_API_VERSION = process.env.FOURSQUARE_API_VERSION || '2025-06-17';

export const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
export const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
export const ASSISTANT_GEMINI_API_KEY = process.env.ASSISTANT_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
export const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

// 50s, hard-capped at 55s: Railway's edge proxy cuts non-streaming requests at ~60s with a
// bare 504, so any model timeout ≥60s means the CLIENT never sees our structured error —
// production showed naked 504s on /api/text/analyze-script + /story-tool while the server
// happily waited 90s. Staying under the edge guarantees a JSON timeout error (retryable,
// names the model) instead. Real fix for slow models is picking faster ones (autoRouter
// now skips timeout-prone free models), not waiting longer.
const RAW_TEXT_TIMEOUT = parseIntegerEnv(process.env.TEXT_REQUEST_TIMEOUT_MS, 50_000, 'TEXT_REQUEST_TIMEOUT_MS', 1_000);
export const TEXT_REQUEST_TIMEOUT_MS = Math.min(RAW_TEXT_TIMEOUT, 55_000);
// Maximum output (completion) tokens for the AI Chat Platform. The old flat 2048 cap
// truncated long answers AND — critically — cut off generate_app/render_chart tool-call
// arguments mid-JSON (the whole app/chart rides in those arguments), so "build me an
// app/chart" silently produced nothing. Raised so chat behaves like a pro assistant.
export const CHAT_MAX_OUTPUT_TOKENS = parseIntegerEnv(process.env.CHAT_MAX_OUTPUT_TOKENS, 8192, 'CHAT_MAX_OUTPUT_TOKENS', 256);
// Hard backstop for a single streaming model call. The streaming timeout below is an IDLE
// window (reset on every token) so legitimately long answers/code generation finish; this
// caps total wall-clock so a dribbling/stuck upstream can't stream forever.
export const CHAT_STREAM_MAX_TOTAL_MS = parseIntegerEnv(process.env.CHAT_STREAM_MAX_TOTAL_MS, 300_000, 'CHAT_STREAM_MAX_TOTAL_MS', 10_000);
export const IMAGE_REQUEST_TIMEOUT_MS = parseIntegerEnv(process.env.IMAGE_REQUEST_TIMEOUT_MS, 60_000, 'IMAGE_REQUEST_TIMEOUT_MS', 1_000);
export const ASSISTANT_REQUEST_TIMEOUT_MS = parseIntegerEnv(process.env.ASSISTANT_REQUEST_TIMEOUT_MS, 30_000, 'ASSISTANT_REQUEST_TIMEOUT_MS', 1_000);

export const FLUX_REQUEST_TIMEOUT_MS = parseIntegerEnv(process.env.FLUX_REQUEST_TIMEOUT_MS, 120_000, 'FLUX_REQUEST_TIMEOUT_MS', 1_000);
export const FLUX_FETCH_IMAGE_TIMEOUT_MS = parseIntegerEnv(
  process.env.FLUX_FETCH_IMAGE_TIMEOUT_MS,
  30_000,
  'FLUX_FETCH_IMAGE_TIMEOUT_MS',
  1_000
);

export const PIXAZO_ENDPOINT = process.env.PIXAZO_ENDPOINT || 'https://gateway.pixazo.ai/flux-1-schnell/v1/getData';
export const FLUX_MODEL_ID = process.env.FLUX_MODEL_ID || 'pixazo/flux-1-schnell';

// --- Ideogram (BYOK image generation; users add their own Ideogram API key) ---
export const IDEOGRAM_ENDPOINT = process.env.IDEOGRAM_ENDPOINT || 'https://api.ideogram.ai/generate';
export const IDEOGRAM_MODEL_ID = process.env.IDEOGRAM_MODEL_ID || 'ideogram/ideogram-v2';
// Default Ideogram model version sent to the API when a request doesn't name a concrete variant.
export const IDEOGRAM_MODEL_VERSION = process.env.IDEOGRAM_MODEL_VERSION || 'V_2';
export const IDEOGRAM_REQUEST_TIMEOUT_MS = parseIntegerEnv(
  process.env.IDEOGRAM_REQUEST_TIMEOUT_MS,
  120_000,
  'IDEOGRAM_REQUEST_TIMEOUT_MS',
  1_000
);
export const IDEOGRAM_FETCH_IMAGE_TIMEOUT_MS = parseIntegerEnv(
  process.env.IDEOGRAM_FETCH_IMAGE_TIMEOUT_MS,
  30_000,
  'IDEOGRAM_FETCH_IMAGE_TIMEOUT_MS',
  1_000
);

// --- OpenRouter (unified gateway: text + image, incl. Gemini-family models via OpenRouter) ---
// AI_PROVIDER gates the unified path: 'gemini' = legacy Google SDK + Pixazo, 'openrouter' = gateway.
export const AI_PROVIDER = (process.env.AI_PROVIDER || 'gemini').trim().toLowerCase();

// --- Named platform keys (set in Railway; secrets — values must never be logged) ----
// DREAMSTREAMSTUDIO_ALL — THE OpenRouter key that serves all user traffic. Per-user
//   spend on it is hard-capped by the monthly platform allowance
//   (PLATFORM_MONTHLY_ALLOWANCE_USD, default $5/user/month — enforced in
//   services/usageEnforcer.ts via services/platformAllowance.ts; BYOK traffic never
//   counts against it).
// DREAMSTREAMSTUDIO_MODELTEST — a separate key dedicated to model testing (the bench
//   harness, the source validators, the verification runner — see
//   jobs/preferModelTestKey.ts). Deliberately kept OUT of the user-serving key pool so
//   test spend never mixes with user spend, and either key can be rotated or capped at
//   OpenRouter independently.
export const DREAMSTREAMSTUDIO_ALL_KEY =
  (process.env.DREAMSTREAMSTUDIO_ALL || process.env.dreamstreamstudio_all || '').trim();
export const DREAMSTREAMSTUDIO_MODELTEST_KEY =
  (process.env.DREAMSTREAMSTUDIO_MODELTEST || process.env.dreamstreamstudio_modeltest || '').trim();

export const OPENROUTER_API_KEY = DREAMSTREAMSTUDIO_ALL_KEY || process.env.OPENROUTER_API_KEY || '';
// Several call sites (middleware/keys, routes/models, jobs) read the env var directly,
// so normalize it to the resolved value — every platform-key path then uses the ALL key.
if (OPENROUTER_API_KEY) process.env.OPENROUTER_API_KEY = OPENROUTER_API_KEY;
// F1: provider key-pool. The single key above is always included; OPENROUTER_API_KEYS adds more
// (comma-separated) so one rate-limited key can't throttle the platform. De-duped by KeyPool.
export const OPENROUTER_API_KEYS = [OPENROUTER_API_KEY, ...(process.env.OPENROUTER_API_KEYS || '').split(',')]
  .map((k) => k.trim())
  .filter(Boolean);
export const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
export const OPENROUTER_APP_URL = process.env.OPENROUTER_APP_URL || 'https://dreamstreamstudio.ai';
export const OPENROUTER_APP_TITLE = process.env.OPENROUTER_APP_TITLE || 'DreamStream Comic Studio';
// Default model IDs (overridable). These intentionally route Gemini-family models THROUGH OpenRouter.
export const OPENROUTER_TEXT_MODEL = process.env.OPENROUTER_TEXT_MODEL || 'google/gemini-2.5-flash';
export const OPENROUTER_IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image';
export const OPENROUTER_FREE_TEXT_MODEL = process.env.OPENROUTER_FREE_TEXT_MODEL || 'google/gemini-2.0-flash-exp:free';
export const OPENROUTER_REQUEST_TIMEOUT_MS = parseIntegerEnv(
  process.env.OPENROUTER_REQUEST_TIMEOUT_MS,
  60_000,
  'OPENROUTER_REQUEST_TIMEOUT_MS',
  1_000
);
// Reasoning effort applied to reasoning-capable models on the OpenRouter path.
// 'off' disables; otherwise 'low' | 'medium' | 'high'. Non-reasoning models ignore it.
export const REASONING_EFFORT = ((): 'off' | 'low' | 'medium' | 'high' => {
  const raw = (process.env.REASONING_EFFORT || 'medium').trim().toLowerCase();
  return raw === 'off' || raw === 'low' || raw === 'high' ? raw : 'medium';
})();

// --- NVIDIA Build (NIM): OpenAI-compatible text/LLM source (https://integrate.api.nvidia.com/v1) ---
// BYOK: users add their own `nvapi-...` key (free tier: ~1,000 credits, 40 req/min). A platform
// key is optional and only used to populate the shared catalog when no user key is present.
export const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '';
// F1: NVIDIA key-pool (single key + optional comma-separated NVIDIA_API_KEYS). De-duped by KeyPool.
export const NVIDIA_API_KEYS = [NVIDIA_API_KEY, ...(process.env.NVIDIA_API_KEYS || '').split(',')]
  .map((k) => k.trim())
  .filter(Boolean);
export const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
// Default NVIDIA NIM text model used when a request doesn't name a concrete NVIDIA model.
export const NVIDIA_TEXT_MODEL = process.env.NVIDIA_TEXT_MODEL || 'meta/llama-3.3-70b-instruct';
// Default NVIDIA NIM image model (free tier) for the OpenAI-compatible /images/generations path.
export const NVIDIA_IMAGE_MODEL = process.env.NVIDIA_IMAGE_MODEL || 'black-forest-labs/flux.1-schnell';
export const NVIDIA_REQUEST_TIMEOUT_MS = parseIntegerEnv(
  process.env.NVIDIA_REQUEST_TIMEOUT_MS,
  60_000,
  'NVIDIA_REQUEST_TIMEOUT_MS',
  1_000
);

export const STORAGE_BUCKET = process.env.STORAGE_BUCKET || 'comic-assets';
export const IMAGE_INCLUDE_DATA_URL_LEGACY = (process.env.IMAGE_INCLUDE_DATA_URL_LEGACY || '').toLowerCase() === 'true';
// Redis connection string (BullMQ broker) — used by the ventures queue/worker.
export const REDIS_URL = process.env.REDIS_URL || '';

// --- Studio v2 (Cloudflare container live previews) ---
// The control plane (/api/studio/*) brokers signed requests to the Studio Worker. Both
// values must be set for live Studio to work; otherwise /api/studio returns 503.
export const STUDIO_WORKER_URL = process.env.STUDIO_WORKER_URL || '';
export const STUDIO_HMAC_SECRET = process.env.STUDIO_HMAC_SECRET || '';
// Per-user cost-safety caps.
export const STUDIO_MAX_CONCURRENT_PER_USER = parseIntegerEnv(
  process.env.STUDIO_MAX_CONCURRENT_PER_USER,
  2,
  'STUDIO_MAX_CONCURRENT_PER_USER',
  1
);
export const STUDIO_DAILY_BUILD_MINUTES = parseIntegerEnv(
  process.env.STUDIO_DAILY_BUILD_MINUTES,
  120,
  'STUDIO_DAILY_BUILD_MINUTES',
  1
);
export const STUDIO_REQUEST_TIMEOUT_MS = parseIntegerEnv(
  process.env.STUDIO_REQUEST_TIMEOUT_MS,
  120_000,
  'STUDIO_REQUEST_TIMEOUT_MS',
  1_000
);
// Advisory $/awake-second for cost display (≈ standard-3: memory+CPU ≈ $0.1/hr). Keep in
// sync with docs/studio/CLOUDFLARE_STUDIO_PLAN.md.
export const STUDIO_COST_PER_AWAKE_SEC = Number(process.env.STUDIO_COST_PER_AWAKE_SEC || '0.00003');

// --- Transactional email (Cloudflare Email Sending via email-worker) --------------
// The backend never talks to the email service directly — it signs requests to the
// email-worker (HMAC, mirroring the Studio worker). EMPTY EMAIL_WORKER_URL or
// EMAIL_HMAC_SECRET ⇒ the mailer is dormant (sends are skipped, nothing breaks).
export const EMAIL_WORKER_URL = process.env.EMAIL_WORKER_URL || '';
export const EMAIL_HMAC_SECRET = process.env.EMAIL_HMAC_SECRET || '';
// Public origin of THIS backend, used to build absolute unsubscribe + read-receipt links
// embedded in mail (e.g. https://api.dreamstreamstudio.ai). Required for marketing mail.
export const EMAIL_PUBLIC_BASE_URL = (process.env.EMAIL_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
// Public app origin used for post-confirm redirects + in-email app links.
export const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || 'https://dreamstreamstudio.ai').replace(/\/+$/, '');
export const EMAIL_REQUEST_TIMEOUT_MS = parseIntegerEnv(
  process.env.EMAIL_REQUEST_TIMEOUT_MS,
  15_000,
  'EMAIL_REQUEST_TIMEOUT_MS',
  1_000
);
// HARD cost guardrails. Defaults sit UNDER Cloudflare's free 3,000/month tier, so you
// cannot be billed for overage unless you deliberately raise EMAIL_MAX_PER_MONTH past 3000.
// When a cap is hit the send is skipped + logged (status='rate_limited') and an alert is
// emitted to the server logs. See docs/email/cloudflare-email-cost-and-limits.md.
export const EMAIL_MAX_PER_DAY = parseIntegerEnv(process.env.EMAIL_MAX_PER_DAY, 200, 'EMAIL_MAX_PER_DAY', 0);
export const EMAIL_MAX_PER_MONTH = parseIntegerEnv(process.env.EMAIL_MAX_PER_MONTH, 2_500, 'EMAIL_MAX_PER_MONTH', 0);
// Double opt-in confirm links expire after this many hours (strict link timeout). 0 = never.
export const NEWSLETTER_CONFIRM_TTL_HOURS = parseIntegerEnv(
  process.env.NEWSLETTER_CONFIRM_TTL_HOURS,
  168,
  'NEWSLETTER_CONFIRM_TTL_HOURS',
  0
);

// Cloudflare Turnstile (bot protection). Empty ⇒ gating is dormant (endpoints aren't enforced).
// Set the secret here (server) and VITE_TURNSTILE_SITE_KEY on the client to turn it on.
export const TURNSTILE_SECRET_KEY = (process.env.TURNSTILE_SECRET_KEY || '').trim();

// --- Phase 10: tools/MCP/sourcing -------------------------------------------------
// JSON tool-protocol fallback: lets non-OpenRouter models (NVIDIA, free models without
// native function-calling) use our live tools via a JSON convention. ON by default — without
// it those providers are entirely tool-blind (no web/news/finance/charts/app-builder), even
// while the persona claims "live tools enabled". The detector is strict (whole-reply JSON or
// an explicit {"tool_call":…} wrapper), so a normal answer that merely contains JSON is never
// mistaken for a call. Set JSON_TOOL_PROTOCOL_ENABLED=false to disable.
export const JSON_TOOL_PROTOCOL_ENABLED = parseBooleanEnv(process.env.JSON_TOOL_PROTOCOL_ENABLED, true);
// Bearer token that authenticates the outbound MCP endpoint (external agents calling our
// tool registry). Empty ⇒ the endpoint is disabled (returns 503) rather than open.
export const MCP_OUTBOUND_TOKEN = (process.env.MCP_OUTBOUND_TOKEN || '').trim();

// --- Autopilot (always-on autonomous ventures) — Epic A0: brakes-first, flag-gated -------
// The ENTIRE Autopilot layer is OFF by default. Nothing autonomous runs unless
// VENTURES_ENABLED is true AND the kill switch (VENTURES_KILL) is false. This keeps the
// existing Comic/Chat/Studio product completely unaffected until explicitly turned on.
// See docs/studio/autopilot/00-MASTER-PLAN.md and OPERATING-MODEL.md.
export const VENTURES_ENABLED = parseBooleanEnv(process.env.VENTURES_ENABLED, false);
// Global emergency stop: when true, the scheduler pauses ALL ventures (an admin can also flip
// this at runtime via the in-process override in ventures/killSwitch.ts).
export const VENTURES_KILL = parseBooleanEnv(process.env.VENTURES_KILL, false);
// Pilot mode: run the autonomous loop IN-PROCESS on a timer inside the API (no separate worker,
// no Redis/queue). Off by default. For validating a single instance; use the dedicated worker
// (npm run ventures:worker + REDIS_URL) for real scale.
export const VENTURES_PILOT_INLINE = parseBooleanEnv(process.env.VENTURES_PILOT_INLINE, false);
// Global cap on concurrent autonomous ticks across all ventures (protects providers + spend).
export const VENTURES_MAX_CONCURRENT_TICKS = parseIntegerEnv(
  process.env.VENTURES_MAX_CONCURRENT_TICKS,
  5,
  'VENTURES_MAX_CONCURRENT_TICKS',
  1
);
// Default per-venture budget caps (USD) applied when a venture has no explicit budget set.
export const VENTURES_DEFAULT_USD_PER_DAY = Number(process.env.VENTURES_DEFAULT_USD_PER_DAY || '5');
export const VENTURES_DEFAULT_USD_TOTAL = Number(process.env.VENTURES_DEFAULT_USD_TOTAL || '50');
// Ventures worker/scheduler (Epic A2). The worker is a SEPARATE process (npm run ventures:worker)
// and requires REDIS_URL; without it the queue is unavailable (the API is unaffected).
export const VENTURES_QUEUE_PREFIX = (process.env.VENTURES_QUEUE_PREFIX || 'ventures').trim() || 'ventures';
export const VENTURES_WORKER_CONCURRENCY = parseIntegerEnv(
  process.env.VENTURES_WORKER_CONCURRENCY,
  2,
  'VENTURES_WORKER_CONCURRENCY',
  1
);
// How often the scheduler fans out ticks to active ventures (ms). The heartbeat of the loop.
export const VENTURES_TICK_INTERVAL_MS = parseIntegerEnv(
  process.env.VENTURES_TICK_INTERVAL_MS,
  60_000,
  'VENTURES_TICK_INTERVAL_MS',
  1_000
);
// Conservative pre-spend estimate ($) per build goal, checked against the budget BEFORE acting
// (A4). Real usage-based cost metering lands with F1; until then this keeps budgets meaningful.
export const VENTURES_BUILD_COST_ESTIMATE_USD = Number(process.env.VENTURES_BUILD_COST_ESTIMATE_USD || '0.05');

export const REQUIRED_RUNTIME_ENV_VARS = ['CORS_ORIGIN', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'] as const;
type RequiredRuntimeEnv = (typeof REQUIRED_RUNTIME_ENV_VARS)[number];
export const REQUIRED_BILLING_ENV_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET'
] as const;
type RequiredBillingEnv = (typeof REQUIRED_BILLING_ENV_VARS)[number];

export const OPTIONAL_BILLING_PRICE_ENV_VARS = [
  'STRIPE_PRICE_ID',
  'STRIPE_PRICE_ID_CREATOR',
  'STRIPE_PRICE_ID_CREATOR_ANNUAL',
  'STRIPE_PRICE_ID_PRO',
  'STRIPE_PRICE_ID_PRO_ANNUAL',
  'STRIPE_PRICE_ID_STUDIO',
  'STRIPE_PRICE_ID_STUDIO_ANNUAL',
  'STRIPE_PRICE_ID_CREDIT_PACK_10',
  'STRIPE_PRICE_ID_CREDIT_PACK_25',
  'STRIPE_PRICE_ID_CREDIT_PACK_100'
] as const;

export const STRICT_ENV_VALIDATION = parseBooleanEnv(process.env.STRICT_ENV_VALIDATION, IS_PRODUCTION);

export const getMissingRequiredEnvVars = (): RequiredRuntimeEnv[] =>
  REQUIRED_RUNTIME_ENV_VARS.filter((envName) => !process.env[envName]?.trim());

export const getMissingBillingEnvVars = (): RequiredBillingEnv[] =>
  REQUIRED_BILLING_ENV_VARS.filter((envName) => !process.env[envName]?.trim());

export const validateRuntimeConfig = () => {
  const missing = getMissingRequiredEnvVars();
  if (missing.length > 0) {
    const message = `[CONFIG] Missing required environment variables: ${missing.join(', ')}.`;
    if (STRICT_ENV_VALIDATION) {
      throw new Error(message);
    }
    console.warn(`${message} Running with degraded behavior because STRICT_ENV_VALIDATION=false.`);
  }

  if (IS_PRODUCTION && BILLING_ENABLED) {
    const missingBilling = getMissingBillingEnvVars();
    if (missingBilling.length > 0) {
      throw new Error(`[CONFIG] Billing is enabled but Stripe variables are missing: ${missingBilling.join(', ')}.`);
    }
  }
};
