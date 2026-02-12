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

const parseTrustProxy = (raw: string | undefined, fallback: boolean): boolean | number | string => {
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

export const PORT = parseIntegerEnv(process.env.PORT, 7071, 'PORT', 1);
export const CORS_ORIGINS = parseCorsOrigins(process.env.CORS_ORIGIN);
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

export const REQUIRED_RUNTIME_ENV_VARS = ['CORS_ORIGIN', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'] as const;
type RequiredRuntimeEnv = (typeof REQUIRED_RUNTIME_ENV_VARS)[number];

export const STRICT_ENV_VALIDATION = parseBooleanEnv(process.env.STRICT_ENV_VALIDATION, IS_PRODUCTION);

export const getMissingRequiredEnvVars = (): RequiredRuntimeEnv[] =>
  REQUIRED_RUNTIME_ENV_VARS.filter((envName) => !process.env[envName]?.trim());

export const validateRuntimeConfig = () => {
  const missing = getMissingRequiredEnvVars();
  if (missing.length === 0) return;

  const message = `[CONFIG] Missing required environment variables: ${missing.join(', ')}.`;
  if (STRICT_ENV_VALIDATION) {
    throw new Error(message);
  }
  console.warn(`${message} Running with degraded behavior because STRICT_ENV_VALIDATION=false.`);
};
