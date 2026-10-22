// Safety persistence (server/sql/comic_safety.sql). Owner: P1-SAFETY.
//
// Service-role only: every table is RLS-on with no client policies. Rows carry categories,
// decisions, a one-way hash and costs — NEVER the text or image that was screened.
// Nothing here throws into a user flow except where the caller must fail closed
// (accountDob: a failed lookup must never lift the age ceiling).

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../../services/supabase.js';
import { logger } from '../../lib/logger.js';
import type { AssessedRating, ContentRating, SafetyCategory } from '../../../../shared/comic/safety.js';
import type { ComicDoc, RenderTarget } from '../../../../shared/comic/doc.js';

export type SafetySurface = 'message' | 'script' | 'file' | 'upload' | 'patch' | 'render' | 'publish' | 'report' | 'import' | 'appeal';
export type SafetyLayer = 'prefilter' | 'classifier' | 'vision_qc' | 'vision_check' | 'provider' | 'hash' | 'admin' | 'second_opinion' | 'classifier_unavailable';
export type SafetyDecision = 'allow' | 'adapt' | 'block' | 'withhold' | 'restore';
export type ModerationStatus = 'active' | 'restricted' | 'suspended';
export type CaseKind = 'report' | 'appeal' | 'auto';
export type CaseStatus = 'open' | 'auto_cleared' | 'resolved' | 'dismissed';

export interface SafetyEventInput {
  userId?: string | null;
  projectId?: string | null;
  surface: SafetySurface;
  layer: SafetyLayer;
  decision: SafetyDecision;
  categories: SafetyCategory[];
  effective?: ContentRating;
  assessed?: AssessedRating;
  severity: 0 | 1 | 3;
  /** sha256 (text) or dHash (image) — never content. */
  contentHash?: string;
  model?: string;
  costUsd?: number;
}

export interface CaseTarget {
  /** Live render target (when known). */
  target?: RenderTarget;
  /** The asset path the case is about (live doc or a pub/ copy). */
  path?: string;
  /** Where the object lives now when it was quarantined. */
  quarantinePath?: string;
  /** 1-based page number a reader reported. */
  page?: number;
  pageId?: string;
  publicationId?: string;
  /** The safety check run when the case opened (no notes, categories only). */
  check?: { assessed?: AssessedRating; categories?: SafetyCategory[]; by?: string };
}

export interface SafetyCase {
  id: string;
  kind: CaseKind;
  projectId: string;
  ownerUserId?: string | null;
  reporterId?: string | null;
  reporterFingerprint?: string | null;
  target: CaseTarget;
  reason: string;
  note?: string | null;
  status: CaseStatus;
  resolution?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: number | null;
  createdAt: number;
}

export interface OpenCaseInput {
  kind: CaseKind;
  projectId: string;
  ownerUserId?: string | null;
  reporterId?: string | null;
  reporterFingerprint?: string | null;
  target: CaseTarget;
  reason: string;
  note?: string | null;
  status?: CaseStatus;
}

export interface PublicationRef {
  publicationId: string;
  projectId: string;
  ownerUserId: string;
  status: 'live' | 'unpublished' | 'suspended';
  snapshot: ComicDoc | null;
}

export interface SafetyStore {
  /** False when Supabase isn't configured (dev/tests): reads answer defaults, writes are no-ops. */
  readonly configured: boolean;
  recordEvent(e: SafetyEventInput): Promise<void>;
  /** generation_cost_events row, billable 0 (the platform pays). */
  recordPlatformCost(c: { userId: string; projectId?: string | null; operation: string; model?: string; costUsd: number }): Promise<void>;
  /** Severity > 0 events since `sinceMs` (strikes). */
  strikes(userId: string, sinceMs: number): Promise<{ severity: number; at: number }[]>;
  moderationStatus(userId: string): Promise<ModerationStatus>;
  /** active → restricted (never touches a suspended account). */
  restrictUser(userId: string, reason: string): Promise<void>;
  /** profile_private.dob ('YYYY-MM-DD'); null when unknown. THROWS on a database error. */
  accountDob(userId: string): Promise<string | null>;
  blockedHashes(): Promise<{ hash: string; kind: 'dhash' | 'sha256' }[]>;
  addBlockedHash(hash: string, kind: 'dhash' | 'sha256', category: SafetyCategory): Promise<void>;
  /** Insert a case; a duplicate report (same reporter, comic, target, day) is `deduped`. */
  openCase(c: OpenCaseInput): Promise<{ id: string | null; deduped: boolean }>;
  listCases(filter: { status?: 'open' | 'resolved'; kind?: CaseKind; limit?: number; offset?: number }): Promise<SafetyCase[]>;
  getCase(id: string): Promise<SafetyCase | null>;
  updateCase(id: string, patch: { status: CaseStatus; resolution?: string; resolvedBy?: string | null; target?: CaseTarget }): Promise<void>;
  /** Reports on a project since `sinceMs` (auto-hold counting). */
  reportsSince(projectId: string, sinceMs: number): Promise<{ reporterId?: string | null; fingerprint?: string | null; reason: string }[]>;
  /** Appeals by this owner since `sinceMs`. */
  appealsSince(userId: string, sinceMs: number): Promise<number>;
  /** Open case counts per project (moderation queue). */
  openCaseCounts(limit: number): Promise<Record<string, number>>;
  publicationBySlug(slug: string): Promise<PublicationRef | null>;
  publicationByProject(projectId: string): Promise<PublicationRef | null>;
  projectInfo(projectId: string): Promise<{ ownerUserId: string; name?: string; isForcedPrivate: boolean } | null>;
  forcePrivate(projectId: string, reason: string, actorId: string | null): Promise<void>;
  /** Lift an AUTOMATIC hold (forced_private_reason 'auto: …'); a moderator's own pause stays. true = lifted. */
  liftAutoHold(projectId: string): Promise<boolean>;
  moderationAction(row: { projectId: string; ownerUserId?: string | null; action: string; reason?: string | null; actedBy?: string | null; metadata?: Record<string, unknown> }): Promise<void>;
  recordQuarantine(row: { path: string; quarantinePath: string; projectId?: string | null; userId?: string | null; reason: string }): Promise<void>;
  quarantineFor(path: string): Promise<string | null>;
  forgetQuarantine(path: string): Promise<void>;
  /** In-app notification to a user (best-effort). */
  notify(n: { userId: string; actorId?: string | null; entityId?: string; title: string; message: string; metadata?: Record<string, unknown> }): Promise<void>;
}

const ms = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) || 0 : 0);
const iso = (t: number) => new Date(t).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v?: string | null) => (v && UUID.test(v) ? v : null);

const toCase = (r: Record<string, unknown>): SafetyCase => ({
  id: String(r.id || ''),
  kind: r.kind as CaseKind,
  projectId: String(r.project_id || ''),
  ownerUserId: (r.owner_user_id as string) || null,
  reporterId: (r.reporter_id as string) || null,
  reporterFingerprint: (r.reporter_fingerprint as string) || null,
  target: (r.target && typeof r.target === 'object' ? r.target : {}) as CaseTarget,
  reason: String(r.reason || ''),
  note: typeof r.note === 'string' ? r.note : null,
  status: r.status as CaseStatus,
  resolution: typeof r.resolution === 'string' ? r.resolution : null,
  resolvedBy: (r.resolved_by as string) || null,
  resolvedAt: r.resolved_at ? ms(r.resolved_at) : null,
  createdAt: ms(r.created_at)
});

const toPublication = (r: Record<string, unknown> | null): PublicationRef | null =>
  r
    ? {
        publicationId: String(r.id || ''),
        projectId: String(r.project_id || ''),
        ownerUserId: String(r.user_id || ''),
        status: (r.status as PublicationRef['status']) || 'unpublished',
        snapshot: (r.snapshot && typeof r.snapshot === 'object' ? r.snapshot : null) as ComicDoc | null
      }
    : null;

/** The Supabase store. `db` is injectable for tests; absent ⇒ the service-role client (or unconfigured). */
export function createSupabaseSafetyStore(opts: { db?: () => SupabaseClient } = {}): SafetyStore {
  const admin = (): SupabaseClient | null => {
    try {
      return (opts.db || getSupabaseAdmin)();
    } catch {
      return null;
    }
  };
  const configured = !!admin();
  // Code only: a database message can echo the failing row (a report note, for instance).
  const warn = (what: string, err: unknown) => {
    const e = (err || {}) as { code?: unknown };
    logger.warn('comic_safety_store_failed', { what, ...(typeof e.code === 'string' ? { code: e.code.slice(0, 40) } : {}) });
  };

  return {
    configured,

    async recordEvent(e) {
      const db = admin();
      if (!db) return;
      const row = {
        user_id: uuidOrNull(e.userId),
        project_id: uuidOrNull(e.projectId),
        surface: e.surface,
        layer: e.layer,
        decision: e.decision,
        categories: e.categories,
        effective_rating: e.effective ?? null,
        assessed: e.assessed ?? null,
        severity: e.severity,
        // The column only takes a 16–64 hex fingerprint; anything else is dropped, never stored.
        content_hash: typeof e.contentHash === 'string' && /^[0-9a-f]{16,64}$/i.test(e.contentHash) ? e.contentHash.toLowerCase() : null,
        model: e.model ? String(e.model).slice(0, 120) : null,
        cost_usd: Math.max(0, Number(e.costUsd) || 0)
      };
      const { error } = await db.from('comic_safety_events').insert(row);
      if (error) warn('recordEvent', error);
    },

    async recordPlatformCost(c) {
      const db = admin();
      const userId = uuidOrNull(c.userId);
      if (!db || !userId || !(c.costUsd > 0)) return;
      const { error } = await db.from('generation_cost_events').insert({
        user_id: userId,
        project_id: c.projectId ?? null,
        comic_id: c.projectId ?? null,
        operation: c.operation,
        stage: 'safety',
        provider: 'platform',
        model: c.model || 'unknown',
        provider_cost_usd: c.costUsd,
        billable_usd: 0,
        is_byok: false,
        status: 'SETTLED',
        metadata: { platformPaid: true }
      });
      if (error) warn('recordPlatformCost', error);
    },

    async strikes(userId, sinceMs) {
      const db = admin();
      if (!db || !uuidOrNull(userId)) return [];
      const { data, error } = await db
        .from('comic_safety_events')
        .select('severity, created_at')
        .eq('user_id', userId)
        .gt('severity', 0)
        .gte('created_at', iso(sinceMs))
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) {
        warn('strikes', error);
        return [];
      }
      return (data || []).map((r) => ({ severity: Number((r as Record<string, unknown>).severity) || 0, at: ms((r as Record<string, unknown>).created_at) }));
    },

    async moderationStatus(userId) {
      const db = admin();
      if (!db || !uuidOrNull(userId)) return 'active';
      const { data, error } = await db.from('user_moderation_status').select('status').eq('user_id', userId).maybeSingle();
      if (error) throw error;
      const status = (data as { status?: string } | null)?.status;
      return status === 'restricted' || status === 'suspended' ? status : 'active';
    },

    async restrictUser(userId, reason) {
      const db = admin();
      if (!db || !uuidOrNull(userId)) return;
      const { data } = await db.from('user_moderation_status').select('status').eq('user_id', userId).maybeSingle();
      if ((data as { status?: string } | null)?.status === 'suspended') return;
      const { error } = await db
        .from('user_moderation_status')
        .upsert({ user_id: userId, status: 'restricted', reason, updated_by: null, updated_at: iso(Date.now()) }, { onConflict: 'user_id' });
      if (error) warn('restrictUser', error);
    },

    async accountDob(userId) {
      const db = admin();
      if (!db || !uuidOrNull(userId)) return null;
      const { data, error } = await db.from('profile_private').select('dob').eq('id', userId).maybeSingle();
      if (error) throw error;
      const dob = (data as { dob?: string | null } | null)?.dob;
      return typeof dob === 'string' && dob ? dob : null;
    },

    async blockedHashes() {
      const db = admin();
      if (!db) return [];
      const { data, error } = await db.from('comic_blocked_hashes').select('hash, kind').limit(5000);
      if (error) {
        warn('blockedHashes', error);
        return [];
      }
      return (data || []) as { hash: string; kind: 'dhash' | 'sha256' }[];
    },

    async addBlockedHash(hash, kind, category) {
      const db = admin();
      if (!db) return;
      const { error } = await db.from('comic_blocked_hashes').upsert({ hash, kind, category }, { onConflict: 'hash', ignoreDuplicates: true });
      if (error) warn('addBlockedHash', error);
    },

    async openCase(c) {
      const db = admin();
      if (!db) return { id: null, deduped: false };
      const { data, error } = await db
        .from('comic_safety_cases')
        .insert({
          kind: c.kind,
          project_id: c.projectId,
          owner_user_id: uuidOrNull(c.ownerUserId),
          reporter_id: uuidOrNull(c.reporterId),
          reporter_fingerprint: c.reporterFingerprint ?? null,
          target: c.target || {},
          // The column checks 1–200 characters (an auto case lists categories).
          reason: String(c.reason || 'flagged').slice(0, 200),
          note: c.note ? String(c.note).slice(0, 300) : null,
          status: c.status || 'open'
        })
        .select('id')
        .maybeSingle();
      if (error) {
        if (String((error as { code?: string }).code) === '23505') return { id: null, deduped: true };
        warn('openCase', error);
        return { id: null, deduped: false };
      }
      return { id: (data as { id?: string } | null)?.id ?? null, deduped: false };
    },

    async listCases(filter) {
      const db = admin();
      if (!db) return [];
      const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
      const offset = Math.max(0, filter.offset ?? 0);
      let q = db.from('comic_safety_cases').select('*');
      if (filter.status === 'open') q = q.eq('status', 'open');
      else if (filter.status === 'resolved') q = q.neq('status', 'open');
      if (filter.kind) q = q.eq('kind', filter.kind);
      const { data, error } = await q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
      if (error) throw error;
      return (data || []).map((r) => toCase(r as Record<string, unknown>));
    },

    async getCase(id) {
      const db = admin();
      if (!db || !uuidOrNull(id)) return null;
      const { data, error } = await db.from('comic_safety_cases').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data ? toCase(data as Record<string, unknown>) : null;
    },

    async updateCase(id, patch) {
      const db = admin();
      if (!db) return;
      const row: Record<string, unknown> = { status: patch.status };
      if (patch.resolution !== undefined) row.resolution = String(patch.resolution).slice(0, 500);
      if (patch.status !== 'open') {
        row.resolved_by = uuidOrNull(patch.resolvedBy ?? null);
        row.resolved_at = iso(Date.now());
      }
      if (patch.target) row.target = patch.target;
      const { error } = await db.from('comic_safety_cases').update(row).eq('id', id);
      if (error) throw error;
    },

    async reportsSince(projectId, sinceMs) {
      const db = admin();
      if (!db) return [];
      const { data, error } = await db
        .from('comic_safety_cases')
        .select('reporter_id, reporter_fingerprint, reason')
        .eq('project_id', projectId)
        .eq('kind', 'report')
        .gte('created_at', iso(sinceMs))
        .limit(500);
      if (error) {
        warn('reportsSince', error);
        return [];
      }
      return (data || []).map((r) => {
        const row = r as Record<string, unknown>;
        return { reporterId: (row.reporter_id as string) || null, fingerprint: (row.reporter_fingerprint as string) || null, reason: String(row.reason || '') };
      });
    },

    async appealsSince(userId, sinceMs) {
      const db = admin();
      if (!db || !uuidOrNull(userId)) return 0;
      const { count, error } = await db
        .from('comic_safety_cases')
        .select('id', { count: 'exact', head: true })
        .eq('owner_user_id', userId)
        .eq('kind', 'appeal')
        .gte('created_at', iso(sinceMs));
      if (error) {
        warn('appealsSince', error);
        return 0;
      }
      return count || 0;
    },

    async openCaseCounts(limit) {
      const db = admin();
      if (!db) return {};
      const { data, error } = await db.from('comic_safety_cases').select('project_id').eq('status', 'open').order('created_at', { ascending: false }).limit(Math.max(1, Math.min(1000, limit)));
      if (error) {
        warn('openCaseCounts', error);
        return {};
      }
      const out: Record<string, number> = {};
      for (const r of data || []) {
        const id = String((r as Record<string, unknown>).project_id || '');
        if (id) out[id] = (out[id] || 0) + 1;
      }
      return out;
    },

    async publicationBySlug(slug) {
      const db = admin();
      if (!db) return null;
      const { data, error } = await db.from('comic_publications').select('id, project_id, user_id, status, snapshot').eq('slug', slug).maybeSingle();
      if (error) {
        warn('publicationBySlug', error);
        return null;
      }
      return toPublication(data as Record<string, unknown> | null);
    },

    async publicationByProject(projectId) {
      const db = admin();
      if (!db) return null;
      const { data, error } = await db.from('comic_publications').select('id, project_id, user_id, status, snapshot').eq('project_id', projectId).maybeSingle();
      if (error) {
        warn('publicationByProject', error);
        return null;
      }
      return toPublication(data as Record<string, unknown> | null);
    },

    async projectInfo(projectId) {
      const db = admin();
      if (!db || !uuidOrNull(projectId)) return null;
      const { data, error } = await db.from('projects').select('id, user_id, name, is_forced_private').eq('id', projectId).maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const r = data as Record<string, unknown>;
      return { ownerUserId: String(r.user_id || ''), ...(typeof r.name === 'string' ? { name: r.name } : {}), isForcedPrivate: r.is_forced_private === true };
    },

    async forcePrivate(projectId, reason, actorId) {
      const db = admin();
      if (!db) return;
      const { error } = await db
        .from('projects')
        .update({ is_forced_private: true, forced_private_reason: reason.slice(0, 200), forced_private_by: uuidOrNull(actorId), forced_private_at: iso(Date.now()) })
        .eq('id', projectId);
      if (error) throw error;
    },

    async liftAutoHold(projectId) {
      const db = admin();
      if (!db || !uuidOrNull(projectId)) return false;
      const { data, error } = await db
        .from('projects')
        .update({ is_forced_private: false, forced_private_reason: null, forced_private_by: null, forced_private_at: null })
        .eq('id', projectId)
        .eq('is_forced_private', true)
        .like('forced_private_reason', 'auto:%')
        .select('id');
      if (error) throw error;
      return Array.isArray(data) && data.length > 0;
    },

    async moderationAction(row) {
      const db = admin();
      if (!db) return;
      const { error } = await db.from('project_moderation_actions').insert({
        project_id: row.projectId,
        owner_user_id: uuidOrNull(row.ownerUserId ?? null),
        action: row.action,
        reason: row.reason ? String(row.reason).slice(0, 500) : null,
        acted_by: uuidOrNull(row.actedBy ?? null),
        metadata: row.metadata || {}
      });
      if (error) warn('moderationAction', error);
    },

    async recordQuarantine(row) {
      const db = admin();
      if (!db) return;
      const { error } = await db.from('comic_quarantine').upsert(
        {
          path: row.path,
          quarantine_path: row.quarantinePath,
          project_id: uuidOrNull(row.projectId ?? null),
          user_id: uuidOrNull(row.userId ?? null),
          reason: row.reason.slice(0, 120)
        },
        { onConflict: 'path' }
      );
      if (error) warn('recordQuarantine', error);
    },

    async quarantineFor(path) {
      const db = admin();
      if (!db) return null;
      const { data, error } = await db.from('comic_quarantine').select('quarantine_path').eq('path', path).maybeSingle();
      if (error) {
        warn('quarantineFor', error);
        return null;
      }
      return ((data as { quarantine_path?: string } | null)?.quarantine_path as string) || null;
    },

    async forgetQuarantine(path) {
      const db = admin();
      if (!db) return;
      const { error } = await db.from('comic_quarantine').delete().eq('path', path);
      if (error) warn('forgetQuarantine', error);
    },

    async notify(n) {
      const db = admin();
      if (!db || !uuidOrNull(n.userId)) return;
      const base = { user_id: n.userId, actor_id: uuidOrNull(n.actorId ?? null), type: 'system', entity_id: n.entityId ?? null };
      const { error } = await db.from('notifications').insert({ ...base, title: n.title, message: n.message, metadata: n.metadata || {} });
      if (!error) return;
      // Older notifications tables have no title/message columns (moderation.ts does the same):
      // a bare system notification still reaches the owner.
      if (String((error as { code?: string }).code) === '42703') {
        const retry = await db.from('notifications').insert(base);
        if (retry.error) warn('notify', retry.error);
        return;
      }
      warn('notify', error);
    }
  };
}
