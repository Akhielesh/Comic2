import { Router } from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getMissingRequiredEnvVars, STRICT_ENV_VALIDATION } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { checkSupabaseReachability, getSupabaseAdmin, getSupabaseCapabilityStatus, supabase } from '../services/supabase.js';
import { WORLD_EXTRACTION_CONTRACT_VERSION } from '../../../shared/contracts/worldExtraction.js';
import { capabilityReport } from '../ai/capabilities.js';
import { pingTools, dependencyInfo, rateLimitSummary } from '../services/systemDashboard.js';
import { projectHasComicDoc } from '../comic/store.js';
import { bucketForPath, isPrivatePath, isPublicationPath, isQuarantinePath, SIGNED_TTL_SEC } from '../comic/storagePaths.js';

export const systemRouter = Router();
const SIGNED_URL_TTL_SECONDS = 60 * 30;
/** Private lanes (reference photos) sign for 5 minutes at most (contract §12.5). */
const PRIVATE_SIGNED_URL_TTL_SECONDS = SIGNED_TTL_SEC.private;
const STORAGE_PATH_MAX_LENGTH = 512;
type SignedTransform = { width?: number; height?: number; quality?: number; format?: 'origin' };
const SERVER_START_TIMESTAMP = new Date().toISOString();

const resolveAppVersion = () => {
  if (process.env.APP_VERSION?.trim()) return process.env.APP_VERSION.trim();
  try {
    const packageJsonPath = path.resolve(process.cwd(), 'package.json');
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return parsed.version?.trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
};

const APP_VERSION = resolveAppVersion();
// GIT_SHA / BUILD_TIMESTAMP are set by the deploy-api-proxy workflow. The RAILWAY_* / VERCEL_* / CF_PAGES_*
// fallbacks stay so the same image still reports its build on those hosts.
const GIT_SHA = process.env.GIT_SHA?.trim()
  || process.env.RAILWAY_GIT_COMMIT_SHA?.trim()
  || process.env.VERCEL_GIT_COMMIT_SHA?.trim()
  || process.env.CF_PAGES_COMMIT_SHA?.trim()
  || 'unknown';
const BUILD_TIMESTAMP = process.env.BUILD_TIMESTAMP?.trim()
  || process.env.RAILWAY_DEPLOYMENT_TIMESTAMP?.trim()
  || process.env.CF_PAGES_COMMIT_TIMESTAMP?.trim()
  || SERVER_START_TIMESTAMP;

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
  // The path is authorized as a literal string but signed through a URL (storage-js does not
  // encode it), and URL parsing collapses dot segments — including percent-encoded ones
  // (`%2e%2e`) — so `u/<me>/%2e%2e/<victim>/...` would be authorized as the requester's own
  // path yet signed as the victim's. Storage paths are plain [A-Za-z0-9._-] segments: refuse
  // percent-escapes, query/fragment markers, control characters and empty or dot segments.
  if (/[%?#\u0000-\u001f\u007f]/.test(normalized)) return null;
  if (normalized.split('/').some((segment) => segment === '' || segment === '.')) return null;
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

/**
 * Any project-scoped storage path: `u/<owner>/p/<projectId>/<rest>`. `kind` is `ref` for
 * reference uploads (`.../ref/...`, often personal photos) and `asset` for everything else
 * (generated art, `img/...`).
 */
const parseProjectScopedPath = (imagePath: string): { ownerId: string; projectId: string; kind: 'ref' | 'asset' } | null => {
  const match = imagePath.match(/^u\/([0-9a-f-]{36})\/p\/([0-9a-f-]{36})\/(.+)$/i);
  if (!match) return null;
  const rest = match[3];
  return { ownerId: match[1], projectId: match[2], kind: /^ref\//i.test(rest) ? 'ref' : 'asset' };
};

const parseTempPath = (imagePath: string): { ownerId: string } | null => {
  const match = imagePath.match(/^u\/([0-9a-f-]{36})\/tmp\/.+$/i);
  if (!match) return null;
  return { ownerId: match[1] };
};

const parseLegacyOwnerPath = (imagePath: string): { ownerId: string } | null => {
  if (imagePath.startsWith('u/')) return null;
  const match = imagePath.match(/^([0-9a-f-]{36})\/[^/]+$/i);
  if (!match) return null;
  return { ownerId: match[1] };
};

const buildLegacyFallbackPath = (imagePath: string): string | null => {
  const legacy = parseLegacyOwnerPath(imagePath);
  if (!legacy) return null;
  const parts = imagePath.split('/');
  const filename = parts[1];
  if (!filename) return null;
  return `u/${legacy.ownerId}/tmp/${filename}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
};

const projectStateReferencesImagePath = (state: unknown, imagePath: string): boolean => {
  if (!isRecord(state)) return false;
  // A Comic Studio v4 row's mirrored listing state never authorizes a storage path: v4
  // readers get opaque published URLs from the public comic endpoint instead.
  if (state.studioVersion === 4) return false;

  if (typeof state.coverImageId === 'string' && state.coverImageId === imagePath) return true;
  if (typeof state.coverTemplateImageId === 'string' && state.coverTemplateImageId === imagePath) return true;

  const matchPanel = (panel: unknown) => {
    if (!isRecord(panel)) return false;
    if (typeof panel.imageId === 'string' && panel.imageId === imagePath) return true;
    const history = readStringArray(panel.imageIdHistory);
    return history.includes(imagePath);
  };

  const matchEntity = (entity: unknown) => {
    if (!isRecord(entity)) return false;
    if (typeof entity.imageId === 'string' && entity.imageId === imagePath) return true;
    const refs = readStringArray(entity.referenceImageIds);
    return refs.includes(imagePath);
  };

  const matchStyle = (variant: unknown) => {
    if (!isRecord(variant)) return false;
    return typeof variant.imageId === 'string' && variant.imageId === imagePath;
  };

  if (Array.isArray(state.panels) && state.panels.some(matchPanel)) return true;
  if (Array.isArray(state.characters) && state.characters.some(matchEntity)) return true;
  if (Array.isArray(state.items) && state.items.some(matchEntity)) return true;
  if (Array.isArray(state.locations) && state.locations.some(matchEntity)) return true;
  if (Array.isArray(state.styleVariants) && state.styleVariants.some(matchStyle)) return true;

  if (isRecord(state.imageTags) && Object.prototype.hasOwnProperty.call(state.imageTags, imagePath)) {
    return true;
  }

  return false;
};

const isPathReferencedByPublicProject = async (
  supabaseAdmin: SupabaseClient,
  ownerId: string,
  imagePath: string
): Promise<boolean> => {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('state')
    .eq('user_id', ownerId)
    .eq('is_public', true);

  if (error) throw error;
  if (!Array.isArray(data) || data.length === 0) return false;
  return data.some((row) => projectStateReferencesImagePath((row as { state?: unknown }).state, imagePath));
};

type AccessCheckResult =
  | { allowed: true }
  | { allowed: false; status: number; message: string };

const denied = (requesterId: string | null): AccessCheckResult =>
  requesterId
    ? { allowed: false, status: 403, message: 'Image access denied.' }
    : { allowed: false, status: 401, message: 'Authentication required for this image.' };

type ProjectAccessRow = { user_id: string; is_public: boolean; is_forced_private: boolean; isStudioV4: boolean };

/** Visibility facts for one project (service role). Tolerates databases without the moderation columns. */
const loadProjectAccessRow = async (supabaseAdmin: SupabaseClient, projectId: string): Promise<ProjectAccessRow | null> => {
  let row: { user_id?: string; is_public?: boolean | null; is_forced_private?: boolean | null } | null = null;
  const first = await supabaseAdmin
    .from('projects')
    .select('id, user_id, is_public, is_forced_private')
    .eq('id', projectId)
    .maybeSingle();
  if (first.error) {
    if (String((first.error as { code?: string }).code || '') !== '42703') throw first.error;
    const fallback = await supabaseAdmin.from('projects').select('id, user_id, is_public').eq('id', projectId).maybeSingle();
    if (fallback.error) throw fallback.error;
    row = fallback.data as typeof row;
  } else {
    row = first.data as typeof row;
  }
  if (!row) return null;
  return {
    user_id: String(row.user_id || ''),
    is_public: row.is_public === true,
    is_forced_private: row.is_forced_private === true,
    isStudioV4: await projectHasComicDoc(supabaseAdmin, projectId)
  };
};

/**
 * Who may get a signed URL for a storage path. The requester id comes only from the
 * verified bearer token (resolveRequesterId), never from the query.
 *
 * Bucket lanes first (storagePaths.ts): quarantine `q/…` is never signed here; private
 * `…/ref/…` paths are owner-only and sign from the private bucket for 5 minutes; opaque `pub/`
 * publication copies and versioned `library/v<n>/` objects are public.
 *
 * Project-scoped paths (`u/<owner>/p/<pid>/...`):
 *  - the path owner always may;
 *  - `.../ref/...` (reference uploads) are owner-only for every project;
 *  - Comic Studio v4 projects (a comic_docs row exists) are owner-only for every path —
 *    drafts, history and sheets all live here; published readers get opaque URLs from the
 *    public comic endpoint instead;
 *  - classic projects keep the public rule: readable while public (and not force-private).
 */
const canAccessImagePath = async (
  supabaseAdmin: SupabaseClient,
  imagePath: string,
  requesterId: string | null
): Promise<AccessCheckResult> => {
  // Quarantine (q/…) is never served here — not even to its owner. Moderators reach it only
  // through the audited moderation route.
  if (isQuarantinePath(imagePath)) return denied(requesterId);
  // Private lanes (…/ref/… reference photos, wherever the project id is a UUID or not) are
  // owner-only, decided by the path's own namespace — no project, share or public flag can
  // widen them.
  if (isPrivatePath(imagePath)) {
    return requesterId && imagePath.startsWith(`u/${requesterId}/`) ? { allowed: true } : denied(requesterId);
  }
  // Opaque publication copies (pub/<22-char key>/…) and versioned platform-library objects
  // (library/v<n>/…) are public by design: no user or project id inside.
  if (isPublicationPath(imagePath) || /^library\/v\d+\//.test(imagePath)) return { allowed: true };

  const projectScoped = parseProjectScopedPath(imagePath);
  if (projectScoped) {
    if (requesterId && requesterId === projectScoped.ownerId) return { allowed: true };
    if (projectScoped.kind === 'ref') return denied(requesterId);

    const project = await loadProjectAccessRow(supabaseAdmin, projectScoped.projectId);
    if (!project) return { allowed: false, status: 404, message: 'Image not found.' };
    // The path's namespace must belong to the project's owner, or a public project id could
    // be paired with someone else's files.
    if (project.user_id !== projectScoped.ownerId) return denied(requesterId);
    if (project.isStudioV4) return denied(requesterId);
    if (project.is_public && !project.is_forced_private) return { allowed: true };
    return denied(requesterId);
  }

  const tempScoped = parseTempPath(imagePath);
  if (tempScoped) {
    if (requesterId && requesterId === tempScoped.ownerId) return { allowed: true };
    // A tmp/ image can still be referenced by a published (public) project — allow any
    // viewer in that case, mirroring the legacy-path branch below. Without this, panel
    // images that fell back to the tmp lane 401/403 for everyone but the owner.
    if (await isPathReferencedByPublicProject(supabaseAdmin, tempScoped.ownerId, imagePath)) {
      return { allowed: true };
    }
    if (!requesterId) {
      return { allowed: false, status: 401, message: 'Authentication required for this image.' };
    }
    return { allowed: false, status: 403, message: 'Image access denied.' };
  }

  const legacyScoped = parseLegacyOwnerPath(imagePath);
  if (legacyScoped) {
    if (requesterId && requesterId === legacyScoped.ownerId) {
      return { allowed: true };
    }
    if (!requesterId) {
      return { allowed: false, status: 401, message: 'Authentication required for this image.' };
    }
    const referencedByPublicProject = await isPathReferencedByPublicProject(supabaseAdmin, legacyScoped.ownerId, imagePath);
    if (referencedByPublicProject) {
      return { allowed: true };
    }
    return { allowed: false, status: 403, message: 'Image access denied.' };
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
    const project = await loadProjectAccessRow(supabaseAdmin, String(asset.project_id));
    if (project?.user_id === requesterId) return { allowed: true };
    if (project && !project.isStudioV4 && project.is_public && !project.is_forced_private) return { allowed: true };
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

// Capability report for the admin dashboard: which providers/tools are OK,
// degraded, or unavailable (from real config), plus recent runtime capability
// gaps. Admin-only — it reveals which keys are configured (booleans, not values).
systemRouter.get('/capabilities', requireAuth, requireAdmin, (_req, res) => {
  res.json(capabilityReport());
});

// Consolidated admin dashboard: capabilities + live tool-API health + documented
// dependency limits (with live-metric connection status) + rate limits + version.
systemRouter.get('/dashboard', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const report = capabilityReport();
    const toolHealth = await pingTools();
    res.json({
      generatedAt: new Date().toISOString(),
      version: { appVersion: APP_VERSION, gitSha: GIT_SHA, buildTimestamp: BUILD_TIMESTAMP },
      capabilities: report.capabilities,
      recentNotices: report.recentNotices,
      toolHealth,
      dependencies: dependencyInfo(),
      rateLimits: rateLimitSummary()
    });
  } catch (err) {
    next(err);
  }
});

systemRouter.get('/version', (_req, res) => {
  res.json({
    appVersion: APP_VERSION,
    gitSha: GIT_SHA,
    buildTimestamp: BUILD_TIMESTAMP,
    worldExtractionContractVersion: WORLD_EXTRACTION_CONTRACT_VERSION
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
    let finalPath = imagePath;

    // Sign with a hard timeout. Without it, a slow/stalled Storage call holds the
    // connection until the platform gateway kills it (~30–60s) and surfaces an opaque
    // 504 — telemetry showed exactly that. Fail fast (~12s) with a clear, retryable
    // STORAGE_TIMEOUT instead, so the client can retry and the connection is released.
    const SIGN_TIMEOUT_MS = 12_000;
    // Each path signs from the bucket that holds it; private lanes for 5 minutes only.
    const ttlFor = (p: string) => (isPrivatePath(p) ? PRIVATE_SIGNED_URL_TTL_SECONDS : SIGNED_URL_TTL_SECONDS);
    const signUrl = async (p: string) => {
      try {
        return await Promise.race([
          supabaseAdmin.storage.from(bucketForPath(p)).createSignedUrl(p, ttlFor(p), transform ? { transform } : undefined),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error('Storage sign timed out'), { status: 504, publicCode: 'STORAGE_TIMEOUT' })), SIGN_TIMEOUT_MS)
          )
        ]);
      } catch (e) {
        return { data: null, error: e as { status?: number; statusCode?: number; message?: string } };
      }
    };

    let { data, error } = await signUrl(finalPath);

    if (error || !data?.signedUrl) {
      const fallbackPath = buildLegacyFallbackPath(imagePath);
      if (!fallbackPath) {
        // A 4xx from storage means the object can't be signed (missing/inaccessible)
        // — report that as 404, not the raw 400 Supabase returns. Only re-raise true
        // server-side failures so they surface as 500.
        if (error && Number((error as any).status ?? (error as any).statusCode) >= 500) throw error;
        return res.status(404).json({ error: { message: 'Image not found.' } });
      }

      finalPath = fallbackPath;
      const fallbackResult = await signUrl(finalPath);
      data = fallbackResult.data;
      error = fallbackResult.error;
    }

    if (error || !data?.signedUrl) {
      if (error && Number((error as any).status ?? (error as any).statusCode) >= 500) throw error;
      return res.status(404).json({ error: { message: 'Image not found.' } });
    }

    if (isPrivatePath(finalPath)) res.setHeader('Cache-Control', 'private, no-store');
    return res.json({
      url: data.signedUrl,
      path: finalPath,
      expiresIn: ttlFor(finalPath)
    });
  } catch (error) {
    const maybeError = error as { publicCode?: string; status?: number; message?: string };
    if (maybeError?.publicCode === 'STORAGE_TIMEOUT') {
      return res.status(504).json({
        error: { code: 'STORAGE_TIMEOUT', message: 'The image is taking too long to load right now. Please try again.' }
      });
    }
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
