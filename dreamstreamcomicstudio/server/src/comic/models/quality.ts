// Public leaderboard quality (models.md §1.2, §4.3 `quality[]`, §4.4 T4, §4.5 S5/S6, §4.6).
//
// The bundled `qualitySnapshot.json` is the cache: LMArena (Hugging Face `lmarena-ai/leaderboard-dataset`,
// CC BY 4.0) and Artificial Analysis / Design Arena entries keyed by OpenRouter id, each board dated and
// sourced. LMArena can be refreshed on demand (24 h TTL, single-flight, stale-while-error) from the public
// Hugging Face datasets-server — a free, unauthenticated read that happens only when someone asks for the
// catalog, never on a timer. AA and Design Arena change only through the owner-run script
// (`scripts/models-quality-refresh.mjs`): AA's own site is not scraped in production (§4.5 S6).
//
// A model missing from a board is simply absent (the UI shows NOT_RANKED_COPY); a refresh that matches too few
// of the models we track keeps the dated snapshot instead of wiping it, so a naming change upstream can never
// turn into "Not ranked" for everyone.
//
// T4 (leaderboard movement) reads `history`: one dated point per LMArena publish date per tracked model and
// board, taken from the dataset's FULL split (every publish date, not just the latest) by the owner-run script
// and committed; the on-demand refresh adds each newer date it sees and is persisted (model_catalog_cache,
// source 'lmarena_snapshot') so the TTL and the history survive a sleeping container.

// The server tsconfig compiles with module Node16, which rejects import attributes (TS2823), yet Node 22 ESM,
// tsx, vitest and the esbuild bundle all need `with { type: 'json' }`; tsc still emits it and copies the JSON.
// @ts-ignore TS2823
import snapshotJson from './qualitySnapshot.json' with { type: 'json' };
import { logger } from '../../lib/logger.js';
import type { QualityBoard, QualityEntry, QualityHistoryPoint, RankMove } from '../../../../shared/comic/modelCatalog.js';
import type { CatalogFetch, CatalogStore } from './catalog.js';

// Wire types (shared/comic/modelCatalog.ts), re-exported with their names.
export type { QualityBoard, QualityEntry, QualityHistoryPoint, RankMove };
export const QUALITY_BOARDS: QualityBoard[] = ['lmarena_t2i', 'lmarena_edit', 'lmarena_multi_image', 'aa_t2i', 'aa_edit', 'design_arena'];
export const LMARENA_BOARDS: QualityBoard[] = ['lmarena_t2i', 'lmarena_edit', 'lmarena_multi_image'];

export const NOT_RANKED_COPY = 'Not ranked on public leaderboards yet';
export const QUALITY_TTL_MS = 24 * 3_600_000;
export const HF_DATASETS_SERVER = 'https://datasets-server.huggingface.co';
export const LMARENA_DATASET = 'lmarena-ai/leaderboard-dataset';
/** A refreshed board replaces the snapshot's only when at least this share of the tracked models is found. */
export const MIN_MATCH_SHARE = 0.5;
/** One datasets-server request may take at most this long (aborted after). */
export const HF_REQUEST_TIMEOUT_MS = 6_000;
/** A whole on-demand LMArena pull (splits + every page) may take at most this long. */
export const LMARENA_PULL_TIMEOUT_MS = 30_000;
/** After a failed pull, try again after this long (not a whole TTL; never a hot loop either). */
export const QUALITY_FAIL_RETRY_MS = 3_600_000;
/** Days of dated rank history a full-split pull asks for (T4's longest range). */
export const LMARENA_HISTORY_DAYS = 90;
/** History points older than this before the snapshot's generatedAt are dropped on merge (bounds the file). */
export const HISTORY_KEEP_DAYS = 120;
/** model_catalog_cache source and row id that persist the on-demand LMArena refresh. */
export const QUALITY_CACHE_SOURCE = 'lmarena_snapshot';
/** Paged /rows over a full split is the slow fallback when /filter is unavailable (owner-run script only). */
const MAX_FULL_PAGES = 300;
const PAGE = 100;
const MAX_PAGES = 40;

export interface QualityBoardEntry {
  rank?: number;
  score: number;
  ci?: [number, number];
  /** The leaderboard's own model name (so mappings are checkable). */
  name?: string;
  votes?: number;
}

export interface QualityBoardSnapshot {
  asOf: string;
  of?: number;
  category?: string;
  source: string;
  entries: Record<string, QualityBoardEntry>;
}

export interface QualitySnapshot {
  generatedAt: string;
  /** OpenRouter id → normalised leaderboard names that mean this model. */
  aliases: Record<string, string[]>;
  boards: Partial<Record<QualityBoard, QualityBoardSnapshot>>;
  history: Record<string, Partial<Record<QualityBoard, QualityHistoryPoint[]>>>;
}

export const bundledQualitySnapshot: QualitySnapshot = snapshotJson as unknown as QualitySnapshot;

/** Leaderboard names normalised for matching: "Gemini Nano Banana 2.1" and "gemini-nano-banana-2.1" both → "gemininanobanana21". */
export const normalizeName = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Every normalised form a leaderboard name can match on: the whole name, the name without trailing [tags], the
 * name without a trailing parenthetical, and the parenthetical itself. LMArena writes "Gemini 3.1 Flash-Lite
 * Image (nano-banana-2-lite)", "Gemini 3 Pro Image (2K)", "Grok Imagine Image 2.0 (20260801)" and
 * "gemini-3.1-flash-image (nano-banana-2) [web-search]".
 */
export const nameKeys = (s: unknown): string[] => {
  const raw = String(s ?? '');
  const keys = new Set<string>([normalizeName(raw)]);
  const untagged = raw.replace(/(\s*\[[^\]]*\])+\s*$/, '');
  keys.add(normalizeName(untagged));
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(untagged);
  if (m) {
    keys.add(normalizeName(m[1]));
    keys.add(normalizeName(m[2]));
  }
  keys.delete('');
  return [...keys];
};

/** Every board entry for one OpenRouter id, in QUALITY_BOARDS order. Empty = NOT_RANKED_COPY. */
export const qualityEntriesFor = (orId: string | undefined, snap: QualitySnapshot = bundledQualitySnapshot): QualityEntry[] => {
  if (!orId) return [];
  const out: QualityEntry[] = [];
  for (const board of QUALITY_BOARDS) {
    const b = snap.boards[board];
    const e = b?.entries?.[orId];
    if (!b || !e || typeof e.score !== 'number') continue;
    out.push({ board, ...(typeof e.rank === 'number' ? { rank: e.rank } : {}), ...(typeof b.of === 'number' ? { of: b.of } : {}), score: e.score, ...(e.ci ? { ci: e.ci } : {}), asOf: b.asOf, source: b.source });
  }
  return out;
};

/** The newest board date in a snapshot (what the catalog reports as `fetchedAt.quality`). */
export const qualityAsOf = (snap: QualitySnapshot = bundledQualitySnapshot): string | undefined => {
  const dates = Object.values(snap.boards).map((b) => b?.asOf).filter((d): d is string => typeof d === 'string');
  return dates.length ? dates.sort().at(-1) : snap.generatedAt;
};

/**
 * T4: rank movement inside a window from the history we hold (≥ 2 dated points in range). Nothing is
 * interpolated; with one point there is no move, only `trackingSince`.
 */
export const rankMovesFor = (orId: string | undefined, since: string, snap: QualitySnapshot = bundledQualitySnapshot): { moves: RankMove[]; trackingSince: string | null } => {
  if (!orId) return { moves: [], trackingSince: null };
  const hist = snap.history[orId] ?? {};
  const moves: RankMove[] = [];
  let earliest: string | null = null;
  for (const board of QUALITY_BOARDS) {
    const points = (hist[board] ?? []).filter((p) => typeof p.asOf === 'string').sort((a, b) => a.asOf.localeCompare(b.asOf));
    if (points.length && (!earliest || points[0].asOf < earliest)) earliest = points[0].asOf;
    const inRange = points.filter((p) => p.asOf >= since);
    if (inRange.length < 2) continue;
    const from = inRange[0];
    const to = inRange[inRange.length - 1];
    if (typeof from.rank !== 'number' || typeof to.rank !== 'number') continue;
    moves.push({ board, from, to, delta: from.rank - to.rank });
  }
  return { moves, trackingSince: earliest };
};

// ── LMArena (Hugging Face datasets-server) ────────────────────────────────────

export interface LmarenaRow {
  model_name: string;
  rating: number;
  rating_lower?: number;
  rating_upper?: number;
  vote_count?: number;
  rank: number;
  category: string;
  leaderboard_publish_date: string;
}

const asRow = (raw: unknown): LmarenaRow | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.model_name !== 'string' || typeof r.rating !== 'number' || typeof r.rank !== 'number' || typeof r.category !== 'string') return null;
  return {
    model_name: r.model_name,
    rating: r.rating,
    rating_lower: typeof r.rating_lower === 'number' ? r.rating_lower : undefined,
    rating_upper: typeof r.rating_upper === 'number' ? r.rating_upper : undefined,
    vote_count: typeof r.vote_count === 'number' ? r.vote_count : undefined,
    rank: r.rank,
    category: r.category,
    leaderboard_publish_date: typeof r.leaderboard_publish_date === 'string' ? r.leaderboard_publish_date : ''
  };
};

/** The overall category of a config: 'overall' when present, else the category with the most rows (named in `source`). */
export const pickCategory = (rows: LmarenaRow[], preferred: string): string | undefined => {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  if (counts.has(preferred)) return preferred;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
};

/**
 * Rows of one config + category → a board keyed by OpenRouter id through the snapshot's aliases. Several
 * leaderboard entries can match one id (preview / 2K variants): the best rank wins and `name` says which.
 */
export const lmarenaRowsToBoard = (rows: LmarenaRow[], opts: { category: string; aliases: Record<string, string[]>; configLabel: string }): QualityBoardSnapshot | null => {
  const inCategory = rows.filter((r) => r.category === opts.category);
  if (!inCategory.length) return null;
  const latest = inCategory.map((r) => r.leaderboard_publish_date).filter(Boolean).sort().at(-1) ?? '';
  const current = latest ? inCategory.filter((r) => r.leaderboard_publish_date === latest) : inCategory;
  const entries: Record<string, QualityBoardEntry> = {};
  for (const [orId, names] of Object.entries(opts.aliases)) {
    const wanted = new Set(names.map(normalizeName));
    const hits = current.filter((r) => nameKeys(r.model_name).some((k) => wanted.has(k))).sort((a, b) => a.rank - b.rank);
    const best = hits[0];
    if (!best) continue;
    const ci: [number, number] | undefined = typeof best.rating_lower === 'number' && typeof best.rating_upper === 'number' ? [best.rating_lower, best.rating_upper] : undefined;
    entries[orId] = { rank: best.rank, score: Math.round(best.rating * 10) / 10, ...(ci ? { ci } : {}), name: best.model_name, ...(typeof best.vote_count === 'number' ? { votes: best.vote_count } : {}) };
  }
  return {
    asOf: latest || new Date(0).toISOString().slice(0, 10),
    of: new Set(current.map((r) => r.model_name)).size,
    category: opts.category,
    source: `LMArena leaderboard-dataset (Hugging Face, CC BY 4.0), ${opts.configLabel} · latest split, category ${opts.category}, published ${latest || 'unknown'}`,
    entries
  };
};

/** Merge refreshed LMArena boards into a snapshot (pure): a board replaces the old one only when it matched enough tracked models; history gains a point per new publish date. */
export const mergeLmarenaBoards = (snap: QualitySnapshot, boards: Partial<Record<QualityBoard, QualityBoardSnapshot | null>>, generatedAt: string): { snapshot: QualitySnapshot; replaced: QualityBoard[]; kept: QualityBoard[] } => {
  const next: QualitySnapshot = { ...snap, generatedAt, boards: { ...snap.boards }, history: { ...snap.history } };
  const replaced: QualityBoard[] = [];
  const kept: QualityBoard[] = [];
  for (const board of LMARENA_BOARDS) {
    const fresh = boards[board];
    const old = snap.boards[board];
    if (!fresh) {
      kept.push(board);
      continue;
    }
    const tracked = Object.keys(old?.entries ?? {});
    const matched = tracked.filter((id) => fresh.entries[id]).length;
    if (tracked.length && matched / tracked.length < MIN_MATCH_SHARE) {
      kept.push(board);
      continue;
    }
    next.boards[board] = fresh;
    replaced.push(board);
    for (const [orId, e] of Object.entries(fresh.entries)) {
      const hist = { ...(next.history[orId] ?? {}) };
      const points = [...(hist[board] ?? [])];
      if (!points.some((p) => p.asOf === fresh.asOf)) points.push({ asOf: fresh.asOf, ...(typeof e.rank === 'number' ? { rank: e.rank } : {}), score: e.score, ...(e.name ? { name: e.name } : {}) });
      hist[board] = points.sort((a, b) => a.asOf.localeCompare(b.asOf));
      next.history[orId] = hist;
    }
  }
  next.history = pruneHistory(next.history, generatedAt);
  return { snapshot: next, replaced, kept };
};

/** Drops history points older than HISTORY_KEEP_DAYS before `generatedAt` (pure). */
export const pruneHistory = (history: QualitySnapshot['history'], generatedAt: string): QualitySnapshot['history'] => {
  const at = Date.parse(generatedAt);
  if (!Number.isFinite(at)) return history;
  const cutoff = new Date(at - HISTORY_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const out: QualitySnapshot['history'] = {};
  for (const [orId, boards] of Object.entries(history)) {
    const kept: Partial<Record<QualityBoard, QualityHistoryPoint[]>> = {};
    for (const [board, points] of Object.entries(boards ?? {}) as [QualityBoard, QualityHistoryPoint[]][]) {
      const recent = (points ?? []).filter((p) => typeof p.asOf === 'string' && p.asOf.slice(0, 10) >= cutoff);
      if (recent.length) kept[board] = recent;
    }
    if (Object.keys(kept).length) out[orId] = kept;
  }
  return out;
};

/** Dated points per tracked OpenRouter id for one board. */
export type LmarenaHistory = Partial<Record<QualityBoard, Record<string, QualityHistoryPoint[]>>>;

/**
 * Full-split rows of one category → one point per publish date per tracked id (the best-ranked alias match
 * that day, with the leaderboard's own name), from `sinceDate` on. Nothing is interpolated.
 */
export const lmarenaHistoryFromRows = (rows: LmarenaRow[], opts: { category: string; aliases: Record<string, string[]>; sinceDate: string }): Record<string, QualityHistoryPoint[]> => {
  const byDate = new Map<string, LmarenaRow[]>();
  for (const r of rows) {
    if (r.category !== opts.category || !r.leaderboard_publish_date || r.leaderboard_publish_date < opts.sinceDate) continue;
    byDate.set(r.leaderboard_publish_date, [...(byDate.get(r.leaderboard_publish_date) ?? []), r]);
  }
  const out: Record<string, QualityHistoryPoint[]> = {};
  for (const date of [...byDate.keys()].sort()) {
    const board = lmarenaRowsToBoard(byDate.get(date) as LmarenaRow[], { category: opts.category, aliases: opts.aliases, configLabel: '' });
    for (const [orId, e] of Object.entries(board?.entries ?? {})) {
      (out[orId] ??= []).push({ asOf: date, ...(typeof e.rank === 'number' ? { rank: e.rank } : {}), score: e.score, ...(e.name ? { name: e.name } : {}) });
    }
  }
  return out;
};

/** Merges dated points into a snapshot's history (a point for a date we hold is replaced) and prunes (pure). */
export const mergeLmarenaHistory = (snap: QualitySnapshot, history: LmarenaHistory, generatedAt: string): { snapshot: QualitySnapshot; added: number } => {
  const next: QualitySnapshot = { ...snap, history: { ...snap.history } };
  let added = 0;
  for (const board of LMARENA_BOARDS) {
    for (const [orId, points] of Object.entries(history[board] ?? {})) {
      const hist = { ...(next.history[orId] ?? {}) };
      const byDate = new Map((hist[board] ?? []).map((p) => [p.asOf, p] as const));
      for (const p of points) {
        if (!byDate.has(p.asOf)) added += 1;
        byDate.set(p.asOf, p);
      }
      hist[board] = [...byDate.values()].sort((a, b) => a.asOf.localeCompare(b.asOf));
      next.history[orId] = hist;
    }
  }
  next.history = pruneHistory(next.history, generatedAt);
  return { snapshot: next, added };
};

const encode = (s: string) => encodeURIComponent(s);

/** How a pull talks to datasets-server: its base URL, a per-request timeout and an overall deadline (epoch ms). */
export interface PullOptions {
  base?: string;
  /** The dataset's configs/splits when the caller already fetched them (saves a request). */
  splits?: { config: string; split: string }[];
  requestMs?: number;
  /** Wall-clock time (Date.now()) after which no further request starts and a running one is cut short. */
  deadline?: number;
}

const pullOptions = (opts: string | PullOptions | undefined): PullOptions => (typeof opts === 'string' ? { base: opts } : (opts ?? {}));

/**
 * One datasets-server GET, bounded: its own AbortController (requestMs, or what is left of the deadline), and
 * the answer raced against that abort, so even a fetch that ignores the signal can never hang a pull.
 */
const hfJson = async (fetchImpl: CatalogFetch, url: string, opts: PullOptions, what: string): Promise<unknown> => {
  const left = opts.deadline !== undefined ? opts.deadline - Date.now() : Number.POSITIVE_INFINITY;
  if (left <= 0) throw new Error(`datasets-server ${what}: the pull ran out of time`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(opts.requestMs ?? HF_REQUEST_TIMEOUT_MS, left)); // per request, never at import
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error(`datasets-server ${what} timed out`)), { once: true });
  });
  aborted.catch(() => undefined); // settled by the race below when it matters
  try {
    return await Promise.race([
      (async () => {
        const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`datasets-server ${what} ${res.status}`);
        return res.json();
      })(),
      aborted
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Configs/splits of the dataset (documented datasets-server endpoint). */
export const fetchLmarenaSplits = async (fetchImpl: CatalogFetch, opts?: string | PullOptions): Promise<{ config: string; split: string }[]> => {
  const o = pullOptions(opts);
  const body = (await hfJson(fetchImpl, `${o.base ?? HF_DATASETS_SERVER}/splits?dataset=${encode(LMARENA_DATASET)}`, o, 'splits')) as { splits?: { config?: string; split?: string }[] };
  return (body?.splits ?? []).filter((s) => typeof s.config === 'string' && typeof s.split === 'string').map((s) => ({ config: s.config as string, split: s.split as string }));
};

/** Every row of one config/split, paged through the documented `/rows` endpoint. */
export const fetchLmarenaRows = async (fetchImpl: CatalogFetch, config: string, split: string, opts?: string | PullOptions): Promise<LmarenaRow[]> => {
  const o = pullOptions(opts);
  const rows: LmarenaRow[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${o.base ?? HF_DATASETS_SERVER}/rows?dataset=${encode(LMARENA_DATASET)}&config=${encode(config)}&split=${encode(split)}&offset=${offset}&length=${PAGE}`;
    const body = (await hfJson(fetchImpl, url, o, 'rows')) as { rows?: { row?: unknown }[]; num_rows_total?: number };
    const batch = (body?.rows ?? []).map((r) => asRow(r?.row)).filter((r): r is LmarenaRow => !!r);
    rows.push(...batch);
    offset += body?.rows?.length ?? 0;
    if (!body?.rows?.length || typeof body.num_rows_total !== 'number' || offset >= body.num_rows_total) break;
  }
  return rows;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Rows of one config of the FULL split matching `where`, through the documented /filter endpoint (the dataset
 * viewer runs the predicate server-side, so a 90-day window is a few pages instead of the whole history). With
 * `fallbackToRows` (the owner-run script) a failing /filter falls back to paging /rows and filtering here.
 */
const fetchFilteredRows = async (
  fetchImpl: CatalogFetch,
  config: string,
  split: string,
  where: string,
  keep: (r: LmarenaRow) => boolean,
  o: PullOptions & { fallbackToRows?: boolean }
): Promise<LmarenaRow[]> => {
  const base = o.base ?? HF_DATASETS_SERVER;
  const page = async (path: 'filter' | 'rows', offset: number) => {
    const q = `dataset=${encode(LMARENA_DATASET)}&config=${encode(config)}&split=${encode(split)}${path === 'filter' ? `&where=${encode(where)}` : ''}&offset=${offset}&length=${PAGE}`;
    return (await hfJson(fetchImpl, `${base}/${path}?${q}`, o, path)) as { rows?: { row?: unknown }[]; num_rows_total?: number };
  };
  const pageAll = async (path: 'filter' | 'rows', maxPages: number) => {
    const rows: LmarenaRow[] = [];
    let offset = 0;
    for (let i = 0; i < maxPages; i += 1) {
      const body = await page(path, offset);
      rows.push(...(body?.rows ?? []).map((r) => asRow(r?.row)).filter((r): r is LmarenaRow => !!r && keep(r)));
      offset += body?.rows?.length ?? 0;
      if (!body?.rows?.length || typeof body.num_rows_total !== 'number' || offset >= body.num_rows_total) break;
    }
    return rows;
  };
  try {
    return await pageAll('filter', MAX_PAGES);
  } catch (err) {
    if (!o.fallbackToRows) throw err;
    return pageAll('rows', MAX_FULL_PAGES);
  }
};

/**
 * T4 history from the dataset's FULL split: one point per publish date since `sinceDate` per tracked id, for
 * text_to_image (overall) and image_edit (overall + multi-image). A config without a full split gives nothing.
 */
export const fetchLmarenaHistory = async (
  fetchImpl: CatalogFetch,
  aliases: Record<string, string[]>,
  opts: PullOptions & { sinceDate: string; fallbackToRows?: boolean }
): Promise<LmarenaHistory> => {
  if (!ISO_DATE.test(opts.sinceDate)) throw new Error(`sinceDate must be YYYY-MM-DD, got ${opts.sinceDate}`);
  const since = opts.sinceDate;
  const splits = opts.splits ?? (await fetchLmarenaSplits(fetchImpl, opts));
  const full = (needle: string) => splits.find((s) => s.config.includes(needle) && s.split === 'full');
  const out: LmarenaHistory = {};
  const t2i = full('text_to_image');
  if (t2i) {
    const rows = await fetchFilteredRows(fetchImpl, t2i.config, t2i.split, `"leaderboard_publish_date">='${since}' AND "category"='overall'`, (r) => r.leaderboard_publish_date >= since && r.category === 'overall', opts);
    out.lmarena_t2i = lmarenaHistoryFromRows(rows, { category: 'overall', aliases, sinceDate: since });
  }
  const edit = full('image_edit');
  if (edit) {
    const rows = await fetchFilteredRows(fetchImpl, edit.config, edit.split, `"leaderboard_publish_date">='${since}'`, (r) => r.leaderboard_publish_date >= since, opts);
    out.lmarena_edit = lmarenaHistoryFromRows(rows, { category: 'overall', aliases, sinceDate: since });
    const multi = pickCategory(rows.filter((r) => r.category.includes('multi')), 'multi_image_edit');
    if (multi) out.lmarena_multi_image = lmarenaHistoryFromRows(rows, { category: multi, aliases, sinceDate: since });
  }
  return out;
};

/** The three LMArena boards from the live dataset (null for a board whose config/split is missing). */
export const fetchLmarenaBoards = async (fetchImpl: CatalogFetch, aliases: Record<string, string[]>, opts?: string | PullOptions): Promise<Partial<Record<QualityBoard, QualityBoardSnapshot | null>>> => {
  const base = pullOptions(opts);
  const splits = base.splits ?? (await fetchLmarenaSplits(fetchImpl, base));
  const find = (needle: string) => splits.find((s) => s.config.includes(needle) && s.split === 'latest') ?? splits.find((s) => s.config.includes(needle));
  const t2i = find('text_to_image');
  const edit = find('image_edit');
  const out: Partial<Record<QualityBoard, QualityBoardSnapshot | null>> = { lmarena_t2i: null, lmarena_edit: null, lmarena_multi_image: null };
  if (t2i) {
    const rows = await fetchLmarenaRows(fetchImpl, t2i.config, t2i.split, base);
    const category = pickCategory(rows, 'overall');
    if (category) out.lmarena_t2i = lmarenaRowsToBoard(rows, { category, aliases, configLabel: t2i.config });
  }
  if (edit) {
    const rows = await fetchLmarenaRows(fetchImpl, edit.config, edit.split, base);
    const category = pickCategory(rows, 'overall');
    if (category) out.lmarena_edit = lmarenaRowsToBoard(rows, { category, aliases, configLabel: edit.config });
    const multi = pickCategory(rows.filter((r) => r.category.includes('multi')), 'multi_image_edit');
    if (multi) out.lmarena_multi_image = lmarenaRowsToBoard(rows, { category: multi, aliases, configLabel: edit.config });
  }
  return out;
};

// ── Persistence of the on-demand refresh (model_catalog_cache, source 'lmarena_snapshot') ──

/** What the on-demand refresh persists: LMArena boards and the dated history (AA boards and aliases stay bundled). */
export interface PersistedQuality {
  fetchedAt: string;
  generatedAt: string;
  boards: Partial<Record<QualityBoard, QualityBoardSnapshot>>;
  history: QualitySnapshot['history'];
}

export interface QualityStore {
  load(): Promise<PersistedQuality | null>;
  save(p: PersistedQuality): Promise<void>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A persisted payload, validated field by field; anything malformed is dropped (never trusted as is). */
export const asPersistedQuality = (raw: unknown, fetchedAt: string): PersistedQuality | null => {
  if (!isObj(raw) || !Number.isFinite(Date.parse(fetchedAt))) return null;
  const boards: PersistedQuality['boards'] = {};
  for (const board of LMARENA_BOARDS) {
    const b = isObj(raw.boards) ? raw.boards[board] : undefined;
    if (isObj(b) && typeof b.asOf === 'string' && typeof b.source === 'string' && isObj(b.entries)) boards[board] = b as unknown as QualityBoardSnapshot;
  }
  const history: QualitySnapshot['history'] = {};
  for (const [orId, perBoard] of Object.entries(isObj(raw.history) ? raw.history : {})) {
    if (!isObj(perBoard)) continue;
    for (const board of LMARENA_BOARDS) {
      const points = perBoard[board];
      if (!Array.isArray(points)) continue;
      const ok = points.filter((p): p is QualityHistoryPoint => isObj(p) && typeof p.asOf === 'string' && typeof p.score === 'number');
      if (ok.length) (history[orId] ??= {})[board] = ok;
    }
  }
  return { fetchedAt, generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : fetchedAt, boards, history };
};

/** The quality store on top of the catalog's cache table (one row: source 'lmarena_snapshot', the dataset id). */
export const qualityStoreFromCatalogStore = (store: Pick<CatalogStore, 'loadCache' | 'saveCache'>): QualityStore => ({
  async load() {
    const row = (await store.loadCache(QUALITY_CACHE_SOURCE)).find((r) => r.modelId === LMARENA_DATASET);
    return row ? asPersistedQuality(row.payload, row.fetchedAt) : null;
  },
  async save(p) {
    await store.saveCache(QUALITY_CACHE_SOURCE, [{ modelId: LMARENA_DATASET, payload: p, fetchedAt: p.fetchedAt }]);
  }
});

/** The bundled snapshot with a persisted refresh laid over it: newer LMArena boards win, history is the union (pure). */
export const withPersistedQuality = (snap: QualitySnapshot, p: PersistedQuality): QualitySnapshot => {
  const boards = { ...snap.boards };
  for (const board of LMARENA_BOARDS) {
    const fresh = p.boards[board];
    if (fresh && (!boards[board] || fresh.asOf >= (boards[board] as QualityBoardSnapshot).asOf)) boards[board] = fresh;
  }
  const asHistory: LmarenaHistory = {};
  for (const [orId, perBoard] of Object.entries(p.history)) {
    for (const [board, points] of Object.entries(perBoard ?? {}) as [QualityBoard, QualityHistoryPoint[]][]) (asHistory[board] ??= {})[orId] = points;
  }
  const generatedAt = p.generatedAt > snap.generatedAt ? p.generatedAt : snap.generatedAt;
  return mergeLmarenaHistory({ ...snap, boards, generatedAt }, asHistory, generatedAt).snapshot;
};

/** The newest LMArena publish date the snapshot holds (boards or history), or undefined. */
export const newestLmarenaDate = (snap: QualitySnapshot): string | undefined => {
  const dates: string[] = [];
  for (const board of LMARENA_BOARDS) {
    const b = snap.boards[board];
    if (b?.asOf) dates.push(b.asOf.slice(0, 10));
  }
  for (const perBoard of Object.values(snap.history)) for (const board of LMARENA_BOARDS) for (const p of perBoard?.[board] ?? []) dates.push(p.asOf.slice(0, 10));
  return dates.filter((d) => ISO_DATE.test(d)).sort().at(-1);
};

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// ── On-demand source (24 h TTL, single-flight, stale-while-error, no timers) ──

export interface QualitySourceDeps {
  /** null = never fetch (tests, or a deployment that wants the bundled snapshot only). */
  fetch?: CatalogFetch | null;
  now?: () => number;
  snapshot?: QualitySnapshot;
  ttlMs?: number;
  base?: string;
  /** Overrides for HF_REQUEST_TIMEOUT_MS / LMARENA_PULL_TIMEOUT_MS / QUALITY_FAIL_RETRY_MS (tests). */
  timeouts?: { requestMs?: number; pullMs?: number; failRetryMs?: number };
  /** Where the on-demand refresh is persisted, so the TTL and the history survive a sleeping container. */
  store?: QualityStore | null;
}

export interface QualityState {
  snapshot: QualitySnapshot;
  /** When the live refresh last succeeded (undefined = bundled snapshot only). */
  fetchedAt?: string;
  /** The last refresh failed; the dated snapshot is being served. */
  stale: boolean;
}

export interface QualitySource {
  /**
   * The snapshot to show. When the 24 h TTL has run out this starts ONE refresh (single-flight) and, unless
   * `wait` is set, answers at once with the dated snapshot it holds: a reader never waits on Hugging Face
   * (the LMArena pull is several pages). The refreshed boards show on the next request.
   */
  get(opts?: { wait?: boolean }): Promise<QualityState>;
  /** Synchronous view of what `get()` last produced (for callers that must not wait). */
  current(): QualityState;
}

export const createQualitySource = (deps: QualitySourceDeps = {}): QualitySource => {
  const now = deps.now ?? (() => Date.now());
  const ttl = deps.ttlMs ?? QUALITY_TTL_MS;
  const fetchImpl = deps.fetch === undefined ? (globalThis.fetch as unknown as CatalogFetch | undefined) ?? null : deps.fetch;
  const pullMs = deps.timeouts?.pullMs ?? LMARENA_PULL_TIMEOUT_MS;
  const requestMs = deps.timeouts?.requestMs ?? HF_REQUEST_TIMEOUT_MS;
  const failRetryMs = deps.timeouts?.failRetryMs ?? QUALITY_FAIL_RETRY_MS;
  let state: QualityState = { snapshot: deps.snapshot ?? bundledQualitySnapshot, stale: false };
  /** When the last pull succeeded / failed (deps.now clock). */
  let refreshedAt = 0;
  let failedAt = 0;
  let inflight: Promise<QualityState> | null = null;
  let booted: Promise<void> | null = null;

  /** Once per process: lay the persisted refresh over the bundled snapshot; its time keeps the TTL across sleeps. */
  const boot = () =>
    (booted ??= (async () => {
      if (!deps.store) return;
      try {
        const p = await deps.store.load();
        if (!p) return;
        state = { ...state, snapshot: withPersistedQuality(state.snapshot, p), fetchedAt: p.fetchedAt };
        const at = Date.parse(p.fetchedAt);
        if (Number.isFinite(at) && at > refreshedAt) refreshedAt = at;
      } catch (err) {
        logger.warn('comic_model_quality_bootstrap_failed', { message: (err as Error)?.message });
      }
    })());

  const refresh = async (): Promise<QualityState> => {
    try {
      // Every request is bounded and no request starts after the deadline, so this always settles.
      const o: PullOptions = { base: deps.base, requestMs, deadline: Date.now() + pullMs };
      const held = newestLmarenaDate(state.snapshot); // before this pull: the dates after it are what a sleep may have missed
      o.splits = await fetchLmarenaSplits(fetchImpl as CatalogFetch, o);
      const boards = await fetchLmarenaBoards(fetchImpl as CatalogFetch, state.snapshot.aliases, o);
      const at = new Date(now()).toISOString();
      let snapshot = mergeLmarenaBoards(state.snapshot, boards, at).snapshot;
      // Best effort: publish dates newer than what we held that a sleeping container missed (full split, /filter).
      try {
        const floor = new Date(now() - LMARENA_HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
        const since = held && addDays(held, 1) > floor ? addDays(held, 1) : floor;
        const history = await fetchLmarenaHistory(fetchImpl as CatalogFetch, snapshot.aliases, { ...o, sinceDate: since });
        snapshot = mergeLmarenaHistory(snapshot, history, at).snapshot;
      } catch (err) {
        logger.warn('comic_model_quality_history_gap_fill_failed', { message: (err as Error)?.message });
      }
      state = { snapshot, fetchedAt: at, stale: false };
      refreshedAt = now();
      failedAt = 0;
      if (deps.store) {
        const lmBoards: PersistedQuality['boards'] = {};
        for (const board of LMARENA_BOARDS) if (snapshot.boards[board]) lmBoards[board] = snapshot.boards[board];
        // Bounded like every request: a store that never answers must not keep this refresh (and the source) pending.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          deps.store.save({ fetchedAt: at, generatedAt: at, boards: lmBoards, history: snapshot.history }).catch((err) => logger.warn('comic_model_quality_persist_failed', { message: (err as Error)?.message })),
          new Promise<void>((resolve) => (timer = setTimeout(resolve, requestMs)))
        ]).finally(() => timer !== undefined && clearTimeout(timer));
      }
    } catch (err) {
      state = { ...state, stale: true };
      failedAt = now();
      logger.warn('comic_model_quality_refresh_failed', { message: (err as Error)?.message });
    }
    return state;
  };

  return {
    current: () => state,
    get: async (opts = {}) => {
      await boot();
      if (!fetchImpl) return state;
      const t = now();
      if (failedAt && t - failedAt < failRetryMs) return state; // a recent failure: the dated snapshot, marked stale
      if (!failedAt && refreshedAt && t - refreshedAt < ttl) return state;
      if (!inflight) inflight = refresh().finally(() => (inflight = null));
      return opts.wait ? inflight : state;
    }
  };
};
