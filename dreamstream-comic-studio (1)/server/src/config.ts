export const PORT = Number(process.env.PORT || 7071);
export const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:7000';
export const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || '25mb';

export const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
export const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
export const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

export const TEXT_REQUEST_TIMEOUT_MS = Number(process.env.TEXT_REQUEST_TIMEOUT_MS || 60000);
export const IMAGE_REQUEST_TIMEOUT_MS = Number(process.env.IMAGE_REQUEST_TIMEOUT_MS || 120000);
export const ASSISTANT_REQUEST_TIMEOUT_MS = Number(process.env.ASSISTANT_REQUEST_TIMEOUT_MS || 30000);

export const FLUX_REQUEST_TIMEOUT_MS = Number(process.env.FLUX_REQUEST_TIMEOUT_MS || 120000);
export const FLUX_FETCH_IMAGE_TIMEOUT_MS = Number(process.env.FLUX_FETCH_IMAGE_TIMEOUT_MS || 30000);

export const PIXAZO_ENDPOINT = process.env.PIXAZO_ENDPOINT || 'https://gateway.pixazo.ai/flux-1-schnell/v1/getData';
export const FLUX_MODEL_ID = process.env.FLUX_MODEL_ID || 'pixazo/flux-1-schnell';

export const STORAGE_BUCKET = process.env.STORAGE_BUCKET || 'comic-assets';
export const IMAGE_INCLUDE_DATA_URL_LEGACY = (process.env.IMAGE_INCLUDE_DATA_URL_LEGACY || '').toLowerCase() === 'true';
