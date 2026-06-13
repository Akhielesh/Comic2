import { Project, GenerationArtifact, ComicPanel, Character, Item, Location, StyleVariant, ProjectReport, LearnProgress, ReaderState, UserProfile, UserPrivateProfile, AccountProfile, Comment, Follow, AppNotification, Review } from "../types";
import { buildProjectReport } from "./reporting";
import { supabase } from "./supabase";
import { ImageTransformPreset, sanitizeProjectForStorage } from "./projectStorage";
import { isMissingPrivateProfileTableError } from "./profilePrivate";
import { buildApiUrl } from "./clientConfig";

// --- Local Storage (IndexedDB) for Ephemeral Data (Tests, Learning, UI State) ---
const DB_NAME = "dreamstream_local_cache"; // Renamed to avoid confusion, though we can keep same name if we migrated data.
const DB_VERSION = 3;

const TEST_RUNS_STORE = "test_runs";
const TEST_IMAGES_STORE = "test_images";
const LEARN_PROGRESS_STORE = "learn_progress";
const READER_STATE_STORE = "reader_state";
const IMAGE_FETCH_METRIC_WINDOW = 200;
const imageFetchSamplesMs: number[] = [];
const IMAGE_URL_CACHE_TTL_MS = 15 * 60 * 1000;
const SIGNED_IMAGE_URL_TIMEOUT_MS = 8000;
const SIGNED_IMAGE_URL_MAX_ATTEMPTS = 2; // initial try + one retry on a transient failure
const SIGNED_IMAGE_URL_RETRY_DELAY_MS = 250;
const imageUrlCache = new Map<string, { url: string; expiresAt: number }>();

// (Keeping IndexedDB logic for these specific stores)
const openDb = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TEST_RUNS_STORE)) {
        const store = db.createObjectStore(TEST_RUNS_STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(TEST_IMAGES_STORE)) {
        db.createObjectStore(TEST_IMAGES_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(LEARN_PROGRESS_STORE)) {
        db.createObjectStore(LEARN_PROGRESS_STORE, { keyPath: "moduleId" });
      }
      if (!db.objectStoreNames.contains(READER_STATE_STORE)) {
        db.createObjectStore(READER_STATE_STORE, { keyPath: "projectId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const runTransaction = async <T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = fn(store);
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || request.error);
  });
};

const loadStoreAll = async <T>(storeName: string): Promise<T[]> => {
  return runTransaction<T[]>(storeName, "readonly", (store) => store.getAll());
};

// --- Helper Utils ---

const dataUrlToBlob = (dataUrl: string): Blob => {
  const [meta, base64] = dataUrl.split(",");
  const mimeMatch = meta.match(/data:(.*?);base64/);
  const mimeType = mimeMatch?.[1] || "image/png";
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};

const parseDataUrl = (dataUrl: string) => {
  const [meta] = dataUrl.split(",");
  const mimeMatch = meta.match(/data:(.*?);base64/);
  return { mimeType: mimeMatch?.[1] || "image/png" };
};

const buildImagePathCandidates = (imagePath: string): string[] => {
  const trimmed = imagePath.trim();
  if (!trimmed) return [];
  const filename = trimmed.split('/').pop() || '';
  const candidates: string[] = [];
  if (!filename.includes('.')) {
    // Try the durable forms before the legacy tmp/ guesses. tmp/ is the ephemeral
    // lane and almost never where a referenced image actually lives, so probing it
    // first produced 400s for objects that don't exist and only delayed resolving
    // the real path.
    candidates.push(`${trimmed}.webp`, `${trimmed}.png`, `${trimmed}.jpg`, `${trimmed}.jpeg`, trimmed);
    const legacyMatch = trimmed.match(/^([0-9a-f-]{36})\/([^/]+)$/i);
    if (legacyMatch) {
      candidates.push(
        `u/${legacyMatch[1]}/tmp/${legacyMatch[2]}.webp`,
        `u/${legacyMatch[1]}/tmp/${legacyMatch[2]}.png`,
        `u/${legacyMatch[1]}/tmp/${legacyMatch[2]}.jpg`,
        `u/${legacyMatch[1]}/tmp/${legacyMatch[2]}.jpeg`
      );
    }
  } else {
    candidates.push(trimmed);
    const legacyMatch = trimmed.match(/^([0-9a-f-]{36})\/([^/]+)$/i);
    if (legacyMatch) {
      candidates.push(`u/${legacyMatch[1]}/tmp/${legacyMatch[2]}`);
    }
  }
  return Array.from(new Set(candidates));
};

const buildImageCacheKey = (path: string, options?: { transform?: ImageTransformPreset }) => {
  const transform = options?.transform;
  const transformKey = transform
    ? [transform.width || '', transform.height || '', transform.quality || '', transform.format || ''].join(':')
    : 'origin';
  return `${path}::${transformKey}`;
};

const readCachedImageUrl = (cacheKey: string): string | undefined => {
  const cached = imageUrlCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    imageUrlCache.delete(cacheKey);
    return undefined;
  }
  return cached.url;
};

const writeCachedImageUrl = (cacheKey: string, url: string) => {
  imageUrlCache.set(cacheKey, {
    url,
    expiresAt: Date.now() + IMAGE_URL_CACHE_TTL_MS
  });
};

const toTransformQuery = (transform?: ImageTransformPreset): string => {
  if (!transform) return '';
  const params = new URLSearchParams();
  if (typeof transform.width === 'number' && Number.isFinite(transform.width)) {
    params.set('w', String(Math.max(1, Math.floor(transform.width))));
  }
  if (typeof transform.height === 'number' && Number.isFinite(transform.height)) {
    params.set('h', String(Math.max(1, Math.floor(transform.height))));
  }
  if (typeof transform.quality === 'number' && Number.isFinite(transform.quality)) {
    params.set('q', String(Math.max(1, Math.floor(transform.quality))));
  }
  if (transform.format) {
    params.set('f', transform.format);
  }
  return params.toString();
};

const fetchSignedImageUrlFromApi = async (
  imagePath: string,
  options?: { transform?: ImageTransformPreset }
): Promise<string | undefined> => {
  if (typeof window === 'undefined') return undefined;

  const query = new URLSearchParams();
  query.set('path', imagePath);
  const transformQuery = toTransformQuery(options?.transform);
  if (transformQuery) {
    const parsed = new URLSearchParams(transformQuery);
    parsed.forEach((value, key) => query.set(key, value));
  }

  // One signing attempt. Returns the URL on success, otherwise a `retryable` flag:
  // network/timeout/5xx/429 are transient and worth one retry, while 4xx (auth,
  // not-found) and malformed payloads will not improve on a second try.
  const attempt = async (): Promise<{ url?: string; retryable: boolean; reason: string }> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), SIGNED_IMAGE_URL_TIMEOUT_MS);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(buildApiUrl(`/api/system/image-url?${query.toString()}`), {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        signal: controller.signal
      });
      if (!response.ok) {
        return { retryable: response.status >= 500 || response.status === 429, reason: `http ${response.status}` };
      }
      const payload = await response.json().catch(() => null) as { url?: unknown } | null;
      if (!payload || typeof payload.url !== 'string' || !payload.url.trim()) {
        return { retryable: false, reason: 'empty payload' };
      }
      return { url: payload.url.trim(), retryable: false, reason: 'ok' };
    } catch (error) {
      return { retryable: true, reason: error instanceof Error ? error.name : 'network error' };
    } finally {
      window.clearTimeout(timeout);
    }
  };

  let lastReason = 'unknown';
  let lastRetryable = false;
  for (let i = 0; i < SIGNED_IMAGE_URL_MAX_ATTEMPTS; i++) {
    const result = await attempt();
    if (result.url) return result.url;
    lastReason = result.reason;
    lastRetryable = result.retryable;
    if (!result.retryable) break;
    if (i < SIGNED_IMAGE_URL_MAX_ATTEMPTS - 1) {
      await new Promise((resolve) => window.setTimeout(resolve, SIGNED_IMAGE_URL_RETRY_DELAY_MS));
    }
  }

  // This used to fail silently — images just vanished with no diagnostic. The caller
  // still falls back to a public URL, but surface transient/outage failures so a flaky
  // backend or expired session is visible. Stay quiet on deterministic 4xx, which is the
  // expected "not signable here, use the public URL" path and would otherwise spam.
  if (lastRetryable) {
    console.warn(`[db] Signed image URL unavailable for ${imagePath} after ${SIGNED_IMAGE_URL_MAX_ATTEMPTS} attempts (${lastReason}).`);
  }
  return undefined;
};


type ProjectRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  published_at?: string | null;
  cover_image_url?: string;
  state: Project['state'];
  is_public?: boolean;
  user_id?: string;
  likes?: number;
  views?: number;
  likes_count?: number;
  views_count?: number;
  profiles?: { username?: string } | null;
};

type CommentRow = {
  id: string;
  project_id: string;
  user_id: string;
  text: string;
  created_at: string;
  updated_at?: string;
  user?: { username?: string; avatar_url?: string } | null;
};

type ProjectWithStats = Project & { userId?: string; likes?: number; views?: number };
type ProfilePreview = { username?: string; avatar_url?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeTimestamp = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const fallbackUsernameFromId = (userId?: string): string => {
  if (!userId) return 'Unknown creator';
  return `user-${userId.slice(0, 8)}`;
};

const readPublishedAtFromState = (state: Project['state']): number | undefined => {
  if (!isRecord(state)) return undefined;
  return normalizeTimestamp(state.publishedAt);
};

const resolvePublishedAt = (row: ProjectRow): number | undefined =>
  normalizeTimestamp(row.published_at)
  ?? readPublishedAtFromState(row.state)
  ?? (row.is_public ? normalizeTimestamp(row.created_at) : undefined);

const fetchProfileMapByIds = async (userIds: Array<string | undefined>): Promise<Map<string, ProfilePreview>> => {
  const ids = Array.from(
    new Set(
      userIds
        .filter((userId): userId is string => typeof userId === 'string' && userId.trim().length > 0)
    )
  );

  if (ids.length === 0) return new Map();

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_url')
    .in('id', ids);

  if (error) {
    console.warn('Failed to load profile usernames for user IDs.', error);
    return new Map();
  }

  const map = new Map<string, ProfilePreview>();
  for (const row of data || []) {
    if (!isRecord(row) || typeof row.id !== 'string') continue;
    const username = typeof row.username === 'string' && row.username.trim()
      ? row.username.trim()
      : undefined;
    const avatar_url = typeof row.avatar_url === 'string' && row.avatar_url.trim()
      ? row.avatar_url.trim()
      : undefined;
    map.set(row.id, { username, avatar_url });
  }
  return map;
};

const isProjectRow = (value: unknown): value is ProjectRow => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string' &&
    'state' in value
  );
};

const mapProjectRow = (row: ProjectRow, profileMap?: Map<string, ProfilePreview>): Project => {
  const profile = row.user_id ? profileMap?.get(row.user_id) : undefined;
  const authorName = row.profiles?.username || profile?.username || fallbackUsernameFromId(row.user_id);
  return {
    id: row.id,
    name: row.name,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    coverImage: row.cover_image_url,
    state: row.state,
    isPublic: row.is_public,
    userId: row.user_id,
    authorName,
    publishedAt: resolvePublishedAt(row),
    likesCount: row.likes_count ?? row.likes ?? 0,
    viewsCount: row.views_count ?? row.views ?? 0
  };
};

const isCommentRow = (value: unknown): value is CommentRow => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.project_id === 'string' &&
    typeof value.user_id === 'string' &&
    typeof value.text === 'string' &&
    typeof value.created_at === 'string'
  );
};

const mapCommentRow = (row: CommentRow, profileMap?: Map<string, ProfilePreview>): Comment => {
  const profile = row.user ?? (row.user_id ? profileMap?.get(row.user_id) : undefined);
  return {
    id: row.id,
    project_id: row.project_id,
    user_id: row.user_id,
    text: row.text,
    created_at: row.created_at,
    updated_at: row.updated_at,
    user: {
      username: profile?.username || fallbackUsernameFromId(row.user_id),
      avatar_url: profile?.avatar_url
    }
  };
};


// --- CLOUD STORAGE (Supabase) for Projects, Images, Artifacts ---

// 1. Projects
// --- Local Storage Key ---
const LOCAL_PROJECT_LIKES_KEY = 'dreamstream_project_likes';
const LOCAL_NOTIFICATIONS_KEY = 'dreamstream_local_notifications';
let projectLikesTableUnavailable = false;

const getLocalProjectLikeKey = (userId?: string) => `${LOCAL_PROJECT_LIKES_KEY}:${userId || 'anon'}`;

const getLocalLikedProjects = (userId?: string): Set<string> => {
  try {
    const raw = localStorage.getItem(getLocalProjectLikeKey(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id) => typeof id === 'string'));
  } catch {
    return new Set();
  }
};

const setLocalLikedProjects = (likes: Set<string>, userId?: string) => {
  try {
    localStorage.setItem(getLocalProjectLikeKey(userId), JSON.stringify(Array.from(likes)));
  } catch {
    // ignore
  }
};

const getLocalNotificationsRaw = (): AppNotification[] => {
  try {
    const raw = localStorage.getItem(LOCAL_NOTIFICATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord).map((item) => ({
      id: String(item.id || crypto.randomUUID()),
      user_id: String(item.user_id || ''),
      actor_id: item.actor_id ? String(item.actor_id) : undefined,
      type: (
        item.type === 'generation'
          ? 'generation'
          : item.type === 'follow'
            ? 'follow'
            : item.type === 'comment'
              ? 'comment'
              : item.type === 'system'
                ? 'system'
                : 'like'
      ),
      entity_id: item.entity_id ? String(item.entity_id) : undefined,
      is_read: Boolean(item.is_read),
      created_at: typeof item.created_at === 'string' ? item.created_at : new Date().toISOString(),
      title: typeof item.title === 'string' ? item.title : undefined,
      message: typeof item.message === 'string' ? item.message : undefined,
      actor: isRecord(item.actor) ? {
        username: typeof item.actor.username === 'string' ? item.actor.username : 'System',
        avatar_url: typeof item.actor.avatar_url === 'string' ? item.actor.avatar_url : undefined
      } : undefined
    }));
  } catch {
    return [];
  }
};

const setLocalNotificationsRaw = (items: AppNotification[]) => {
  try {
    localStorage.setItem(LOCAL_NOTIFICATIONS_KEY, JSON.stringify(items));
  } catch {
    // ignore
  }
};

const isProjectLikesMissingError = (error: unknown): boolean => {
  if (!isRecord(error)) return false;
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  const details = typeof error.details === 'string' ? error.details.toLowerCase() : '';
  const code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
  return (
    message.includes('project_likes') ||
    details.includes('project_likes') ||
    code === '42p01' ||
    message.includes('relation') && message.includes('does not exist')
  );
};

// Throttle the project_state_bytes metric so it doesn't spam the console on every save (saves
// fire on every generation tick). Only log the first time, or when the size changes meaningfully.
const lastStateBytesLogged = new Map<string, number>();

// 1. Projects
export const saveProject = async (project: Project): Promise<void> => {
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // Auth-first mode: do not persist projects without a signed-in user.
    return;
  }

  const sanitized = sanitizeProjectForStorage(project);
  const { id, name, coverImage, state, createdAt, updatedAt, isPublic, publishedAt } = sanitized;
  const effectivePublishedAt =
    normalizeTimestamp(publishedAt)
    ?? readPublishedAtFromState(state)
    ?? (isPublic ? Date.now() : undefined);
  const stateWithPublishMeta = effectivePublishedAt ? { ...state, publishedAt: effectivePublishedAt } : state;
  const stateBytes = new Blob([JSON.stringify(stateWithPublishMeta)]).size;
  const prevBytes = lastStateBytesLogged.get(id);
  if (prevBytes === undefined || Math.abs(stateBytes - prevBytes) >= 4096) {
    lastStateBytesLogged.set(id, stateBytes);
    // Dev-only: this fired on every save in production and drowned the console.
    if (import.meta.env.DEV) console.info("[METRICS] project_state_bytes", { projectId: id, bytes: stateBytes });
  }

  const { error } = await supabase.from('projects').upsert({
    id,
    user_id: user.id,
    name,
    cover_image_url: coverImage,
    is_public: !!isPublic,
    state: stateWithPublishMeta, // JSONB
    updated_at: new Date(updatedAt).toISOString(),
    created_at: new Date(createdAt).toISOString()
  });

  if (error) throw error;
};

export const deleteProject = async (projectId: string): Promise<void> => {
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // Auth-first mode: nothing to delete while signed out.
    return;
  }

  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('id', projectId)
    .eq('user_id', user.id);
  if (error) throw error;
};

export const loadProjects = async (): Promise<Project[]> => {
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // Auth-first mode: dashboard data is user-owned and stored in Supabase.
    return [];
  }

  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false });

  if (error) throw error;

  const rows = (data || []).filter(isProjectRow);
  const profileMap = await fetchProfileMapByIds(rows.map((row) => row.user_id));
  return rows.map((row) => mapProjectRow(row, profileMap));
};

export const reloadProjects = async (): Promise<Project[]> => {
  return loadProjects();
};

const hydratePublicProjectForRead = async (project: Project): Promise<Project> => {
  const [coverImageUrl, panels] = await Promise.all([
    project.state.coverImageId
      ? getImageUrl(project.state.coverImageId)
      : Promise.resolve(project.state.coverImageUrl),
    Promise.all(project.state.panels.map(async (panel) => {
      const imageUrl = panel.imageId ? await getImageUrl(panel.imageId) : panel.imageUrl;
      const imageUrlHistory = panel.imageIdHistory
        ? await Promise.all(panel.imageIdHistory.map((id) => getImageUrl(id)))
        : panel.imageUrlHistory;
      return { ...panel, imageUrl, imageUrlHistory };
    }))
  ]);

  return {
    ...project,
    state: {
      ...project.state,
      coverImageUrl,
      panels
    }
  };
};

export const getPublicProject = async (projectId: string): Promise<Project | null> => {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .eq('is_public', true) // Security check
    .single();

  if (error || !data) return null;

  if (!isProjectRow(data)) return null;
  const profileMap = await fetchProfileMapByIds([data.user_id]);
  return hydratePublicProjectForRead(mapProjectRow(data, profileMap));
};

export type PlanTier = 'free' | 'creator' | 'pro' | 'studio' | 'custom' | 'admin';

export interface UsageLimits {
  images_generated_count: number;
  max_images_allowed: number;
  has_byok: boolean;
  is_premium: boolean; // Computed or legacy
  plan_tier: PlanTier;
  available_ct?: number;
  daily_remaining_ct?: number;
  daily_guardrail_ct?: number;
}

export const getUsageLimits = async (): Promise<UsageLimits | null> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const fallback: UsageLimits = {
    images_generated_count: 0,
    max_images_allowed: 30,
    has_byok: false,
    is_premium: false,
    plan_tier: 'free',
    available_ct: 0,
    daily_remaining_ct: 0,
    daily_guardrail_ct: 0
  };

  const { data: walletData } = await supabase
    .from('token_wallets')
    .select('plan_tier, included_monthly_ct, used_monthly_ct, purchased_ct, reserved_ct, daily_guardrail_ct, used_daily_ct')
    .eq('user_id', user.id)
    .maybeSingle();

  if (walletData) {
    const rawTier = typeof walletData.plan_tier === 'string' ? walletData.plan_tier.toLowerCase() : 'free';
    const plan_tier: PlanTier =
      rawTier === 'creator' || rawTier === 'pro' || rawTier === 'studio' || rawTier === 'custom' || rawTier === 'admin'
        ? rawTier
        : 'free';
    const included = typeof walletData.included_monthly_ct === 'number' ? walletData.included_monthly_ct : 0;
    const used = typeof walletData.used_monthly_ct === 'number' ? walletData.used_monthly_ct : 0;
    const purchased = typeof walletData.purchased_ct === 'number' ? walletData.purchased_ct : 0;
    const reserved = typeof walletData.reserved_ct === 'number' ? walletData.reserved_ct : 0;
    const dailyGuardrail = typeof walletData.daily_guardrail_ct === 'number' ? walletData.daily_guardrail_ct : 0;
    const dailyUsed = typeof walletData.used_daily_ct === 'number' ? walletData.used_daily_ct : 0;

    return {
      images_generated_count: 0,
      max_images_allowed: 30,
      has_byok: false,
      is_premium: plan_tier === 'pro' || plan_tier === 'studio' || plan_tier === 'admin',
      plan_tier,
      available_ct: Math.max(0, included - used + purchased - reserved),
      daily_guardrail_ct: Math.max(0, dailyGuardrail),
      daily_remaining_ct: Math.max(0, dailyGuardrail - dailyUsed)
    };
  }

  const { data, error } = await supabase
    .from('usage_limits')
    .select('images_generated_count, max_images_allowed, has_byok, is_premium, plan_tier')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !data) return fallback;

  const rawTier = typeof data.plan_tier === 'string' ? data.plan_tier.toLowerCase() : 'free';
  const plan_tier: PlanTier =
    rawTier === 'creator' || rawTier === 'pro' || rawTier === 'studio' || rawTier === 'custom' || rawTier === 'admin'
      ? rawTier
      : (data.is_premium ? 'pro' : 'free');

  return {
    images_generated_count: typeof data.images_generated_count === 'number' ? data.images_generated_count : 0,
    max_images_allowed: typeof data.max_images_allowed === 'number' ? data.max_images_allowed : 30,
    has_byok: data.has_byok === true,
    is_premium: data.is_premium === true,
    plan_tier
  };
};

export const generateCoupon = async (): Promise<string | null> => {
  console.warn('[db] generateCoupon is deprecated. Use /api/billing/admin/coupons.');
  return null;
};

export const redeemCoupon = async (code: string): Promise<{ success: boolean; message: string }> => {
  console.warn('[db] redeemCoupon via direct RPC is deprecated. Use /api/billing/coupons/redeem.', code);
  return { success: false, message: 'Legacy coupon redemption is disabled.' };
};

export const loadCoupons = async (): Promise<any[]> => {
  console.warn('[db] loadCoupons is deprecated. Use /api/billing/admin/coupons.');
  return [];
};

export const incrementViewCount = async (projectId: string) => {
  await supabase.rpc('increment_project_view', { p_id: projectId });
};

export const incrementLikeCount = async (projectId: string) => {
  await supabase.rpc('increment_project_like', { p_id: projectId });
};

const decrementLikeCount = async (projectId: string) => {
  await supabase.rpc('decrement_project_like', { p_id: projectId });
};

export const getProjectLikeMap = async (projectIds: string[]): Promise<Record<string, boolean>> => {
  if (!projectIds.length) return {};
  const { data: { user } } = await supabase.auth.getUser();
  const emptyMap = projectIds.reduce<Record<string, boolean>>((acc, projectId) => {
    acc[projectId] = false;
    return acc;
  }, {});
  const fallbackSet = getLocalLikedProjects(user?.id);
  const fallbackMap = projectIds.reduce<Record<string, boolean>>((acc, projectId) => {
    acc[projectId] = fallbackSet.has(projectId);
    return acc;
  }, {});

  if (!user) return emptyMap;
  if (projectLikesTableUnavailable) return fallbackMap;

  const { data, error } = await supabase
    .from('project_likes')
    .select('project_id')
    .eq('user_id', user.id)
    .in('project_id', projectIds);

  if (error) {
    if (isProjectLikesMissingError(error)) {
      projectLikesTableUnavailable = true;
    }
    return fallbackMap;
  }

  const likedSet = new Set(
    (data || [])
      .filter(isRecord)
      .map((row) => row.project_id)
      .filter((id): id is string => typeof id === 'string')
  );

  return projectIds.reduce<Record<string, boolean>>((acc, projectId) => {
    acc[projectId] = likedSet.has(projectId);
    return acc;
  }, {});
};

export const toggleProjectLike = async (projectId: string, ownerUserId?: string): Promise<{ liked: boolean; persisted: boolean }> => {
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { liked: false, persisted: false };
  }

  const localLikes = getLocalLikedProjects(user.id);
  if (projectLikesTableUnavailable) {
    if (localLikes.has(projectId)) {
      localLikes.delete(projectId);
      setLocalLikedProjects(localLikes, user.id);
      await decrementLikeCount(projectId).catch(() => null);
      return { liked: false, persisted: false };
    }
    localLikes.add(projectId);
    setLocalLikedProjects(localLikes, user.id);
    await incrementLikeCount(projectId).catch(() => null);
    if (ownerUserId && ownerUserId !== user.id) {
      await createNotification(ownerUserId, user.id, 'like', projectId);
    }
    return { liked: true, persisted: false };
  }
  const { data: existing, error: selectError } = await supabase
    .from('project_likes')
    .select('id')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (selectError) {
    if (isProjectLikesMissingError(selectError)) {
      projectLikesTableUnavailable = true;
    }
    if (localLikes.has(projectId)) {
      localLikes.delete(projectId);
      setLocalLikedProjects(localLikes, user.id);
      await decrementLikeCount(projectId).catch(() => null);
      return { liked: false, persisted: false };
    }
    localLikes.add(projectId);
    setLocalLikedProjects(localLikes, user.id);
    await incrementLikeCount(projectId).catch(() => null);
    if (ownerUserId && ownerUserId !== user.id) {
      await createNotification(ownerUserId, user.id, 'like', projectId);
    }
    return { liked: true, persisted: false };
  }

  if (existing?.id) {
    const { error } = await supabase
      .from('project_likes')
      .delete()
      .eq('project_id', projectId)
      .eq('user_id', user.id);

    if (error) {
      return { liked: true, persisted: true };
    }

    localLikes.delete(projectId);
    setLocalLikedProjects(localLikes, user.id);
    await decrementLikeCount(projectId).catch(() => null);
    return { liked: false, persisted: true };
  }

  const { error } = await supabase
    .from('project_likes')
    .insert({ project_id: projectId, user_id: user.id });

  if (error) {
    if (localLikes.has(projectId)) {
      return { liked: true, persisted: false };
    }
    localLikes.add(projectId);
    setLocalLikedProjects(localLikes, user.id);
    await incrementLikeCount(projectId).catch(() => null);
    if (ownerUserId && ownerUserId !== user.id) {
      await createNotification(ownerUserId, user.id, 'like', projectId);
    }
    return { liked: true, persisted: false };
  }

  localLikes.add(projectId);
  setLocalLikedProjects(localLikes, user.id);
  await incrementLikeCount(projectId).catch(() => null);
  if (ownerUserId && ownerUserId !== user.id) {
    await createNotification(ownerUserId, user.id, 'like', projectId);
  }
  return { liked: true, persisted: true };
};

// 2. Images (Cloud Storage)

const BUCKET_NAME = 'comic-assets';

export const saveImage = async (dataUrl: string): Promise<string> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("User not logged in");

  const id = crypto.randomUUID();
  const blob = dataUrlToBlob(dataUrl);
  const ext = blob.type.split('/')[1] || 'png';
  const filePath = `u/${user.id}/tmp/${id}.${ext}`;

  console.log('[DB] saveImage uploading to:', filePath);
  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(filePath, blob, {
      upsert: false,
      contentType: blob.type,
      cacheControl: "31536000"
    });

  if (error) {
    console.error('[DB] saveImage error:', error);
    // If bucket doesn't exist, this fails.
    if (error.message.includes("Bucket not found")) {
      throw new Error("Storage bucket 'comic-assets' not found. Please create it in Supabase Dashboard.");
    }
    throw error;
  }

  // Best-effort metadata write if image_assets migration exists.
  const { error: metadataError } = await supabase.rpc("register_image_asset", {
    p_path: filePath,
    p_bucket: BUCKET_NAME,
    p_mime_type: blob.type,
    p_bytes: blob.size,
    p_source: "upload",
    p_project_id: null
  });
  if (metadataError) {
    console.warn("[DB] register_image_asset RPC unavailable or failed", metadataError.message);
  }

  return filePath;
};

export const getImageUrl = async (
  imageId: string,
  options?: { transform?: ImageTransformPreset }
): Promise<string | undefined> => {
  if (!imageId) return undefined;

  const candidatePaths = buildImagePathCandidates(imageId);
  for (const candidate of candidatePaths) {
    const cacheKey = buildImageCacheKey(candidate, options);
    const cachedUrl = readCachedImageUrl(cacheKey);
    if (cachedUrl) return cachedUrl;

    const signedUrl = await fetchSignedImageUrlFromApi(candidate, options);
    if (signedUrl) {
      writeCachedImageUrl(cacheKey, signedUrl);
      return signedUrl;
    }
  }

  // Last resort only after every candidate failed to sign. getPublicUrl() builds a
  // URL string without checking existence, so doing it per-candidate (as before)
  // returned a URL to the first — often non-existent — candidate and skipped later
  // ones that are actually valid. Fall back to the primary candidate's public URL.
  const primaryCandidate = candidatePaths[0];
  if (primaryCandidate) {
    const { data } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(primaryCandidate, options?.transform ? { transform: options.transform as any } : undefined);
    if (data?.publicUrl) {
      writeCachedImageUrl(buildImageCacheKey(primaryCandidate, options), data.publicUrl);
      return data.publicUrl;
    }
  }

  return undefined;
};

export const getImageDataUrl = async (imageId: string): Promise<string | undefined> => {
  if (!imageId) return undefined;

  // 1. Try Test Images Store first (Local Blob)
  const testRecord = await runTransaction<any>(TEST_IMAGES_STORE, "readonly", (store) => store.get(imageId));
  if (testRecord && testRecord.dataUrl) {
    return testRecord.dataUrl;
  }

  // 2. Try Supabase Storage (Cloud)
  // Logic: Fetch the blob from the public URL and convert to Base64
  const url = await getImageUrl(imageId);
  if (!url) return undefined;

  try {
    const fetchStart = performance.now();
    const response = await fetch(url);
    const blob = await response.blob();
    const fetchMs = Math.round(performance.now() - fetchStart);
    imageFetchSamplesMs.push(fetchMs);
    if (imageFetchSamplesMs.length > IMAGE_FETCH_METRIC_WINDOW) {
      imageFetchSamplesMs.splice(0, imageFetchSamplesMs.length - IMAGE_FETCH_METRIC_WINDOW);
    }
    const sorted = [...imageFetchSamplesMs].sort((a, b) => a - b);
    const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    const p95 = sorted[p95Index] || fetchMs;
    // Dev-only: per-image logging was pure console noise in production.
    if (import.meta.env.DEV) console.info("[METRICS] image_fetch_ms_p95", { p95, samples: sorted.length });
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn("Failed to fetch image data for gemini", e);
    return undefined;
  }
};

// 3. Artifacts

export const saveArtifact = async (artifact: GenerationArtifact): Promise<void> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return; // Silent fail if not logged in?

  // Artifact has `projectId`.
  await supabase.from('artifacts').insert({
    user_id: user.id,
    project_id: artifact.projectId,
    data: artifact, // Store the whole JSON object
    created_at: new Date().toISOString()
  });
};

export const loadArtifactsForProject = async (projectId: string): Promise<GenerationArtifact[]> => {
  const { data } = await supabase
    .from('artifacts')
    .select('data')
    .eq('project_id', projectId);

  return (data || []).map((row: any) => row.data);
};


// --- Legacy / Ephemeral Implementation (IndexedDB) ---
// Inline "test" images back the storage === 'test' generation mode (samples that are
// kept local instead of being persisted to cloud storage) — they are NOT a test suite.
export const saveTestImage = async (dataUrl: string): Promise<string> => {
  const id = crypto.randomUUID();
  const { mimeType } = parseDataUrl(dataUrl);
  const record = { id, dataUrl, mimeType, createdAt: Date.now() };
  await runTransaction(TEST_IMAGES_STORE, "readwrite", (store) => store.put(record));
  return id;
};

export const getTestImageUrl = async (imageId: string): Promise<string | undefined> => {
  const record = await runTransaction<any>(TEST_IMAGES_STORE, "readonly", (store) => store.get(imageId));
  if (!record) return undefined;
  return URL.createObjectURL(dataUrlToBlob(record.dataUrl));
};

export const saveLearnProgress = async (progress: LearnProgress): Promise<void> => {
  await runTransaction(LEARN_PROGRESS_STORE, "readwrite", (store) => store.put(progress));
};

export const loadLearnProgress = async (): Promise<LearnProgress[]> => {
  return loadStoreAll<LearnProgress>(LEARN_PROGRESS_STORE);
};

export const saveReaderState = async (state: ReaderState): Promise<void> => {
  await runTransaction(READER_STATE_STORE, "readwrite", (store) => store.put(state));
};

export const loadReaderState = async (projectId: string): Promise<ReaderState | undefined> => {
  return runTransaction<ReaderState | undefined>(
    READER_STATE_STORE,
    "readonly",
    (store) => store.get(projectId)
  );
};


// Stats are harder now (part cloud, part local).
// Simplified for MVP:
export const getDbStats = async (): Promise<{
  projects: number;
  images: number; // This is hard to count on storage without list call
  artifacts: number;
  testRuns?: number;
  testImages?: number;
  storage?: { usage: number; quota: number };
}> => {
  // Local stats
  const testRuns = await runTransaction(TEST_RUNS_STORE, "readonly", s => s.count());

  // Remote stats (Optional, might be slow)
  const { count: projects } = await supabase.from('projects').select('*', { count: 'exact', head: true });
  const { count: artifacts } = await supabase.from('artifacts').select('*', { count: 'exact', head: true });

  return {
    projects: projects || 0,
    images: 0, // Placeholder
    artifacts: artifacts || 0,
    testRuns: testRuns || 0,
    testImages: 0,
    storage: { usage: 0, quota: 0 }
  };
};

export const clearImageCache = () => {
  // No-op for cloud URLs usually, or revoke if we used objectURLs for test images
};

// --- Migration Utils ---

export const migrateLegacyData = async (): Promise<{ projects: number; errors: number }> => {
  const LEGACY_DB_NAME = "dreamstream_db"; // The old name before we switched to SaaS
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be logged in to migrate.");

  let migratedCount = 0;
  let errorCount = 0;

  try {
    // Open Legacy DB
    const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(LEGACY_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (!legacyDb.objectStoreNames.contains("projects")) {
      console.warn("No projects store found in legacy DB.");
      return { projects: 0, errors: 0 };
    }

    // Read all projects
    const tx = legacyDb.transaction("projects", "readonly");
    const store = tx.objectStore("projects");
    const request = store.getAll();

    const projects = await new Promise<Project[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    console.log(`Found ${projects.length} legacy projects to migrate.`);

    // Upload to Supabase
    for (const p of projects) {
      try {
        await saveProject(p);
        migratedCount++;
      } catch (err) {
        console.error(`Failed to migrate project ${p.id}:`, err);
        errorCount++;
      }
    }

    // Try to migrate artifacts if they exist
    // (Assuming they were stored in 'artifacts' or we just rely on loading them later? 
    // Actually artifacts were likely in proper store or sub-collection. 
    // If we skip them, projects might verify empty. 
    // Let's check for 'artifacts' store.)
    if (legacyDb.objectStoreNames.contains("artifacts")) {
      const aTx = legacyDb.transaction("artifacts", "readonly");
      const aStore = aTx.objectStore("artifacts");
      const aRequest = aStore.getAll();
      const artifacts = await new Promise<GenerationArtifact[]>((resolve) => {
        aRequest.onsuccess = () => resolve(aRequest.result);
        aRequest.onerror = () => resolve([]);
      });

      for (const a of artifacts) {
        try {
          await saveArtifact(a);
        } catch {
          // ignore artifact dupes
        }
      }
    }

    legacyDb.close();

  } catch (e) {
    console.error("Migration failed:", e);
    throw e;
  }

  return { projects: migratedCount, errors: errorCount };
};

// Stub for exportProject (Needs rewrite for cloud)
export const exportProject = async (projectId: string): Promise<any> => {
  try {
    const { data: project, error } = await supabase.from('projects').select('*').eq('id', projectId).single();
    if (error || !project) throw new Error("Project not found");

    const artifacts = await loadArtifactsForProject(projectId);

    // For MVP, we don't download all images to blob yet, but we return structure so UI doesn't crash.
    return { project, images: {}, artifacts };
  } catch (e) {
    console.error("Export failed:", e);
    return { project: undefined, images: {}, artifacts: [] };
  }
};

// --- USER PROFILES ---

export const getUserProfile = async (userId: string): Promise<UserProfile | null> => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) return null;
  return data as UserProfile;
};

export const getPrivateProfile = async (userId: string): Promise<UserPrivateProfile | null> => {
  const { data, error } = await supabase
    .from('profile_private')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    if (isMissingPrivateProfileTableError(error)) return null;
    throw error;
  }
  return data as UserPrivateProfile | null;
};

export const upsertPrivateProfile = async (
  userId: string,
  updates: Partial<Omit<UserPrivateProfile, 'id' | 'created_at' | 'updated_at'>>
) => {
  const payload = { id: userId, ...updates };
  const { error } = await supabase
    .from('profile_private')
    .upsert(payload, { onConflict: 'id' });

  if (error) throw error;
};

export const getAccountProfile = async (userId: string): Promise<AccountProfile> => {
  const [publicProfile, privateProfile] = await Promise.all([
    getUserProfile(userId),
    getPrivateProfile(userId)
  ]);

  return { publicProfile, privateProfile };
};

export const updateUserProfile = async (userId: string, updates: Partial<UserProfile>) => {
  const { error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', userId);

  if (error) throw error;
};

export const updateUserAvatar = async (userId: string, avatarUrl: string) => {
  return updateUserProfile(userId, { avatar_url: avatarUrl });
};

export const syncMarketingConsentLegacy = async (userId: string, marketingEnabled: boolean) => {
  const { error } = await supabase
    .from('profiles')
    .update({ marketing_consent: marketingEnabled })
    .eq('id', userId);

  if (error) throw error;
};

// --- CONTACT FORM ---
// --- CONTACT FORM ---
export const savePublicContactMessage = async (email: string, message: string) => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const normalizedEmail = typeof email === 'string' ? email.trim() : '';
  const normalizedMessage = typeof message === 'string' ? message.trim() : '';
  if (!normalizedEmail || !normalizedMessage) return false;

  const { error } = await supabase.from('contact_messages').insert({
    user_id: user.id,
    email: normalizedEmail,
    message: normalizedMessage
  });

  if (error) {
    console.error("Failed to save contact message", error);
    return false;
  }
  return true;
};
// --- COMMUNITY FEATURES (Phase 11) ---

export const addComment = async (projectId: string, text: string): Promise<Comment | null> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // 1. Fetch Project to get Owner
  const { data: project } = await supabase.from('projects').select('user_id').eq('id', projectId).single();

  const { data, error } = await supabase
    .from('comments')
    .insert({ project_id: projectId, user_id: user.id, text })
    .select('*')
    .single();

  if (error) {
    console.error("Failed to add comment:", error);
    return null;
  }

  // 2. Notify Project Owner
  if (project && project.user_id !== user.id) {
    await createNotification(project.user_id, user.id, 'comment', projectId);
  }

  if (!isCommentRow(data)) return null;
  const profileMap = await fetchProfileMapByIds([data.user_id]);
  return mapCommentRow(data, profileMap);
};

export const getComments = async (projectId: string, currentUserId?: string): Promise<Comment[]> => {
  const { data, error } = await supabase
    .from('comments')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error("Failed to load comments:", error);
    return [];
  }

  const rows = (data || []).filter(isCommentRow);
  const profileMap = await fetchProfileMapByIds(rows.map((row) => row.user_id));
  let validComments = rows.map((row) => mapCommentRow(row, profileMap));

  // Fetch likes for current user if provided
  if (currentUserId && validComments.length > 0) {
    const commentIds = validComments.map((c) => c.id);
    const { data: likes } = await supabase
      .from('comment_likes')
      .select('comment_id')
      .eq('user_id', currentUserId)
      .in('comment_id', commentIds);

    const likedSet = new Set((likes || []).filter(isRecord).map((l) => l.comment_id).filter((id): id is string => typeof id === 'string'));
    validComments = validComments.map((c) => ({
      ...c,
      isLiked: likedSet.has(c.id)
    }));
  }

  return validComments;
};

export const deleteComment = async (commentId: string): Promise<boolean> => {
  const { error } = await supabase.from('comments').delete().eq('id', commentId);
  return !error;
};

export const updateComment = async (commentId: string, text: string): Promise<Comment | null> => {
  const { data, error } = await supabase
    .from('comments')
    .update({ text })
    .eq('id', commentId)
    .select('*')
    .single();

  if (error) {
    console.error("Failed to update comment:", error);
    return null;
  }

  if (!isCommentRow(data)) return null;
  const profileMap = await fetchProfileMapByIds([data.user_id]);
  return mapCommentRow(data, profileMap);
};

export const followUser = async (targetUserId: string): Promise<boolean> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { error } = await supabase
    .from('follows')
    .insert({ follower_id: user.id, following_id: targetUserId });

  if (error) return false;

  await createNotification(targetUserId, user.id, 'follow');
  return true;
};

export const unfollowUser = async (targetUserId: string): Promise<boolean> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { error } = await supabase
    .from('follows')
    .delete()
    .eq('follower_id', user.id)
    .eq('following_id', targetUserId);

  return !error;
};

export const isFollowing = async (targetUserId: string): Promise<boolean> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { data, error } = await supabase
    .from('follows')
    .select('*')
    .eq('follower_id', user.id)
    .eq('following_id', targetUserId)
    .single();

  return !!data && !error;
};

export const getFollowersCount = async (userId: string): Promise<number> => {
  const { count, error } = await supabase
    .from('follows')
    .select('*', { count: 'exact', head: true })
    .eq('following_id', userId);

  return count || 0;
};
export const getProfileByUsername = async (username: string): Promise<UserProfile | null> => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('username', username) // Case insensitive lookup
    .single();

  if (error) return null;
  return data as UserProfile;
};

export const getPublicProjectsByUser = async (userId: string): Promise<Project[]> => {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('user_id', userId)
    .eq('is_public', true)
    .order('created_at', { ascending: false });

  if (error) return [];

  const rows = (data || []).filter(isProjectRow);
  const profileMap = await fetchProfileMapByIds(rows.map((row) => row.user_id));
  return rows.map((row): Project => {
    const project: ProjectWithStats = {
      ...mapProjectRow(row, profileMap),
      userId: row.user_id,
      likes: row.likes_count ?? row.likes ?? 0,
      views: row.views_count ?? row.views ?? 0
    };
    return project;
  });
};

// --- Notifications ---

export const getNotifications = async (userId: string): Promise<AppNotification[]> => {
  const { data, error } = await supabase
    .from('notifications')
    .select(`
      *,
      actor:actor_id (username, avatar_url)
    `)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  const cloud = error ? [] : (data || []) as AppNotification[];
  const local = getLocalNotificationsRaw().filter((notification) => notification.user_id === userId);
  return [...cloud, ...local].sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
};

export const markNotificationRead = async (notificationId: string) => {
  if (notificationId.startsWith('local:')) {
    const current = getLocalNotificationsRaw();
    const next = current.map((item) =>
      item.id === notificationId ? { ...item, is_read: true } : item
    );
    setLocalNotificationsRaw(next);
    return;
  }

  await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notificationId);
};

export const markAllNotificationsRead = async (userId: string) => {
  await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('is_read', false);

  const local = getLocalNotificationsRaw();
  const next = local.map((item) =>
    item.user_id === userId ? { ...item, is_read: true } : item
  );
  setLocalNotificationsRaw(next);
};

export const createNotification = async (
  userId: string,
  actorId: string,
  type: 'follow' | 'comment' | 'like' | 'system',
  entityId?: string
) => {
  if (userId === actorId) return; // Don't notify self
  await supabase.from('notifications').insert({
    user_id: userId,
    actor_id: actorId,
    type,
    entity_id: entityId
  });
};

export const createSystemNotification = async (
  message: string,
  context?: { projectId?: string; stage?: string }
) => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const current = getLocalNotificationsRaw();
  const duplicate = current.find((item) =>
    item.user_id === user.id &&
    item.type === 'system' &&
    item.message === message &&
    (Date.now() - new Date(item.created_at).getTime()) < 30_000
  );
  if (duplicate) return;

  const next: AppNotification = {
    id: `local:${crypto.randomUUID()}`,
    user_id: user.id,
    type: 'system',
    entity_id: context?.projectId,
    is_read: false,
    created_at: new Date().toISOString(),
    title: 'Auto Fallback Applied',
    message
  };
  setLocalNotificationsRaw([next, ...current].slice(0, 50));
};

export const createGenerationNotification = async (projectId: string, projectName: string) => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const current = getLocalNotificationsRaw();
  const recentDuplicate = current.find(
    (item) =>
      item.user_id === user.id &&
      item.type === 'generation' &&
      item.entity_id === projectId &&
      (Date.now() - new Date(item.created_at).getTime()) < 30_000
  );
  if (recentDuplicate) return;

  const notification: AppNotification = {
    id: `local:${crypto.randomUUID()}`,
    user_id: user.id,
    type: 'generation',
    entity_id: projectId,
    is_read: false,
    created_at: new Date().toISOString(),
    title: 'Comic Generation Complete',
    message: `"${projectName}" is ready to read.`
  };

  setLocalNotificationsRaw([notification, ...current].slice(0, 50));
};

// --- Comment Likes ---

export const likeComment = async (commentId: string, userId: string): Promise<boolean> => {
  const { error } = await supabase
    .from('comment_likes')
    .insert({ comment_id: commentId, user_id: userId });

  return !error;
};

export const unlikeComment = async (commentId: string, userId: string): Promise<boolean> => {
  const { error } = await supabase
    .from('comment_likes')
    .delete()
    .eq('comment_id', commentId)
    .eq('user_id', userId);

  return !error;
};

export const getCommentLikes = async (commentIds: string[], userId?: string): Promise<Record<string, { count: number, hasLiked: boolean }>> => {
  // This is a bit complex efficiently. For now, we might just load it client side or assume small scale.
  // Better: Fetch all likes for these comments.

  // 1. Get counts
  const { data: counts } = await supabase
    .from('comment_likes')
    .select('comment_id');
  // .in('comment_id', commentIds) -> fetching all for these comments to count? noisy.

  // Actually, let's just use the `comments` view or similar if we had one.
  // For MVP, simplistic approach: 
  return {}; // Placeholder if we do individual fetching
};
// --- REVIEWS ---

export const submitReview = async (review: Omit<Review, 'id' | 'userId' | 'createdAt' | 'user'>): Promise<boolean> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { error } = await supabase.from('reviews').insert({
    project_id: review.projectId,
    user_id: user.id,
    rating: review.rating,
    scores: review.scores, // JSONB
    text: review.text
  });

  if (error) {
    console.error("Failed to submit review:", error);
    return false;
  }
  return true;
};

export const getReviews = async (projectId: string): Promise<Review[]> => {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error("Failed to load reviews:", error);
    return [];
  }

  const rows = (data || []).filter(isRecord);
  const profileMap = await fetchProfileMapByIds(
    rows.map((row) => (typeof row.user_id === 'string' ? row.user_id : undefined))
  );

  return rows
    .filter((row) =>
      typeof row.id === 'string' &&
      typeof row.project_id === 'string' &&
      typeof row.user_id === 'string' &&
      typeof row.created_at === 'string' &&
      typeof row.text === 'string'
    )
    .map((row) => {
      const profile = profileMap.get(row.user_id as string);
      const numericRating = typeof row.rating === 'number'
        ? row.rating
        : Number(row.rating);
      return {
        id: row.id as string,
        projectId: row.project_id as string,
        userId: row.user_id as string,
        rating: Number.isFinite(numericRating) ? numericRating : 0,
        scores: row.scores as Review['scores'],
        text: row.text as string,
        createdAt: new Date(row.created_at as string).getTime(),
        user: {
          username: profile?.username || fallbackUsernameFromId(row.user_id as string),
          avatar_url: profile?.avatar_url
        }
      };
    });
};
