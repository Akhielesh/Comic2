// In-memory fakes for the safety module (orchestrator.fakes.ts pattern). Owner: P1-SAFETY.
// Tests only: never spends, never touches Supabase or the network.

import type { LlmClient, LlmRequest, LlmResult } from '../types.js';
import type { CaseKind, OpenCaseInput, PublicationRef, SafetyCase, SafetyEventInput, SafetyStore } from './store.js';

export interface FakeSafetyStore extends SafetyStore {
  events: SafetyEventInput[];
  costs: { userId: string; projectId?: string | null; operation: string; model?: string; costUsd: number }[];
  statuses: Map<string, 'active' | 'restricted' | 'suspended'>;
  dobs: Map<string, string | null>;
  /** Make accountDob throw (a failed lookup). */
  dobFails: boolean;
  hashes: { hash: string; kind: 'dhash' | 'sha256'; category: string }[];
  cases: SafetyCase[];
  publications: (PublicationRef & { slug?: string })[];
  projects: Map<string, { ownerUserId: string; name?: string; isForcedPrivate: boolean; forcedReason?: string }>;
  actions: { projectId: string; ownerUserId?: string | null; action: string; reason?: string | null; actedBy?: string | null; metadata?: Record<string, unknown> }[];
  quarantine: Map<string, string>;
  notifications: { userId: string; title: string; message: string }[];
  /** Clock used for event / case timestamps. */
  now: () => number;
}

export function fakeSafetyStore(opts: { now?: () => number } = {}): FakeSafetyStore {
  let n = 0;
  const store: FakeSafetyStore = {
    configured: true,
    events: [],
    costs: [],
    statuses: new Map(),
    dobs: new Map(),
    dobFails: false,
    hashes: [],
    cases: [],
    publications: [],
    projects: new Map(),
    actions: [],
    quarantine: new Map(),
    notifications: [],
    now: opts.now || (() => Date.now()),

    async recordEvent(e) {
      store.events.push({ ...e, ...({ at: store.now() } as object) });
    },
    async recordPlatformCost(c) {
      store.costs.push(c);
    },
    async strikes(userId, sinceMs) {
      return store.events
        .filter((e) => e.userId === userId && e.severity > 0 && ((e as unknown as { at: number }).at ?? 0) >= sinceMs)
        .map((e) => ({ severity: e.severity, at: (e as unknown as { at: number }).at }));
    },
    async moderationStatus(userId) {
      return store.statuses.get(userId) || 'active';
    },
    async restrictUser(userId) {
      if (store.statuses.get(userId) === 'suspended') return;
      store.statuses.set(userId, 'restricted');
    },
    async accountDob(userId) {
      if (store.dobFails) throw new Error('db down');
      return store.dobs.get(userId) ?? null;
    },
    async blockedHashes() {
      return store.hashes.map(({ hash, kind }) => ({ hash, kind }));
    },
    async addBlockedHash(hash, kind, category) {
      if (!store.hashes.some((h) => h.hash === hash)) store.hashes.push({ hash, kind, category });
    },
    async openCase(c: OpenCaseInput) {
      const day = new Date(store.now()).toISOString().slice(0, 10);
      if (c.kind === 'report') {
        const key = c.reporterId || c.reporterFingerprint || '';
        const dup = store.cases.some(
          (x) =>
            x.kind === 'report' &&
            x.projectId === c.projectId &&
            (x.reporterId || x.reporterFingerprint || '') === key &&
            (x.target.path || '') === (c.target.path || '') &&
            new Date(x.createdAt).toISOString().slice(0, 10) === day
        );
        if (dup) return { id: null, deduped: true };
      }
      n += 1;
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      store.cases.push({
        id,
        kind: c.kind,
        projectId: c.projectId,
        ownerUserId: c.ownerUserId ?? null,
        reporterId: c.reporterId ?? null,
        reporterFingerprint: c.reporterFingerprint ?? null,
        target: c.target,
        reason: c.reason,
        note: c.note ?? null,
        status: c.status || 'open',
        createdAt: store.now()
      });
      return { id, deduped: false };
    },
    async listCases(filter) {
      return store.cases
        .filter((c) => (filter.status === 'open' ? c.status === 'open' : filter.status === 'resolved' ? c.status !== 'open' : true))
        .filter((c) => !filter.kind || c.kind === filter.kind)
        .slice()
        .reverse()
        .slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 50));
    },
    async getCase(id) {
      return store.cases.find((c) => c.id === id) || null;
    },
    async updateCase(id, patch) {
      const c = store.cases.find((x) => x.id === id);
      if (!c) return;
      c.status = patch.status;
      if (patch.resolution !== undefined) c.resolution = patch.resolution;
      if (patch.status !== 'open') {
        c.resolvedBy = patch.resolvedBy ?? null;
        c.resolvedAt = store.now();
      }
      if (patch.target) c.target = patch.target;
    },
    async reportsSince(projectId, sinceMs) {
      return store.cases
        .filter((c) => c.kind === 'report' && c.projectId === projectId && c.createdAt >= sinceMs)
        .map((c) => ({ reporterId: c.reporterId, fingerprint: c.reporterFingerprint, reason: c.reason }));
    },
    async appealsSince(userId, sinceMs) {
      return store.cases.filter((c) => c.kind === ('appeal' as CaseKind) && c.ownerUserId === userId && c.createdAt >= sinceMs).length;
    },
    async openCaseCounts() {
      const out: Record<string, number> = {};
      for (const c of store.cases) if (c.status === 'open') out[c.projectId] = (out[c.projectId] || 0) + 1;
      return out;
    },
    async publicationBySlug(slug) {
      return store.publications.find((p) => p.slug === slug) || null;
    },
    async publicationByProject(projectId) {
      return store.publications.find((p) => p.projectId === projectId) || null;
    },
    async projectInfo(projectId) {
      const p = store.projects.get(projectId);
      return p ? { ownerUserId: p.ownerUserId, ...(p.name ? { name: p.name } : {}), isForcedPrivate: p.isForcedPrivate } : null;
    },
    async forcePrivate(projectId, reason) {
      const p = store.projects.get(projectId) || { ownerUserId: '', isForcedPrivate: false };
      store.projects.set(projectId, { ...p, isForcedPrivate: true, forcedReason: reason });
      for (const pub of store.publications) if (pub.projectId === projectId && pub.status === 'live') pub.status = 'suspended';
    },
    async moderationAction(row) {
      store.actions.push(row);
    },
    async recordQuarantine(row) {
      store.quarantine.set(row.path, row.quarantinePath);
    },
    async quarantineFor(path) {
      return store.quarantine.get(path) ?? null;
    },
    async forgetQuarantine(path) {
      store.quarantine.delete(path);
    },
    async notify(note) {
      store.notifications.push({ userId: note.userId, title: note.title, message: note.message });
    }
  };
  return store;
}

export type SafetyLlmStep = Record<string, unknown> | Error | null | ((req: LlmRequest) => Record<string, unknown> | Error | null | Promise<Record<string, unknown> | Error | null>);

export interface FakeSafetyLlm extends LlmClient {
  calls: LlmRequest[];
  /** Answers per role, consumed in order; an exhausted queue answers `fallback` (default: a G/pass verdict). */
  script: Partial<Record<LlmRequest['role'], SafetyLlmStep[]>>;
  fallback: (req: LlmRequest) => Record<string, unknown>;
}

/** A clean answer for either schema. */
export const cleanAnswer = (req: LlmRequest): Record<string, unknown> =>
  req.jsonSchema?.name === 'comic_safety_text'
    ? { assessed: 'G', categories: [], adaptable: true, suggestion: '', ip: [], spans: [] }
    : { rating: 'G', categories: [], notes: [], photo: false, minorLikely: false, subject: 'other', view: 'none', caption: '', multipleSubjects: false };

/** The platform LLM fake: records every call (count them to prove the free path spent nothing). */
export function fakeSafetyLlm(script: FakeSafetyLlm['script'] = {}): FakeSafetyLlm {
  const llm: FakeSafetyLlm = {
    calls: [],
    script,
    fallback: cleanAnswer,
    async complete(req): Promise<LlmResult> {
      llm.calls.push(req);
      const queue = llm.script[req.role] || [];
      let step: SafetyLlmStep | undefined = queue.length ? queue.shift() : undefined;
      if (typeof step === 'function') step = await step(req);
      if (step instanceof Error) throw step;
      const json = step === undefined ? llm.fallback(req) : step;
      if (json === null) return { text: 'not json', model: `fake-${req.role}`, byok: false, provider: 'openrouter' };
      return { text: JSON.stringify(json), json, model: `fake-${req.role}`, costUsd: 0.0002, byok: false, provider: 'openrouter' };
    }
  };
  return llm;
}
