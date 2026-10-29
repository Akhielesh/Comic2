// Test doubles for the model catalog (models.md §5.1 M1-CATALOG tests). Synthetic or public data only:
// `openrouter-2026-10-22T1751Z.json` is a trimmed copy of OpenRouter's public, unauthenticated catalog
// responses at 17:51Z (models.md §1.1). Nothing here touches the network or a database.

import { readFileSync } from 'node:fs';
import type { CachedPayload, CatalogFetch, CatalogFetchResponse, CatalogStore, ImageCallsDb, OrImageEndpoint, OrImageModel, OrModelEndpoint, PriceSnapshotRow, UptimeLogRow } from '../catalog.js';
import type { ImageCallRow, MonthlyUsageRow, PlatformStatRow } from '../observed.js';

export interface OpenRouterFixture {
  fetchedAt: string;
  imagesModels: { data: OrImageModel[] };
  imageEndpoints: Record<string, { id: string; endpoints: OrImageEndpoint[] }>;
  modelEndpoints: Record<string, { data: { id: string; endpoints: OrModelEndpoint[] } }>;
}

/** A fresh deep copy of the 17:51Z fixture (tests may mutate it). */
export const loadOpenRouterFixture = (): OpenRouterFixture =>
  JSON.parse(readFileSync(new URL('./openrouter-2026-10-22T1751Z.json', import.meta.url), 'utf8')) as OpenRouterFixture;

export const FIXTURE_NOW = Date.parse('2026-10-22T17:51:00Z');
export const FAKE_BASE = 'https://openrouter.test/api/v1';

export interface FakeFetch extends CatalogFetch {
  calls: string[];
  /** Fail every request whose URL contains one of these (status 503), or every request when `all`. */
  failing: { all: boolean; match: string[] };
}

const reply = (status: number, body: unknown): CatalogFetchResponse => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** Serves the fixture by URL (S1 list, S2 image endpoints, S3 model endpoints); 404 for anything else. */
export const fakeOpenRouterFetch = (fixture: OpenRouterFixture = loadOpenRouterFixture(), base = FAKE_BASE): FakeFetch => {
  const calls: string[] = [];
  const failing = { all: false, match: [] as string[] };
  const fn = (async (url: string) => {
    calls.push(url);
    if (failing.all || failing.match.some((m) => url.includes(m))) return reply(503, { error: 'unavailable' });
    if (!url.startsWith(base)) return reply(404, {});
    const path = url.slice(base.length);
    if (path === '/images/models') return reply(200, fixture.imagesModels);
    let m = /^\/images\/models\/(.+)\/endpoints$/.exec(path);
    if (m) return fixture.imageEndpoints[m[1]] ? reply(200, fixture.imageEndpoints[m[1]]) : reply(404, { error: 'not found' });
    m = /^\/models\/(.+)\/endpoints$/.exec(path);
    if (m) return fixture.modelEndpoints[m[1]] ? reply(200, fixture.modelEndpoints[m[1]]) : reply(404, { error: 'not found' });
    return reply(404, {});
  }) as FakeFetch;
  fn.calls = calls;
  fn.failing = failing;
  return fn;
};

export interface MemoryCatalogStore extends CatalogStore {
  cache: Map<string, CachedPayload[]>;
  snapshots: PriceSnapshotRow[];
  uptime: UptimeLogRow[];
}

/** The persistence the Supabase store gives in production, in memory. */
export const memoryCatalogStore = (): MemoryCatalogStore => {
  const cache = new Map<string, CachedPayload[]>();
  const snapshots: PriceSnapshotRow[] = [];
  const uptime: UptimeLogRow[] = [];
  return {
    cache,
    snapshots,
    uptime,
    async loadCache(source) {
      return [...(cache.get(source) ?? [])];
    },
    async saveCache(source, rows) {
      const byId = new Map((cache.get(source) ?? []).map((r) => [r.modelId, r] as const));
      for (const r of rows) byId.set(r.modelId, r);
      cache.set(source, [...byId.values()]);
    },
    async latestPriceSnapshots() {
      const latest = new Map<string, PriceSnapshotRow>();
      for (const r of snapshots) {
        const k = `${r.modelId}|${r.res}`;
        const cur = latest.get(k);
        if (!cur || r.fetchedAt >= cur.fetchedAt) latest.set(k, r);
      }
      return [...latest.values()];
    },
    async insertPriceSnapshots(rows) {
      snapshots.push(...rows);
    },
    async priceSnapshotsSince(sinceIso) {
      return snapshots.filter((r) => r.fetchedAt >= sinceIso);
    },
    async firstPriceSnapshotAt() {
      return snapshots.map((r) => r.fetchedAt).sort()[0] ?? null;
    },
    async logUptime(rows) {
      for (const r of rows) {
        const i = uptime.findIndex((u) => u.modelId === r.modelId && u.provider === r.provider && u.day === r.day);
        if (i >= 0) uptime[i] = r;
        else uptime.push(r);
      }
    },
    async uptimeSince(sinceIso) {
      return uptime.filter((u) => u.fetchedAt >= sinceIso);
    }
  };
};

/**
 * comic_image_calls in memory. `platformStats` mirrors the SQL function comic_image_model_stats: it groups by
 * (model, kind, res), SUPPRESSES groups with fewer than 5 distinct users, and reports cost figures over the newest
 * ≤ 20 priced calls only when those come from ≥ 5 distinct users — so tests exercise the same rules.
 */
export const memoryImageCalls = (rows: (ImageCallRow & { userId: string })[] = [], monthly: MonthlyUsageRow[] = []): ImageCallsDb & { rows: (ImageCallRow & { userId: string })[]; statsCalls: string[] } => {
  const statsCalls: string[] = [];
  return {
  rows,
  statsCalls,
  async callsForUser(userId, opts) {
    return rows
      .filter((r) => r.userId === userId && r.createdAt >= opts.sinceIso)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts.limit);
  },
  async platformStats(sinceIso) {
    statsCalls.push(sinceIso);
    const groups = new Map<string, (ImageCallRow & { userId: string })[]>();
    for (const r of rows) {
      if (r.createdAt < sinceIso || r.outcome === 'blocked') continue;
      const k = `${r.modelId}|${r.kind}|${r.res}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const out: PlatformStatRow[] = [];
    for (const g of groups.values()) {
      const users = new Set(g.map((r) => r.userId)).size;
      if (users < 5) continue;
      const priced = g.filter((r) => r.outcome === 'ok' && typeof r.providerCostUsd === 'number');
      const recent = [...priced].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
      const shown = new Set(recent.map((r) => r.userId)).size >= 5;
      const costs = recent.map((r) => r.providerCostUsd as number).sort((a, b) => a - b);
      const mid = Math.floor(costs.length / 2);
      const med = costs.length ? (costs.length % 2 ? costs[mid] : (costs[mid - 1] + costs[mid]) / 2) : null;
      out.push({
        modelId: g[0].modelId,
        kind: g[0].kind,
        res: g[0].res,
        calls: g.length,
        ok: g.filter((r) => r.outcome === 'ok').length,
        failed: g.filter((r) => r.outcome === 'failed').length,
        rateLimited: g.filter((r) => r.outcome === 'failed' && (r.httpStatus === 429 || r.errorCode === 'RATE_LIMIT')).length,
        distinctUsers: users,
        pricedCalls: priced.length,
        costN: shown ? recent.length : null,
        medianCostUsd: shown ? med : null,
        minCostUsd: shown && costs.length ? costs[0] : null,
        maxCostUsd: shown && costs.length ? costs[costs.length - 1] : null,
        costFrom: shown ? (recent.at(-1)?.createdAt ?? null) : null,
        costTo: shown ? (recent[0]?.createdAt ?? null) : null,
        firstAt: g.map((r) => r.createdAt).sort()[0] ?? null,
        lastAt: g.map((r) => r.createdAt).sort().at(-1) ?? null
      });
    }
    return out;
  },
  async monthlyUsage(product, sinceMonth) {
    return monthly.filter((m) => m.product === product && m.month >= sinceMonth);
  }
  };
};

/** One synthetic call row (defaults: an ok Nano Banana 2.1 1K page). */
export const callRow = (over: Partial<ImageCallRow> & { userId?: string; at: number }): ImageCallRow & { userId: string } => {
  const { at, ...rest } = over;
  return {
    userId: 'user-a',
    modelId: 'nano-banana-2.1',
    kind: 'page',
    res: '1K',
    outcome: 'ok',
    providerCostUsd: 0.04,
    ...rest,
    createdAt: new Date(at).toISOString()
  } as ImageCallRow & { userId: string };
};
