// Shared plumbing for the safety module: injectable dependencies, small in-memory caches and
// counters (one backend instance, CLAUDE.md "Backend hosting"; the DB is the truth after a
// restart), event recording without content, strikes, and quarantine. Owner: P1-SAFETY.

import { createHash } from 'node:crypto';
import { COMIC_SAFETY_CLASSIFIER, COMIC_SAFETY_ENABLED } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { recordAudit, type AuditInput } from '../../observability/auditLog.js';
import { mapAssetRefs, type AssetRef, type ComicDoc } from '../../../../shared/comic/doc.js';
import { effectiveRating, type ContentRating, type SafetyCategory } from '../../../../shared/comic/safety.js';
import { createLlmClient } from '../llm.js';
import { platformStudioKeys } from '../keys.js';
import type { AssetStore, LlmClient, StudioContext, StudioSessionApi } from '../types.js';
import { createSupabaseSafetyStore, type SafetyEventInput, type SafetyStore } from './store.js';

export interface SafetyDeps {
  store: SafetyStore;
  /** The PLATFORM's LLM client (never the user's keys); null without a platform key. */
  platformLlm(): LlmClient | null;
  /** Asset store for flows without a StudioContext (reports, moderation). */
  assets(): Promise<AssetStore>;
  /** The live session of a project (owner-scoped), for moderator verdicts. null when it can't load. */
  liveSession(projectId: string, ownerUserId: string): Promise<StudioSessionApi | null>;
  /**
   * Take a held (suspended) comic's published copies down: the pub/<key>/ pages, cover and share
   * images stop answering direct bucket URLs. Best effort — callers catch and log; a failure never
   * undoes or blocks the hold. Production: publication/index.ts removePublicationObjects.
   */
  removePublicationObjects(projectId: string): Promise<void>;
  audit(input: AuditInput): Promise<void>;
  now(): number;
  enabled(): boolean;
  classifierOn(): boolean;
}

/**
 * What a log line may say about an error: its code/name/status only. Database messages can echo a
 * failing row ("Failing row contains (… note text …)"), so a message never reaches a safety log.
 */
export const errorFacts = (err: unknown): { code?: string; status?: number } => {
  const e = (err || {}) as { code?: unknown; name?: unknown; status?: unknown };
  const code = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : typeof e.name === 'string' ? e.name : undefined;
  return { ...(code ? { code: code.slice(0, 40) } : {}), ...(typeof e.status === 'number' ? { status: e.status } : {}) };
};

let lazyStore: SafetyStore | null = null;
let lazyLlm: { llm: LlmClient | null } | null = null;
let lazyAssets: AssetStore | null = null;

const defaults = (): SafetyDeps => ({
  get store() {
    if (!lazyStore) lazyStore = createSupabaseSafetyStore();
    return lazyStore;
  },
  platformLlm() {
    if (!lazyLlm) {
      const keys = platformStudioKeys();
      lazyLlm = { llm: keys ? createLlmClient(keys) : null };
    }
    return lazyLlm.llm;
  },
  async assets() {
    if (!lazyAssets) {
      const { createSupabaseAssetStore } = await import('../assets.js');
      lazyAssets = createSupabaseAssetStore();
    }
    return lazyAssets;
  },
  async liveSession(projectId, ownerUserId) {
    try {
      const [{ getStudioSession }, { createSupabaseDocStore }] = await Promise.all([import('../session.js'), import('../store.js')]);
      return await getStudioSession(projectId, ownerUserId, createSupabaseDocStore());
    } catch (err) {
      logger.warn('comic_safety_live_session_failed', { projectId, ...errorFacts(err) });
      return null;
    }
  },
  async removePublicationObjects(projectId) {
    // Lazy: the publication module pulls in sharp/Pango and imports this module's gate.
    const { removePublicationObjects } = await import('../publication/index.js');
    await removePublicationObjects(projectId);
  },
  audit: recordAudit,
  now: () => Date.now(),
  enabled: () => COMIC_SAFETY_ENABLED,
  classifierOn: () => COMIC_SAFETY_CLASSIFIER === 'on'
});

let current: SafetyDeps = defaults();

const DEP_KEYS = ['store', 'platformLlm', 'assets', 'liveSession', 'removePublicationObjects', 'audit', 'now', 'enabled', 'classifierOn'] as const;

/** Stands in for real Storage deletes whenever the store is swapped (see configureSafety). */
const keepPublicationObjects = async (): Promise<void> => undefined;

/**
 * Replace dependencies (tests, wiring). Caches are cleared so nothing leaks between setups.
 * Swapping the store without also passing `removePublicationObjects` makes the remover a no-op:
 * a fake (or foreign) store's holds must never drive deletes in the real public bucket.
 */
export function configureSafety(patch: Partial<SafetyDeps>): SafetyDeps {
  const base = current;
  const next = Object.create(null) as SafetyDeps;
  const swapsStoreOnly = patch.store !== undefined && patch.removePublicationObjects === undefined;
  for (const key of DEP_KEYS) {
    if (key in patch && patch[key] !== undefined) Object.defineProperty(next, key, { value: patch[key], enumerable: true });
    else if (key === 'removePublicationObjects' && swapsStoreOnly) Object.defineProperty(next, key, { value: keepPublicationObjects, enumerable: true });
    else Object.defineProperty(next, key, { get: () => base[key], enumerable: true });
  }
  current = next;
  clearSafetyCaches();
  return current;
}

/** Back to the production dependencies and empty caches. */
export function resetSafety(): void {
  current = defaults();
  lazyStore = null;
  lazyLlm = null;
  lazyAssets = null;
  clearSafetyCaches();
}

export const safetyDeps = (): SafetyDeps => current;

// ── Caches and counters ──────────────────────────────────────────────────────

interface Cached<T> {
  value: T;
  at: number;
}
const MAX_CACHE = 5_000;

export class TtlCache<T> {
  private map = new Map<string, Cached<T>>();
  constructor(private ttlMs: number) {}
  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (current.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // LRU touch.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key: string, value: T): void {
    this.map.delete(key);
    this.map.set(key, { value, at: current.now() });
    while (this.map.size > MAX_CACHE) this.map.delete(this.map.keys().next().value as string);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

/** user_moderation_status (60 s). */
export const statusCache = new TtlCache<'active' | 'restricted' | 'suspended'>(60_000);
/** Account-age ceiling (10 min). */
export const ceilingCache = new TtlCache<ContentRating>(10 * 60_000);
/** Strike cooldown (60 s). */
export const cooldownCache = new TtlCache<{ until: number } | null>(60_000);
/** comic_blocked_hashes (5 min). */
export const hashCache = new TtlCache<{ hash: string; kind: 'dhash' | 'sha256' }[]>(5 * 60_000);

const windows = new Map<string, number[]>();
/** Sliding-window counter: true (and counted) when under `max` in `windowMs`. */
export const takeSlot = (key: string, max: number, windowMs: number): boolean => {
  const now = current.now();
  const list = (windows.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    windows.set(key, list);
    return false;
  }
  list.push(now);
  windows.set(key, list);
  if (windows.size > MAX_CACHE) windows.delete(windows.keys().next().value as string);
  return true;
};

export function clearSafetyCaches(): void {
  statusCache.clear();
  ceilingCache.clear();
  cooldownCache.clear();
  hashCache.clear();
  windows.clear();
}

/** A user's moderation status changed elsewhere (moderation route): drop the cached value. */
export const invalidateModerationCache = (userId: string): void => {
  statusCache.delete(userId);
  cooldownCache.delete(userId);
};

/** Classifier spend caps (safety.md §8): 60 text / 30 image checks per user per hour. */
export const CAPS = { textPerHour: 60, imagePerHour: 30, appealsPerDay: 5, reportChecksPerProjectDay: 20 } as const;

// ── Ratings ──────────────────────────────────────────────────────────────────

/** The effective rating of a context (the route resolved the account ceiling) or of the doc alone. */
export const ratingOf = (ctx: Pick<StudioContext, 'rating' | 'caps' | 'session'>, doc?: ComicDoc): ContentRating =>
  ctx.rating ?? effectiveRating(doc ?? ctx.session.doc, ctx.caps?.ratingCeiling).rating;

// ── Events (no content, ever) ────────────────────────────────────────────────

export interface DecisionRecord extends SafetyEventInput {
  /** Platform cost to record in generation_cost_events (billable 0). */
  operation?: string;
}

/**
 * Record one decision: a comic_safety_events row (categories, a one-way hash, cost), a log line
 * with ids and codes only, the platform cost, and strike consequences. Never throws.
 */
export async function recordDecision(e: DecisionRecord): Promise<void> {
  const deps = current;
  logger.info('comic_safety_decision', {
    projectId: e.projectId ?? null,
    surface: e.surface,
    layer: e.layer,
    decision: e.decision,
    categories: e.categories,
    effective: e.effective ?? null,
    assessed: e.assessed ?? null,
    severity: e.severity,
    costUsd: e.costUsd ?? 0
  });
  try {
    await deps.store.recordEvent(e);
    if (e.userId && (e.costUsd ?? 0) > 0) {
      await deps.store.recordPlatformCost({ userId: e.userId, projectId: e.projectId, operation: e.operation || `comic.safety.${e.surface}`, model: e.model, costUsd: e.costUsd as number });
    }
    if (e.userId && e.severity > 0) await onStrike(e.userId, e.projectId ?? null, e.categories, e.severity);
  } catch (err) {
    logger.warn('comic_safety_record_failed', { surface: e.surface, ...errorFacts(err) });
  }
}

const autoCaseDay = new Set<string>();

/** Strike consequences (safety.md §8): severe → restricted + a moderator case; 6 points in 7 days → a case. */
async function onStrike(userId: string, projectId: string | null, categories: SafetyCategory[], severity: number): Promise<void> {
  const deps = current;
  cooldownCache.delete(userId);
  const day = new Date(deps.now()).toISOString().slice(0, 10);
  const openAuto = async (reason: string) => {
    const key = `${userId}:${day}:${reason}`;
    if (autoCaseDay.has(key) || !projectId) return;
    autoCaseDay.add(key);
    if (autoCaseDay.size > MAX_CACHE) autoCaseDay.clear();
    await deps.store.openCase({ kind: 'auto', projectId, ownerUserId: userId, target: {}, reason });
  };
  if (severity >= 3) {
    await deps.store.restrictUser(userId, 'auto: content safety');
    statusCache.delete(userId);
    await openAuto(`severe: ${categories.join(', ') || 'content'}`);
    return;
  }
  const strikes = await deps.store.strikes(userId, deps.now() - 7 * DAY);
  if (strikes.reduce((s, x) => s + x.severity, 0) >= 6) await openAuto('repeated blocks (6 points in 7 days)');
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Strike cooldown from recorded events: 3 points in 24 h → 15 min; 6 points in 7 days → 24 h. */
export const cooldownFromStrikes = (strikes: { severity: number; at: number }[], now: number): { until: number } | null => {
  const recent = strikes.filter((s) => s.severity > 0 && now - s.at < 7 * DAY);
  if (!recent.length) return null;
  const last = Math.max(...recent.map((s) => s.at));
  const week = recent.reduce((s, x) => s + x.severity, 0);
  const day = recent.filter((s) => now - s.at < DAY).reduce((s, x) => s + x.severity, 0);
  let until = 0;
  if (week >= 6) until = last + DAY;
  else if (day >= 3) until = last + 15 * MINUTE;
  return until > now ? { until } : null;
};

// ── Hashes ───────────────────────────────────────────────────────────────────

/** Hamming distance between two 16-hex dHashes (64 bits); Infinity when malformed. */
export const hamming = (a: string, b: string): number => {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return Number.POSITIVE_INFINITY;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
};

export const DHASH_MATCH = 6;

/** Is this image on the denylist (dHash within 6 bits, or an exact sha256)? */
export async function isBlockedHash(dhash: string | undefined, sha?: string): Promise<boolean> {
  if (!dhash && !sha) return false;
  let list = hashCache.get('all');
  if (!list) {
    list = await current.store.blockedHashes().catch(() => []);
    hashCache.set('all', list);
  }
  return list.some((h) => (h.kind === 'dhash' && dhash ? hamming(h.hash, dhash) <= DHASH_MATCH : h.kind === 'sha256' && !!sha && h.hash === sha));
}

export async function addBlockedHash(dhash: string | undefined, category: SafetyCategory): Promise<void> {
  if (!dhash || !/^[0-9a-f]{16}$/i.test(dhash)) return;
  await current.store.addBlockedHash(dhash.toLowerCase(), 'dhash', category).catch(() => undefined);
  hashCache.delete('all');
}

export const sha256Hex = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

// ── Assets ───────────────────────────────────────────────────────────────────

/** The AssetRef with this path anywhere in the doc (current, history, archive, trash, refs, attachments). */
export const findAssetByPath = (doc: ComicDoc, path: string): AssetRef | undefined => {
  let found: AssetRef | undefined;
  mapAssetRefs(doc, (a) => {
    if (!found && a.path === path) found = a;
    return a;
  });
  return found;
};

/**
 * Move an object to the private quarantine lane and remember where it went (moderators and
 * appeals need it). Returns the quarantine path, or null when the move failed (the asset is
 * still never signed: a blocked verdict hides it either way).
 */
export async function quarantineAsset(
  assets: AssetStore,
  args: { path: string; projectId?: string | null; userId?: string | null; categories: SafetyCategory[] }
): Promise<string | null> {
  try {
    const existing = await current.store.quarantineFor(args.path).catch(() => null);
    if (existing) return existing;
    const { quarantinePath } = await assets.quarantine(args.path, `blocked:${args.categories.join(',') || 'content'}`);
    await current.store.recordQuarantine({ path: args.path, quarantinePath, projectId: args.projectId, userId: args.userId, reason: `blocked:${args.categories.join(',')}` });
    return quarantinePath;
  } catch (err) {
    logger.warn('comic_safety_quarantine_failed', { projectId: args.projectId ?? null, ...errorFacts(err) });
    return null;
  }
}

/**
 * An AssetStore that can move a quarantined object back. The production store has it
 * (assets.ts restoreQuarantined: q/ source only, back to its own original path, copy then delete,
 * idempotent); it stays optional on the AssetStore type, so test fakes may leave it out.
 */
type RestoreCapable = AssetStore & { restoreQuarantined?(quarantinePath: string, originalPath: string): Promise<void> };

/**
 * Put a quarantined object back at its original path (an appeal cleared it, or a moderator
 * restored it) through AssetStore.restoreQuarantined. Only a store without it (a test fake) falls
 * back to copyObject — production never takes that branch, and its copyObject refuses q/ sources
 * anyway. false = the object is still held — the caller must say so honestly and never mark the
 * image as servable.
 */
export async function restoreFromQuarantine(assets: AssetStore, quarantinePath: string, originalPath: string, projectId?: string | null): Promise<boolean> {
  try {
    const store = assets as RestoreCapable;
    if (typeof store.restoreQuarantined === 'function') await store.restoreQuarantined(quarantinePath, originalPath);
    else await assets.copyObject(quarantinePath, originalPath);
    await current.store.forgetQuarantine(originalPath).catch(() => undefined);
    return true;
  } catch (err) {
    logger.warn('comic_safety_restore_failed', { projectId: projectId ?? null, ...errorFacts(err) });
    return false;
  }
}

/** Sniff an image buffer's MIME for a data URL (previews are WebP; tolerate PNG/JPEG/GIF). */
export const imageMime = (buf: Buffer): string | null => {
  if (!buf || buf.length < 12) return null;
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('ascii') === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  return null;
};
