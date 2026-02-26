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

const NODE_ENV_FALLBACK = process.env.NODE_ENV || 'development';
const IS_PRODUCTION_FALLBACK = NODE_ENV_FALLBACK === 'production';
const DEFAULT_PUBLIC_CORS_ORIGINS = ['https://comic2.pages.dev'];
const DEFAULT_LOCAL_CORS_ORIGINS = ['http://localhost:7000', 'http://localhost:7001', 'http://localhost:5173'];

const parseCorsOrigins = (raw: string | undefined, isProduction: boolean) => {
  const parsed = (raw || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const defaults = isProduction
    ? DEFAULT_PUBLIC_CORS_ORIGINS
    : [...DEFAULT_PUBLIC_CORS_ORIGINS, ...DEFAULT_LOCAL_CORS_ORIGINS];
  return Array.from(new Set([...defaults, ...parsed]));
};

const parseTrustProxy = (raw: string | undefined, fallback: boolean): boolean | number | string => {
  if (!raw || !raw.trim()) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  const asNumber = Number(normalized);
  if (Number.isInteger(asNumber) && asNumber >= 0) return asNumber;
  return raw.trim();
};

export const NODE_ENV = NODE_ENV_FALLBACK;
export const IS_PRODUCTION = IS_PRODUCTION_FALLBACK;
export const BILLING_ENABLED = parseBooleanEnv(process.env.BILLING_ENABLED, true);

export const PORT = parseIntegerEnv(process.env.PORT, 7071, 'PORT', 1);
const CORS_ORIGIN_RAW = process.env.CORS_ORIGIN || process.env.CORS_ALLOWED_ORIGINS || '';
export const CORS_ORIGINS = parseCorsOrigins(CORS_ORIGIN_RAW, IS_PRODUCTION);
export const CORS_ORIGIN = CORS_ORIGINS.join(',');
export const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || '10mb';
export const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY, IS_PRODUCTION);

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
  Math.max(10, Math.floor(RATE_LIMIT_MAX_REQUESTS / 3)),
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

export const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
export const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
export const ASSISTANT_GEMINI_API_KEY = process.env.ASSISTANT_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
export const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

export const TEXT_REQUEST_TIMEOUT_MS = parseIntegerEnv(process.env.TEXT_REQUEST_TIMEOUT_MS, 60_000, 'TEXT_REQUEST_TIMEOUT_MS', 1_000);
export const IMAGE_REQUEST_TIMEOUT_MS = parseIntegerEnv(process.env.IMAGE_REQUEST_TIMEOUT_MS, 120_000, 'IMAGE_REQUEST_TIMEOUT_MS', 1_000);
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

export const STORAGE_BUCKET = process.env.STORAGE_BUCKET || 'comic-assets';
export const IMAGE_INCLUDE_DATA_URL_LEGACY = (process.env.IMAGE_INCLUDE_DATA_URL_LEGACY || '').toLowerCase() === 'true';
export const REDIS_URL = process.env.REDIS_URL || '';
export const COMICFORGE_ENABLED = parseBooleanEnv(process.env.COMICFORGE_ENABLED, false);
export const COMICFORGE_QUEUE_PREFIX = (process.env.COMICFORGE_QUEUE_PREFIX || 'comicforge').trim() || 'comicforge';
export const COMICFORGE_WORKER_CONCURRENCY = parseIntegerEnv(
  process.env.COMICFORGE_WORKER_CONCURRENCY,
  4,
  'COMICFORGE_WORKER_CONCURRENCY',
  1
);
export const COMICFORGE_JOB_RETENTION_DAYS = parseIntegerEnv(
  process.env.COMICFORGE_JOB_RETENTION_DAYS,
  14,
  'COMICFORGE_JOB_RETENTION_DAYS',
  1
);

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
  REQUIRED_RUNTIME_ENV_VARS.filter((envName) => {
    if (envName === 'CORS_ORIGIN') {
      return !process.env.CORS_ORIGIN?.trim() && !process.env.CORS_ALLOWED_ORIGINS?.trim();
    }
    return !process.env[envName]?.trim();
  });

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

  if (COMICFORGE_ENABLED && !REDIS_URL.trim()) {
    const message = '[CONFIG] ComicForge is enabled but REDIS_URL is missing. ComicForge routes will return COMICFORGE_QUEUE_UNAVAILABLE.';
    console.warn(message);
  }
};
