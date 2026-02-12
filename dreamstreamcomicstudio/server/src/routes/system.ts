import { Router } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getMissingRequiredEnvVars, STORAGE_BUCKET, STRICT_ENV_VALIDATION } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { checkSupabaseReachability, getSupabaseAdmin, getSupabaseCapabilityStatus, supabase } from '../services/supabase.js';

export const systemRouter = Router();
const SIGNED_URL_TTL_SECONDS = 60 * 30;
const STORAGE_PATH_MAX_LENGTH = 512;
type SignedTransform = { width?: number; height?: number; quality?: number; format?: 'origin' };

const parsePositiveInt = (value: unknown, min: number, max: number): number | undefined => {
  const normalized = typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
  if (!normalized || !normalized.trim()) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return undefined;
  const intValue = Math.floor(parsed);
  if (intValue < min || intValue > max) return undefined;
  return intValue;
};

const sanitizeImagePath = (value: unknown): string | null => {
  const raw = typeof value === 'string' ? value : Array.isArray(value) ? value[0] : '';
  const normalized = raw.trim().replace(/^\/+/, '');
  if (!normalized) return null;
  if (normalized.length > STORAGE_PATH_MAX_LENGTH) return null;
  if (normalized.includes('..') || normalized.includes('\\')) return null;
  return normalized;
};

const parseImageTransform = (query: Record<string, unknown>): SignedTransform | undefined => {
  const width = parsePositiveInt(query.w, 16, 4096);
  const height = parsePositiveInt(query.h, 16, 4096);
  const quality = parsePositiveInt(query.q, 10, 100);
  const formatRaw = typeof query.f === 'string' ? query.f.trim().toLowerCase() : Array.isArray(query.f) ? String(query.f[0]).trim().toLowerCase() : '';
  const format: SignedTransform['format'] = formatRaw === 'origin' ? 'origin' : undefined;

  if (!width && !height && !quality && !format) return undefined;
  return {
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(quality ? { quality } : {}),
    ...(format ? { format } : {})
  };
};

const extractBearerToken = (authorizationHeader: unknown): string | null => {
  if (typeof authorizationHeader !== 'string') return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
};

const resolveRequesterId = async (authorizationHeader: unknown): Promise<string | null> => {
  const token = extractBearerToken(authorizationHeader);
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
};

const parseProjectScopedPath = (imagePath: string): { ownerId: string; projectId: string } | null => {
  const match = imagePath.match(/^u\/([0-9a-f-]{36})\/p\/([0-9a-f-]{36})\/img\/.+$/i);
  if (!match) return null;
  return { ownerId: match[1], projectId: match[2] };
};

const parseTempPath = (imagePath: string): { ownerId: string } | null => {
  const match = imagePath.match(/^u\/([0-9a-f-]{36})\/tmp\/.+$/i);
  if (!match) return null;
  return { ownerId: match[1] };
};

type AccessCheckResult =
  | { allowed: true }
  | { allowed: false; status: number; message: string };

const canAccessImagePath = async (
  supabaseAdmin: SupabaseClient,
  imagePath: string,
  requesterId: string | null
): Promise<AccessCheckResult> => {
  const projectScoped = parseProjectScopedPath(imagePath);
  if (projectScoped) {
    if (requesterId && requesterId === projectScoped.ownerId) return { allowed: true };

    const { data: project, error } = await supabaseAdmin
      .from('projects')
      .select('id, user_id, is_public')
      .eq('id', projectScoped.projectId)
      .maybeSingle();

    if (error) throw error;
    if (!project) return { allowed: false, status: 404, message: 'Image not found.' };
    if (project.is_public) return { allowed: true };
    if (requesterId && requesterId === project.user_id) return { allowed: true };
    if (!requesterId) {
      return { allowed: false, status: 401, message: 'Authentication required for this image.' };
    }
    return { allowed: false, status: 403, message: 'Image access denied.' };
  }

  const tempScoped = parseTempPath(imagePath);
  if (tempScoped) {
    if (!requesterId) {
      return { allowed: false, status: 401, message: 'Authentication required for this image.' };
    }
    if (requesterId !== tempScoped.ownerId) {
      return { allowed: false, status: 403, message: 'Image access denied.' };
    }
    return { allowed: true };
  }

  if (!requesterId) {
    return { allowed: false, status: 401, message: 'Authentication required for this image.' };
  }

  if (imagePath.startsWith(`u/${requesterId}/`)) return { allowed: true };

  const { data: asset, error: assetError } = await supabaseAdmin
    .from('image_assets')
    .select('user_id, project_id')
    .eq('path', imagePath)
    .maybeSingle();

  if (assetError) {
    const code = String((assetError as { code?: string }).code || '').toUpperCase();
    if (code === '42P01') {
      return { allowed: false, status: 403, message: 'Image access denied.' };
    }
    throw assetError;
  }
  if (!asset) return { allowed: false, status: 404, message: 'Image not found.' };
  if (asset.user_id === requesterId) return { allowed: true };

  if (asset.project_id) {
    const { data: project, error: projectError } = await supabaseAdmin
      .from('projects')
      .select('id, user_id, is_public')
      .eq('id', asset.project_id)
      .maybeSingle();
    if (projectError) throw projectError;
    if (project?.is_public || project?.user_id === requesterId) return { allowed: true };
  }

  return { allowed: false, status: 403, message: 'Image access denied.' };
};

systemRouter.get('/status', (_req, res) => {
  const capabilities = getSupabaseCapabilityStatus();
  res.json({
    status: 'ok',
    ...capabilities
  });
});

systemRouter.get('/ready', async (_req, res) => {
  const missingEnvVars = getMissingRequiredEnvVars();
  const supabase = await checkSupabaseReachability();
  const ready = missingEnvVars.length === 0 && supabase.reachable;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    strictEnvValidation: STRICT_ENV_VALIDATION,
    checks: {
      env: {
        ok: missingEnvVars.length === 0,
        missing: missingEnvVars
      },
      supabase: {
        ok: supabase.reachable,
        latencyMs: supabase.latencyMs,
        ...(supabase.error ? { error: supabase.error } : {}),
        ...(supabase.warning ? { warning: supabase.warning } : {})
      }
    }
  });
});

systemRouter.get('/image-url', async (req, res, next) => {
  try {
    const imagePath = sanitizeImagePath(req.query.path);
    if (!imagePath) {
      return res.status(400).json({ error: { message: 'Query parameter "path" is required.' } });
    }

    const requesterId = await resolveRequesterId(req.headers.authorization);
    const supabaseAdmin = getSupabaseAdmin();
    const access = await canAccessImagePath(supabaseAdmin, imagePath, requesterId);
    if (!access.allowed) {
      const denied = access as Exclude<AccessCheckResult, { allowed: true }>;
      return res.status(denied.status).json({ error: { message: denied.message } });
    }

    const transform = parseImageTransform(req.query as Record<string, unknown>);
    const { data, error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(imagePath, SIGNED_URL_TTL_SECONDS, transform ? { transform } : undefined);

    if (error || !data?.signedUrl) {
      if (error) throw error;
      return res.status(404).json({ error: { message: 'Image not found.' } });
    }

    return res.json({
      url: data.signedUrl,
      path: imagePath,
      expiresIn: SIGNED_URL_TTL_SECONDS
    });
  } catch (error) {
    const maybeError = error as { publicCode?: string; status?: number; message?: string };
    if (maybeError?.publicCode === 'MISSING_SUPABASE_CONFIG') {
      return res.status(503).json({
        error: {
          code: maybeError.publicCode,
          message: 'Server storage is unavailable. Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.'
        }
      });
    }
    if (maybeError?.publicCode === 'MISSING_SERVICE_ROLE_KEY') {
      return res.status(503).json({
        error: {
          code: maybeError.publicCode,
          message: 'Server storage is unavailable. Missing SUPABASE_SERVICE_ROLE_KEY.'
        }
      });
    }
    next(error);
  }
});

systemRouter.get('/diagnostics', requireAuth, requireAdmin, (_req, res) => {
  const geminiKeyPresent = !!process.env.GEMINI_API_KEY;
  const pixazoKeyPresent = !!(process.env.PIXAZO_API_KEY || process.env.PIXAZO_SUBSCRIPTION_KEY || process.env.FLUX_API_KEY);
  const capabilities = getSupabaseCapabilityStatus();

  res.json({
    status: 'ok',
    geminiKeyPresent,
    pixazoKeyPresent,
    ...capabilities
  });
});
