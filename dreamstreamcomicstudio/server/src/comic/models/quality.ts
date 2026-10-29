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

// The server tsconfig compiles with module Node16, which rejects import attributes (TS2823), yet Node 22 ESM,
// tsx, vitest and the esbuild bundle all need `with { type: 'json' }`; tsc still emits it and copies the JSON.
// @ts-ignore TS2823
import snapshotJson from './qualitySnapshot.json' with { type: 'json' };
import type { CatalogFetch } from './catalog.js';

export type QualityBoard = 'lmarena_t2i' | 'lmarena_edit' | 'lmarena_multi_image' | 'aa_t2i' | 'aa_edit' | 'design_arena';
export const QUALITY_BOARDS: QualityBoard[] = ['lmarena_t2i', 'lmarena_edit', 'lmarena_multi_image', 'aa_t2i', 'aa_edit', 'design_arena'];
export const LMARENA_BOARDS: QualityBoard[] = ['lmarena_t2i', 'lmarena_edit', 'lmarena_multi_image'];

export const NOT_RANKED_COPY = 'Not ranked on public leaderboards yet';
export const QUALITY_TTL_MS = 24 * 3_600_000;
export const HF_DATASETS_SERVER = 'https://datasets-server.huggingface.co';
export const LMARENA_DATASET = 'lmarena-ai/leaderboard-dataset';
/** A refreshed board replaces the snapshot's only when at least this share of the tracked models is found. */
export const MIN_MATCH_SHARE = 0.5;
const PAGE = 100;
const MAX_PAGES = 40;

export interface QualityEntry {
  board: QualityBoard;
  rank?: number;
  of?: number;
  score: number;
  ci?: [number, number];
  /** Board publish date / fetch time. */
  asOf: string;
  source: string;
}

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

export interface QualityHistoryPoint {
  asOf: string;
  rank?: number;
  score: number;
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
 * Every normalised form a leaderboard name can match on: the whole name, the name without a trailing
 * parenthetical, and the parenthetical itself. LMArena writes "Gemini 3.1 Flash-Lite Image (nano-banana-2-lite)",
 * "Gemini 3 Pro Image (2K)" and "Grok Imagine Image 2.0 (20260801)".
 */
export const nameKeys = (s: unknown): string[] => {
  const raw = String(s ?? '');
  const keys = new Set<string>([normalizeName(raw)]);
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(raw);
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

export interface RankMove {
  board: QualityBoard;
  from: QualityHistoryPoint;
  to: QualityHistoryPoint;
  /** Positive = climbed (rank got smaller). */
  delta: number;
}

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
      if (!points.some((p) => p.asOf === fresh.asOf)) points.push({ asOf: fresh.asOf, ...(typeof e.rank === 'number' ? { rank: e.rank } : {}), score: e.score });
      hist[board] = points.sort((a, b) => a.asOf.localeCompare(b.asOf));
      next.history[orId] = hist;
    }
  }
  return { snapshot: next, replaced, kept };
};

const encode = (s: string) => encodeURIComponent(s);

/** Configs/splits of the dataset (documented datasets-server endpoint). */
export const fetchLmarenaSplits = async (fetchImpl: CatalogFetch, base = HF_DATASETS_SERVER): Promise<{ config: string; split: string }[]> => {
  const res = await fetchImpl(`${base}/splits?dataset=${encode(LMARENA_DATASET)}`);
  if (!res.ok) throw new Error(`datasets-server splits ${res.status}`);
  const body = (await res.json()) as { splits?: { config?: string; split?: string }[] };
  return (body.splits ?? []).filter((s) => typeof s.config === 'string' && typeof s.split === 'string').map((s) => ({ config: s.config as string, split: s.split as string }));
};

/** Every row of one config/split, paged through the documented `/rows` endpoint. */
export const fetchLmarenaRows = async (fetchImpl: CatalogFetch, config: string, split: string, base = HF_DATASETS_SERVER): Promise<LmarenaRow[]> => {
  const rows: LmarenaRow[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await fetchImpl(`${base}/rows?dataset=${encode(LMARENA_DATASET)}&config=${encode(config)}&split=${encode(split)}&offset=${offset}&length=${PAGE}`);
    if (!res.ok) throw new Error(`datasets-server rows ${res.status}`);
    const body = (await res.json()) as { rows?: { row?: unknown }[]; num_rows_total?: number };
    const batch = (body.rows ?? []).map((r) => asRow(r?.row)).filter((r): r is LmarenaRow => !!r);
    rows.push(...batch);
    offset += body.rows?.length ?? 0;
    if (!body.rows?.length || typeof body.num_rows_total !== 'number' || offset >= body.num_rows_total) break;
  }
  return rows;
};

/** The three LMArena boards from the live dataset (null for a board whose config/split is missing). */
export const fetchLmarenaBoards = async (fetchImpl: CatalogFetch, aliases: Record<string, string[]>, base = HF_DATASETS_SERVER): Promise<Partial<Record<QualityBoard, QualityBoardSnapshot | null>>> => {
  const splits = await fetchLmarenaSplits(fetchImpl, base);
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

// ── On-demand source (24 h TTL, single-flight, stale-while-error, no timers) ──

export interface QualitySourceDeps {
  /** null = never fetch (tests, or a deployment that wants the bundled snapshot only). */
  fetch?: CatalogFetch | null;
  now?: () => number;
  snapshot?: QualitySnapshot;
  ttlMs?: number;
  base?: string;
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
  let state: QualityState = { snapshot: deps.snapshot ?? bundledQualitySnapshot, stale: false };
  let refreshedAt = 0;
  let inflight: Promise<QualityState> | null = null;

  const refresh = async (): Promise<QualityState> => {
    try {
      const boards = await fetchLmarenaBoards(fetchImpl as CatalogFetch, state.snapshot.aliases, deps.base);
      const at = new Date(now()).toISOString();
      const merged = mergeLmarenaBoards(state.snapshot, boards, at);
      state = { snapshot: merged.snapshot, fetchedAt: at, stale: false };
    } catch {
      state = { ...state, stale: true };
    }
    refreshedAt = now();
    return state;
  };

  return {
    current: () => state,
    get: async (opts = {}) => {
      if (!fetchImpl) return state;
      if (refreshedAt && now() - refreshedAt < ttl) return state;
      if (!inflight) inflight = refresh().finally(() => (inflight = null));
      return opts.wait ? inflight : state;
    }
  };
};
