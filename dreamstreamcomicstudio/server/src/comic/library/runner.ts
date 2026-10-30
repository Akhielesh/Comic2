// Library build runner (assets.md §4.5–§4.6 as amended by decisions-final #4). Owned by P1-LIBRARY.
//
// CLIENT-DRIVEN, step by step: there is no background job. The admin console creates a run
// (one explicit click), then calls `step` repeatedly; each step takes the run's lease, resets
// rows stuck by a dead step (> LIBRARY_STUCK_MS), claims ≤ n pending assets and runs ONE
// attempt for each (generate → store → measure → analyze → publish / refine / review), then
// releases the lease. A sleeping container, a dropped connection or a retried request can
// never double-spend: claims and the lease are conditional updates, and a step that died
// mid-way is simply resumed by the next one.
//
// Money: every image, vision and rewrite call is recorded in generation_cost_events
// (operation 'comic_library_build', billable 0, platform-paid), and a step never starts an
// attempt whose estimate would take the run over its budget ($5 default, $25 hard max).
// Generation happens ONLY here, behind requireAdmin; the director and the studio never call it.
// Every image is generated fresh from the manifest: no user's image is ever read or reused.

import { randomUUID } from 'node:crypto';
import { hashString } from '../../../../shared/comic/doc.js';
import {
  LIBRARY_BUDGET_DEFAULT_USD,
  LIBRARY_ID_RE,
  LIBRARY_IP_BLOCKLIST,
  LIBRARY_MANIFEST_VERSION,
  LIBRARY_MAX_RETRIES,
  LIBRARY_STEP_MAX,
  LIBRARY_STUCK_MS,
  clampLibraryBudget,
  type LibraryAssetPublic,
  type LibraryBuildRequest,
  type LibraryCandidateView,
  type LibraryEntryView,
  type LibraryIndex,
  type LibraryKind,
  type LibraryManifestView,
  type LibraryQuote,
  type LibraryRunSummary,
  type LibraryRunView,
  type LibraryStepView
} from '../../../../shared/comic/library.js';
import { QC_USD_PER_PAGE, getImageModel, imagePriceUsd, libraryAssetCostUsd } from '../../../../shared/comic/models.js';
import { getStylePreset } from '../../../../shared/comic/stylePresets.js';
import { isLibraryPath } from '../storagePaths.js';
import { measureImage } from '../imageMeasure.js';
import { logger } from '../../lib/logger.js';
import { StudioError, type ImageGenerator, type ImageReference, type ImageResult, type LlmClient, type StudioKeys } from '../types.js';
import { ISSUE_LABEL, analyzeLibraryAsset, mergeLibraryScore, type LibraryAnalysisResult, type LibraryIssueCode } from './analyze.js';
import { LIBRARY_MANIFEST, minScoreOf, promptHash, selectEntries, type LibraryManifestEntry } from './manifest.js';
import { encodeLibraryImage, webpDataUrl } from './post.js';
import { REWRITE_USD, editPrompt, planRefine, plannedTextUsd, rewritePrompt, strategyOf, type NextAttempt } from './refine.js';
import { isTableMissing, type LibraryAssetRow, type LibraryCandidate, type LibraryRepo, type LibraryRunRequest, type LibraryRunRow } from './repo.js';

/** A step holds the run this long (≥ the slowest image timeout + analysis); released at the end. */
export const LIBRARY_LEASE_MS = 6 * 60_000;
/** Candidates kept per asset (history for the review drawer). */
export const MAX_CANDIDATES = 12;
/** Art-director note on a regenerate (assets.md §8.1). */
export const MAX_NOTE_CHARS = 300;

export interface LibraryStorage {
  /** Write one object on the library lane (public bucket, 1-year immutable cache). */
  put(path: string, buffer: Buffer, contentType: string): Promise<void>;
  /** data: URL of a stored library object (edit passes attach the previous candidate). */
  loadDataUrl(path: string): Promise<string>;
  remove(paths: string[]): Promise<void>;
  /** Public URL of an object in the public bucket. */
  publicUrl(path: string): string;
}

export interface LibraryDeps {
  repo: LibraryRepo;
  storage: LibraryStorage;
  /** The PLATFORM's keys (never a user's); null when the server has none. */
  keys: () => StudioKeys | null;
  images: (keys: StudioKeys) => ImageGenerator;
  llm: (keys: StudioKeys) => LlmClient;
  now: () => number;
  bucket: string;
  version?: number;
  manifest?: readonly LibraryManifestEntry[];
  audit?: (input: { actorId?: string | null; action: string; targetType?: string; targetId?: string; detail?: Record<string, unknown> }) => Promise<void>;
  /** Published set changed (invalidate the public index cache). */
  onPublishedChange?: () => void;
}

const versionOf = (deps: LibraryDeps) => deps.version ?? LIBRARY_MANIFEST_VERSION;
const manifestOf = (deps: LibraryDeps) => deps.manifest ?? LIBRARY_MANIFEST;
const entryOf = (deps: LibraryDeps, id: string) => manifestOf(deps).find((e) => e.id === id);
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) || 0 : 0);
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const fmtUsd = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
const badRequest = (message: string) => new StudioError('BAD_REQUEST', message, { status: 400 });

export const libraryObjectPaths = (version: number, id: string, rev: number) => {
  if (!LIBRARY_ID_RE.test(id) || !Number.isInteger(rev) || rev < 1) throw new Error('library: bad id or rev');
  const base = `library/v${version}/${id}/${rev}`;
  return { full: `${base}.webp`, 640: `${base}@640.webp`, 320: `${base}@320.webp` } as const;
};

export const clampRetries = (v: unknown): 0 | 1 | 2 => (v === 0 || v === 1 || v === 2 ? v : LIBRARY_MAX_RETRIES as 0 | 1 | 2);

/** Est. cost of the next attempt of an entry (image + vision, + a rewrite when one is planned). */
export const attemptEstimateUsd = (entry: Pick<LibraryManifestEntry, 'model' | 'resolution'>, next?: NextAttempt | null): number =>
  round4(libraryAssetCostUsd(entry.model, entry.resolution) + plannedTextUsd(next));

/** Admin note → a safe prompt suffix (printable, ≤ 300 chars, no artist/brand names). */
export function cleanNote(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw badRequest('The note must be text.');
  const note = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
  if (!note) return undefined;
  if (LIBRARY_IP_BLOCKLIST.test(note)) throw badRequest("Notes can't name artists, studios or brands; describe the look instead.");
  return note;
}

/** The attempt's base prompt: the manifest prompt plus the admin's note (regenerate runs). */
export const basePromptFor = (entry: LibraryManifestEntry, note?: string): string => (note ? `${entry.prompt}\nArt director note: ${note}` : entry.prompt);

// ── Quote (pure: no spend, no writes) ────────────────────────────────────────

interface QuotePlan {
  quote: LibraryQuote;
  todo: LibraryManifestEntry[];
  rows: Map<string, LibraryAssetRow>;
  tableReady: boolean;
}

export const skipReason = (entry: LibraryManifestEntry, row: LibraryAssetRow | undefined, force: boolean): string | null => {
  if (!row || force) return null;
  if (row.prompt_hash !== promptHash(entry)) return null;
  if (row.status === 'published' && row.published) return 'Published and up to date';
  if (row.status === 'needs_review') return 'Waiting for your review (publish, reject or regenerate it)';
  if (row.status === 'rejected') return 'Rejected (use Regenerate to try again)';
  return null;
};

async function loadRows(deps: LibraryDeps, opts: { tolerateMissing: boolean }): Promise<{ rows: Map<string, LibraryAssetRow>; tableReady: boolean }> {
  try {
    const list = await deps.repo.listAssets(versionOf(deps));
    return { rows: new Map(list.map((r) => [r.id, r])), tableReady: true };
  } catch (err) {
    if (opts.tolerateMissing && (isTableMissing(err) || (err instanceof StudioError && err.code === 'NOT_AVAILABLE'))) return { rows: new Map(), tableReady: false };
    throw err;
  }
}

export async function planQuote(deps: LibraryDeps, req: LibraryBuildRequest, opts: { tolerateMissing?: boolean } = {}): Promise<QuotePlan> {
  const sel = selectEntries(req, manifestOf(deps));
  if (sel.unknown.length) throw badRequest(`Unknown library ids: ${sel.unknown.slice(0, 5).join(', ')}.`);
  const entries = sel.entries;
  const { rows, tableReady } = await loadRows(deps, { tolerateMissing: opts.tolerateMissing ?? true });
  const maxRetries = clampRetries(req.maxRetries);
  const todo: LibraryManifestEntry[] = [];
  const skipped: LibraryQuote['skipped'] = [];
  for (const e of entries) {
    const reason = skipReason(e, rows.get(e.id), req.force === true);
    if (reason) skipped.push({ id: e.id, reason });
    else todo.push(e);
  }
  const lines = new Map<LibraryKind, { kind: LibraryKind; count: number; usd: number }>();
  let usd = 0;
  let worst = 0;
  for (const e of todo) {
    const unit = libraryAssetCostUsd(e.model, e.resolution);
    usd += unit;
    worst += unit * (1 + maxRetries) + (maxRetries >= 2 ? REWRITE_USD : 0);
    const line = lines.get(e.kind) || { kind: e.kind, count: 0, usd: 0 };
    line.count += 1;
    line.usd = round4(line.usd + unit);
    lines.set(e.kind, line);
  }
  return {
    quote: { usd: round4(usd), worstCaseUsd: round4(worst), images: todo.length, lines: [...lines.values()], skipped },
    todo,
    rows,
    tableReady
  };
}

// ── Views ────────────────────────────────────────────────────────────────────

const candidateView = (deps: LibraryDeps, row: LibraryAssetRow, c: LibraryCandidate): LibraryCandidateView => ({
  rev: c.rev,
  url: deps.storage.publicUrl(c.path),
  ...(c.thumbs?.[320] ? { thumb: deps.storage.publicUrl(c.thumbs[320]) } : {}),
  w: c.w,
  h: c.h,
  score: c.score,
  issues: c.issues || [],
  strategy: c.strategy,
  at: c.at,
  ...(c.caption ? { caption: c.caption } : {}),
  ...(c.alt ? { alt: c.alt } : {}),
  ...(c.tags?.length ? { tags: c.tags } : {}),
  ...(c.palette?.length ? { palette: c.palette } : {}),
  ...(c.textFound?.length ? { textFound: c.textFound } : {}),
  current: c.hash === row.prompt_hash
});

export function entryView(deps: LibraryDeps, e: LibraryManifestEntry, row?: LibraryAssetRow): LibraryEntryView {
  const hash = promptHash(e);
  const view: LibraryEntryView = {
    id: e.id,
    kind: e.kind,
    model: e.model,
    resolution: e.resolution,
    aspect: e.aspect,
    theme: e.theme,
    ...(e.presetId ? { presetId: e.presetId } : {}),
    ...(e.genre ? { genre: e.genre } : {}),
    ...(e.optional ? { optional: true } : {}),
    promptHash: hash,
    alt: e.alt,
    estimateUsd: libraryAssetCostUsd(e.model, e.resolution)
  };
  if (row) {
    const latest = row.candidates.find((c) => c.rev === row.rev);
    view.row = {
      status: row.status,
      ...(typeof row.score === 'number' ? { score: row.score } : {}),
      rev: row.rev,
      attempts: row.attempts,
      costUsd: round4(row.cost_usd || 0),
      issues: latest?.issues?.slice(0, 6) || [],
      ...(row.path ? { url: deps.storage.publicUrl(row.path) } : {}),
      ...(row.thumb_paths?.[320] ? { thumb: deps.storage.publicUrl(row.thumb_paths[320]) } : {}),
      upToDate: row.prompt_hash === hash,
      ...(row.published
        ? {
            published: {
              rev: row.published.rev,
              url: deps.storage.publicUrl(row.published.path),
              ...(row.published.thumbs?.[320] ? { thumb: deps.storage.publicUrl(row.published.thumbs[320]) } : {}),
              at: row.published.at
            }
          }
        : {}),
      ...(row.error ? { error: row.error } : {}),
      candidates: [...row.candidates].sort((a, b) => b.rev - a.rev).map((c) => candidateView(deps, row, c))
    };
  }
  return view;
}

const lastIssueOf = (row: LibraryAssetRow): string | undefined => {
  if (row.error) return row.error;
  const latest = row.candidates.find((c) => c.rev === row.rev) || row.candidates[row.candidates.length - 1];
  const code = latest?.codes?.[0] as LibraryIssueCode | undefined;
  return code ? ISSUE_LABEL[code] || latest?.issues?.[0] : latest?.issues?.[0];
};

export function runView(run: LibraryRunRow, rows: Map<string, LibraryAssetRow>): LibraryRunView {
  const counts = { total: run.asset_ids.length, done: 0, published: 0, review: 0, failed: 0, skipped: 0, pending: 0 };
  const assets: LibraryRunView['assets'] = [];
  for (const id of run.asset_ids) {
    const r = rows.get(id);
    if (!r || r.run_id !== run.id) {
      counts.skipped += 1;
      counts.done += 1;
      assets.push({ id, status: r?.status ?? 'pending', attempts: r?.attempts ?? 0, lastIssue: 'Moved to a later build' });
      continue;
    }
    switch (r.status) {
      case 'published':
        counts.published += 1;
        counts.done += 1;
        break;
      case 'needs_review':
        counts.review += 1;
        counts.done += 1;
        break;
      case 'failed':
        counts.failed += 1;
        counts.done += 1;
        break;
      case 'rejected':
        counts.skipped += 1;
        counts.done += 1;
        break;
      default:
        counts.pending += 1;
    }
    const issue = r.status === 'published' ? undefined : lastIssueOf(r);
    assets.push({ id, status: r.status, attempts: r.attempts, ...(typeof r.score === 'number' ? { score: r.score } : {}), ...(issue ? { lastIssue: issue } : {}) });
  }
  return { id: run.id, status: run.status, budgetUsd: round4(run.budget_usd), spentUsd: round4(run.spent_usd), counts, assets };
}

export const runSummary = (run: LibraryRunRow): LibraryRunSummary => ({
  id: run.id,
  status: run.status,
  budgetUsd: round4(run.budget_usd),
  spentUsd: round4(run.spent_usd),
  total: run.asset_ids.length,
  done: typeof run.counts?.done === 'number' ? run.counts.done : 0,
  startedAt: ms(run.started_at),
  ...(run.finished_at ? { finishedAt: ms(run.finished_at) } : {}),
  ...(run.error ? { error: run.error } : {})
});

async function loadRunView(deps: LibraryDeps, run: LibraryRunRow): Promise<LibraryRunView> {
  const { rows } = await loadRows(deps, { tolerateMissing: false });
  return runView(run, rows);
}

export async function getRunView(deps: LibraryDeps, runId: string): Promise<LibraryRunView> {
  const run = await deps.repo.getRun(runId);
  if (!run || run.manifest_version !== versionOf(deps)) throw new StudioError('NOT_FOUND', 'That library build was not found.', { status: 404 });
  return loadRunView(deps, run);
}

export async function manifestView(deps: LibraryDeps): Promise<LibraryManifestView> {
  const { rows, tableReady } = await loadRows(deps, { tolerateMissing: true });
  let activeRun: LibraryRunView | undefined;
  let lastRun: LibraryRunSummary | undefined;
  if (tableReady) {
    const active = await deps.repo.activeRun(versionOf(deps));
    if (active) activeRun = runView(active, rows);
    const recent = await deps.repo.listRuns(versionOf(deps), 1);
    if (recent[0]) lastRun = runSummary(recent[0]);
  }
  return {
    manifestVersion: versionOf(deps),
    bucket: deps.bucket,
    platformKey: !!deps.keys(),
    tableReady,
    entries: manifestOf(deps).map((e) => entryView(deps, e, rows.get(e.id))),
    ...(activeRun ? { activeRun } : {}),
    ...(lastRun ? { lastRun } : {})
  };
}

// ── Public index ─────────────────────────────────────────────────────────────

export async function publicIndex(deps: LibraryDeps): Promise<{ index: LibraryIndex; etag: string }> {
  const rows = await deps.repo.listPublished(versionOf(deps));
  const manifest = manifestOf(deps);
  const assets: LibraryAssetPublic[] = [];
  let generatedAt = 0;
  const order = (id: string) => {
    const i = manifest.findIndex((m) => m.id === id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  for (const r of rows.sort((a, b) => order(a.id) - order(b.id))) {
    const p = r.published;
    if (!p || !isLibraryPath(p.path)) continue;
    const e = manifest.find((m) => m.id === r.id);
    generatedAt = Math.max(generatedAt, p.at || 0);
    assets.push({
      id: r.id,
      kind: e?.kind ?? r.kind,
      ...((e?.presetId ?? r.preset_id) ? { presetId: (e?.presetId ?? r.preset_id) as string } : {}),
      ...((e?.genre ?? r.genre) ? { genre: (e?.genre ?? r.genre) as string } : {}),
      theme: e?.theme ?? r.theme,
      aspect: (e?.aspect ?? r.aspect) as LibraryAssetPublic['aspect'],
      w: p.w,
      h: p.h,
      url: deps.storage.publicUrl(p.path),
      thumbs: {
        ...(p.thumbs?.[320] ? { 320: deps.storage.publicUrl(p.thumbs[320]) } : {}),
        ...(p.thumbs?.[640] ? { 640: deps.storage.publicUrl(p.thumbs[640]) } : {})
      },
      alt: p.alt || e?.alt || '',
      ...(p.caption ? { caption: p.caption } : {}),
      tags: p.tags || [],
      palette: p.palette || [],
      rev: p.rev
    });
  }
  const index: LibraryIndex = { manifestVersion: versionOf(deps), generatedAt, assets };
  return { index, etag: hashString(JSON.stringify(index)) };
}

// ── Runs ─────────────────────────────────────────────────────────────────────

const requireKeys = (deps: LibraryDeps): StudioKeys => {
  const keys = deps.keys();
  if (!keys) throw new StudioError('NOT_AVAILABLE', "The platform image key isn't configured on the server.", { status: 503 });
  return keys;
};

const freshRow = (deps: LibraryDeps, e: LibraryManifestEntry, existing: LibraryAssetRow | undefined, runId: string): LibraryAssetRow => {
  const now = iso(deps.now());
  return {
    manifest_version: versionOf(deps),
    id: e.id,
    kind: e.kind,
    status: 'pending',
    theme: e.theme,
    preset_id: e.presetId ?? null,
    genre: e.genre ?? null,
    prompt: e.prompt,
    prompt_hash: promptHash(e),
    final_prompt: existing?.final_prompt ?? null,
    model: e.model,
    resolution: e.resolution,
    aspect: e.aspect,
    rev: existing?.rev ?? 0,
    rev_seq: Math.max(existing?.rev_seq ?? 0, existing?.rev ?? 0, ...(existing?.candidates || []).map((c) => c.rev)),
    path: existing?.path ?? null,
    thumb_paths: existing?.thumb_paths ?? {},
    width: existing?.width ?? null,
    height: existing?.height ?? null,
    bytes: existing?.bytes ?? null,
    alt: e.alt,
    caption: existing?.caption ?? null,
    tags: [...e.tags],
    palette: existing?.palette ?? [],
    score: existing?.score ?? null,
    analysis: existing?.analysis ?? {},
    candidates: existing?.candidates ?? [],
    attempts: 0,
    cost_usd: existing?.cost_usd ?? 0,
    error: null,
    run_id: runId,
    next_step: null,
    published: existing?.published ?? null,
    reviewed_by: existing?.reviewed_by ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    published_at: existing?.published_at ?? null
  };
};

export interface StartRunResult {
  run: LibraryRunView | null;
  quote: LibraryQuote;
  message: string;
}

/**
 * Create a run (the admin's explicit "Build library" / "Regenerate" click). It spends nothing:
 * the console then drives it with `step`. 409 while another run is running; 503 without a
 * platform key or before the tables exist.
 */
export async function startRun(
  deps: LibraryDeps,
  req: LibraryBuildRequest & { note?: string },
  adminId: string
): Promise<StartRunResult> {
  requireKeys(deps);
  const note = cleanNote(req.note);
  const plan = await planQuote(deps, req, { tolerateMissing: false });
  if (!plan.todo.length) {
    return {
      run: null,
      quote: plan.quote,
      message: plan.quote.skipped.length
        ? 'Nothing to build: everything selected is published and up to date, waiting for review, or rejected. Use Force rebuild to redraw.'
        : 'Nothing selected to build.'
    };
  }
  const now = deps.now();
  const request: LibraryRunRequest = {
    ...(req.ids?.length ? { ids: req.ids.slice(0, 200) } : {}),
    ...(req.kinds?.length ? { kinds: req.kinds } : {}),
    ...(req.force ? { force: true } : {}),
    ...(req.includeOptional ? { includeOptional: true } : {}),
    maxRetries: clampRetries(req.maxRetries),
    ...(note ? { note } : {})
  };
  const run: LibraryRunRow = {
    id: randomUUID(),
    manifest_version: versionOf(deps),
    started_by: adminId,
    status: 'running',
    budget_usd: clampLibraryBudget(req.budgetUsd ?? LIBRARY_BUDGET_DEFAULT_USD),
    spent_usd: 0,
    request,
    quote: plan.quote,
    asset_ids: plan.todo.map((e) => e.id),
    counts: { total: plan.todo.length, done: 0, pending: plan.todo.length },
    lease_until: null,
    steps: 0,
    error: null,
    started_at: iso(now),
    updated_at: iso(now),
    finished_at: null
  };
  await deps.repo.insertRun(run); // 409 CONFLICT when another run is running (unique index)
  try {
    for (const e of plan.todo) await deps.repo.upsertAsset(freshRow(deps, e, plan.rows.get(e.id), run.id));
  } catch (err) {
    await deps.repo.updateRun(run.id, { status: 'failed', error: "The build couldn't be prepared. Nothing was spent; try again.", finished_at: iso(deps.now()) });
    throw err;
  }
  await deps.audit?.({ actorId: adminId, action: 'comic.library.run_start', targetType: 'library_runs', targetId: run.id, detail: { assets: run.asset_ids.length, budgetUsd: run.budget_usd, quoteUsd: plan.quote.usd, note: !!note } });
  const view = await loadRunView(deps, run);
  return {
    run: view,
    quote: plan.quote,
    message: `Build ready: ${run.asset_ids.length} image${run.asset_ids.length === 1 ? '' : 's'}, about ${fmtUsd(plan.quote.usd)} (at most ${fmtUsd(Math.min(plan.quote.worstCaseUsd, run.budget_usd))} with refines, budget ${fmtUsd(run.budget_usd)}).`
  };
}

export async function cancelRun(deps: LibraryDeps, runId: string, adminId: string): Promise<LibraryRunView> {
  const run = await deps.repo.getRun(runId);
  if (!run || run.manifest_version !== versionOf(deps)) throw new StudioError('NOT_FOUND', 'That library build was not found.', { status: 404 });
  if (run.status === 'running') {
    await deps.repo.updateRun(runId, { status: 'cancelled', finished_at: iso(deps.now()), lease_until: null }, { status: 'running' });
    await deps.audit?.({ actorId: adminId, action: 'comic.library.run_cancel', targetType: 'library_runs', targetId: runId, detail: { spentUsd: run.spent_usd } });
  }
  return getRunView(deps, runId);
}

// ── One attempt ──────────────────────────────────────────────────────────────

interface AttemptOutcome {
  id: string;
  spent: number;
  status: LibraryAssetRow['status'];
  score?: number;
  note: string;
  /** Stops the whole run (no key, billing refused). */
  fatal?: StudioError;
  rateLimited?: boolean;
}

const unionTags = (a: string[], b?: string[]) => [...new Set([...a, ...(b || []).filter((t) => !LIBRARY_IP_BLOCKLIST.test(t))])].slice(0, 16);
const safeText = (s: string | undefined, n: number) => (s && !LIBRARY_IP_BLOCKLIST.test(s) ? s.slice(0, n) : undefined);

/**
 * Best candidate this run drew from the CURRENT prompt (ties → the newest). Earlier runs' images
 * never win automatically: a rebuild that comes out worse goes to review while the previously
 * published image stays live.
 */
export const bestCandidate = (row: Pick<LibraryAssetRow, 'prompt_hash'>, candidates: LibraryCandidate[], runId: string): LibraryCandidate | undefined =>
  candidates
    .filter((c) => c.hash === row.prompt_hash && c.runId === runId)
    .reduce<LibraryCandidate | undefined>((best, c) => (!best || c.score >= best.score ? c : best), undefined);

/** Row fields that point at a candidate (+ the published snapshot when it passes). */
const settlePatch = (deps: LibraryDeps, entry: LibraryManifestEntry, row: LibraryAssetRow, best: LibraryCandidate, publish: boolean, reviewer?: string): Partial<LibraryAssetRow> => {
  const now = deps.now();
  return {
    rev: best.rev,
    path: best.path,
    thumb_paths: best.thumbs,
    width: best.w,
    height: best.h,
    bytes: best.bytes,
    score: best.score,
    caption: best.caption ?? null,
    tags: unionTags(entry.tags, best.tags),
    palette: best.palette || [],
    next_step: null,
    status: publish ? 'published' : 'needs_review',
    ...(publish
      ? {
          published: {
            rev: best.rev,
            path: best.path,
            thumbs: best.thumbs,
            w: best.w,
            h: best.h,
            alt: entry.alt,
            ...(best.caption ? { caption: best.caption } : {}),
            tags: unionTags(entry.tags, best.tags),
            palette: best.palette || [],
            at: now
          },
          published_at: iso(now),
          ...(reviewer ? { reviewed_by: reviewer } : {})
        }
      : {})
  };
};

async function attemptOne(deps: LibraryDeps, run: LibraryRunRow, row: LibraryAssetRow, entry: LibraryManifestEntry, keys: StudioKeys, adminId: string): Promise<AttemptOutcome> {
  const v = versionOf(deps);
  const spec = getImageModel(entry.model);
  const maxAttempts = 1 + clampRetries(run.request.maxRetries);
  const next: NextAttempt = row.next_step ?? { strategy: 'first' };
  const base = basePromptFor(entry, run.request.note);
  const meta = { runId: run.id, assetId: entry.id, attempt: row.attempts };
  let spent = 0;
  const update = (patch: Partial<LibraryAssetRow>) => deps.repo.updateAsset(v, entry.id, { ...patch, cost_usd: round4((row.cost_usd || 0) + spent) }, { runId: run.id });

  const settle = async (candidates: LibraryCandidate[], error: string | null): Promise<AttemptOutcome> => {
    const best = bestCandidate(row, candidates, run.id);
    if (!best) {
      await update({ status: 'failed', next_step: null, error: error || 'No image came back.', candidates });
      return { id: entry.id, spent, status: 'failed', note: error || 'failed' };
    }
    const publish = best.score >= minScoreOf(entry);
    await update({ ...settlePatch(deps, entry, row, best, publish), candidates, error: publish ? null : error });
    if (publish) deps.onPublishedChange?.();
    return { id: entry.id, spent, status: publish ? 'published' : 'needs_review', score: best.score, note: publish ? `published (${best.score.toFixed(2)})` : 'needs your review' };
  };

  if (!spec) return settle(row.candidates, `Unknown image model ${entry.model}.`);

  // 1. What to send this attempt.
  let prompt = base;
  let references: ImageReference[] = [];
  try {
    if (next.strategy === 'regenerate') prompt = next.prompt;
    else if (next.strategy === 'rewrite') {
      const rw = await rewritePrompt(deps.llm(keys), { entry, prompt: next.prompt, issues: next.issues, styleSpec: getStylePreset(entry.presetId)?.spec });
      const cost = typeof rw.costUsd === 'number' ? rw.costUsd : rw.model ? REWRITE_USD : 0;
      if (cost > 0) {
        spent += cost;
        await deps.repo.recordCost({ userId: adminId, stage: 'library_rewrite', provider: 'platform', model: rw.model, costUsd: cost, metadata: meta });
      }
      prompt = rw.prompt;
    } else if (next.strategy === 'edit') {
      // The ONLY image ever attached: this asset's own previous library candidate.
      const from = row.candidates.find((c) => c.rev === next.fromRev);
      if (from && isLibraryPath(from.path)) {
        references = [{ label: 'CURRENT IMAGE', dataUrl: await deps.storage.loadDataUrl(from.path) }];
        prompt = editPrompt(entry, next.instruction);
      }
    }
  } catch (err) {
    logger.warn('comic_library_attempt_prepare_failed', { id: entry.id, message: (err as Error)?.message });
    prompt = base;
    references = [];
  }

  // 2. Generate.
  let result: ImageResult;
  try {
    result = await deps.images(keys)({ spec, resolution: entry.resolution, aspect: entry.aspect, prompt, references });
  } catch (err) {
    const e = err as StudioError & { abandoned?: boolean; spentUsd?: number };
    let cost = typeof e.spentUsd === 'number' && e.spentUsd > 0 ? e.spentUsd : 0;
    if (e.abandoned) cost = Math.max(cost, imagePriceUsd(spec, entry.resolution));
    if (cost > 0) {
      spent += cost;
      await deps.repo.recordCost({ userId: adminId, stage: 'library_image', provider: 'platform', model: spec.id, costUsd: cost, metadata: { ...meta, failed: e.code || 'error', abandoned: !!e.abandoned } });
    }
    const message = err instanceof StudioError ? err.userMessage : 'The image request failed.';
    if (err instanceof StudioError && (err.code === 'NO_IMAGE_KEY' || err.code === 'BILLING_DENIED')) {
      await update({ status: 'pending', attempts: Math.max(0, row.attempts - 1), error: message });
      return { id: entry.id, spent, status: 'pending', note: message, fatal: err };
    }
    if (err instanceof StudioError && err.code === 'SAFETY_BLOCKED') {
      return settle(row.candidates, 'The image model declined this prompt. The manifest prompt needs a human edit.');
    }
    if (e.abandoned) {
      // Our own deadline fired after the provider likely drew (and billed) it: never auto-retried.
      return settle(row.candidates, 'The image model timed out after it was asked to draw (billed), so it is not retried automatically. Regenerate to try again.');
    }
    if (row.attempts < maxAttempts) {
      await update({ status: 'pending', error: message });
      return { id: entry.id, spent, status: 'pending', note: message, rateLimited: err instanceof StudioError && err.code === 'RATE_LIMIT' };
    }
    return settle(row.candidates, message);
  }
  const imageCost = typeof result.costUsd === 'number' && result.costUsd > 0 ? result.costUsd : imagePriceUsd(spec, entry.resolution);
  spent += imageCost;
  await deps.repo.recordCost({ userId: adminId, stage: 'library_image', provider: result.route || 'platform', model: result.model || spec.id, costUsd: imageCost, metadata: { ...meta, strategy: next.strategy } });

  // 3. Encode, store, measure, analyze.
  try {
    const rev = row.rev_seq;
    const enc = await encodeLibraryImage(result.dataUrl, { seamless: entry.post === 'seamless_tile' });
    const paths = libraryObjectPaths(v, entry.id, rev);
    await deps.storage.put(paths.full, enc.full, 'image/webp');
    await deps.storage.put(paths[640], enc.thumbs[640], 'image/webp');
    await deps.storage.put(paths[320], enc.thumbs[320], 'image/webp');
    await update({ status: 'analyzing', final_prompt: prompt.slice(0, 6000) });

    const measure = await measureImage(enc.full, entry.aspect, { texture: entry.kind === 'texture_seed' });
    let analysis: LibraryAnalysisResult = { fellBack: true, model: '' };
    try {
      analysis = await analyzeLibraryAsset(deps.llm(keys), { entry, prompt, dataUrl: webpDataUrl(enc.thumbs[640]) });
    } catch (err) {
      logger.warn('comic_library_analysis_failed', { id: entry.id, message: (err as Error)?.message });
    }
    const visionCost = typeof analysis.costUsd === 'number' ? analysis.costUsd : analysis.model ? QC_USD_PER_PAGE : 0;
    if (visionCost > 0) {
      spent += visionCost;
      await deps.repo.recordCost({ userId: adminId, stage: 'library_vision', provider: 'platform', model: analysis.model, costUsd: visionCost, metadata: meta });
    }
    const merged = mergeLibraryScore(entry, measure, analysis.report);
    const candidate: LibraryCandidate = {
      rev,
      path: paths.full,
      thumbs: { 640: paths[640], 320: paths[320] },
      w: enc.w,
      h: enc.h,
      bytes: enc.bytes,
      score: merged.score,
      issues: merged.notes,
      codes: merged.codes,
      strategy: strategyOf(next),
      hash: row.prompt_hash,
      runId: run.id,
      at: deps.now(),
      ...(safeText(analysis.report?.caption, 160) ? { caption: safeText(analysis.report?.caption, 160) } : {}),
      ...(safeText(analysis.report?.altText, 140) ? { alt: safeText(analysis.report?.altText, 140) } : {}),
      ...(analysis.report?.tags?.length ? { tags: analysis.report.tags.filter((t) => !LIBRARY_IP_BLOCKLIST.test(t)).slice(0, 12) } : {}),
      palette: measure.palette,
      ...(analysis.report?.textFound?.length ? { textFound: analysis.report.textFound.slice(0, 12) } : {}),
      costUsd: round4(spent)
    };
    const candidates = [...row.candidates, candidate].slice(-MAX_CANDIDATES);
    const analysisDoc = {
      measure: { w: measure.w, h: measure.h, aspectOk: measure.aspectOk, meanLuma: measure.meanLuma, blank: measure.blank, edgeSeamDelta: measure.edgeSeamDelta },
      scores: merged.scores,
      score: merged.score,
      codes: merged.codes,
      issues: merged.notes,
      model: analysis.model,
      fellBack: analysis.fellBack,
      checkedAt: deps.now()
    };
    if (merged.passed) {
      const out = await settle(candidates, null);
      await deps.repo.updateAsset(v, entry.id, { analysis: analysisDoc }, { runId: run.id });
      return out;
    }
    const blankBefore = row.candidates.some((c) => c.runId === run.id && c.codes?.includes('blank'));
    const plan = planRefine(entry, merged, { attempt: row.attempts, maxAttempts, basePrompt: base, rev, blankBefore });
    if (plan.strategy === 'stop') {
      const out = await settle(candidates, plan.reason);
      await deps.repo.updateAsset(v, entry.id, { analysis: analysisDoc }, { runId: run.id });
      return out;
    }
    // Show the newest candidate while the next attempt waits its turn.
    await update({
      status: 'pending',
      next_step: plan,
      candidates,
      rev,
      path: paths.full,
      thumb_paths: { 640: paths[640], 320: paths[320] },
      width: enc.w,
      height: enc.h,
      bytes: enc.bytes,
      score: merged.score,
      analysis: analysisDoc,
      error: null
    });
    return { id: entry.id, spent, status: 'pending', score: merged.score, note: `scored ${merged.score.toFixed(2)}; next: ${plan.strategy}` };
  } catch (err) {
    const message = err instanceof StudioError ? err.userMessage : "The image came back but couldn't be stored.";
    logger.warn('comic_library_attempt_failed', { id: entry.id, message: (err as Error)?.message });
    if (row.attempts < maxAttempts) {
      await update({ status: 'pending', error: message });
      return { id: entry.id, spent, status: 'pending', note: message };
    }
    return settle(row.candidates, message);
  }
}

// ── Step ─────────────────────────────────────────────────────────────────────

const ACTIVE = new Set(['pending', 'generating', 'analyzing']);

/**
 * Advance a run by at most `n` (1–3) assets, one attempt each. Idempotent and resumable: a
 * second concurrent call answers `busy`; a finished run answers its final view; rows stuck in
 * generating/analyzing for over 10 minutes are reset first.
 */
export async function stepRun(deps: LibraryDeps, runId: string, nRaw: unknown, adminId: string): Promise<LibraryStepView> {
  const n = typeof nRaw === 'number' && Number.isFinite(nRaw) ? Math.max(1, Math.min(LIBRARY_STEP_MAX, Math.floor(nRaw))) : LIBRARY_STEP_MAX;
  const v = versionOf(deps);
  const run = await deps.repo.getRun(runId);
  if (!run || run.manifest_version !== v) throw new StudioError('NOT_FOUND', 'That library build was not found.', { status: 404 });
  if (run.status !== 'running') {
    const view = await loadRunView(deps, run);
    return { ...view, message: `This build is ${run.status.replace('_', ' ')}.`, waitMs: 0 };
  }
  const keys = requireKeys(deps);
  const now = deps.now();
  if (!(await deps.repo.acquireLease(runId, iso(now), iso(now + LIBRARY_LEASE_MS)))) {
    const view = await loadRunView(deps, run);
    return { ...view, busy: true, message: 'Another step is still drawing; waiting for it to finish.', waitMs: 4000 };
  }
  let spentThisStep = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const bumpSpent = (add: number) => {
    spentThisStep += add;
    const total = round4(run.spent_usd + spentThisStep);
    chain = chain.then(() => deps.repo.updateRun(runId, { spent_usd: total })).catch(() => undefined);
    return chain;
  };
  try {
    await deps.repo.updateRun(runId, { steps: run.steps + 1 });
    const reset = await deps.repo.resetStuck(v, runId, iso(now - LIBRARY_STUCK_MS));
    const { rows } = await loadRows(deps, { tolerateMissing: false });
    const mine = run.asset_ids
      .map((id) => rows.get(id))
      .filter((r): r is LibraryAssetRow => !!r && r.run_id === runId)
      .sort((a, b) => run.asset_ids.indexOf(a.id) - run.asset_ids.indexOf(b.id));

    // Pick ≤ n pending assets whose next attempt still fits the budget, and claim them.
    const picks: { row: LibraryAssetRow; entry: LibraryManifestEntry }[] = [];
    let reserved = 0;
    let budgetBlocked = false;
    for (const r of mine) {
      if (picks.length >= n) break;
      if (r.status !== 'pending') continue;
      const entry = entryOf(deps, r.id);
      if (!entry) {
        await deps.repo.updateAsset(v, r.id, { status: 'failed', error: 'No longer in the manifest.', next_step: null }, { runId });
        continue;
      }
      const est = attemptEstimateUsd(entry, r.next_step);
      if (run.spent_usd + reserved + est > run.budget_usd + 1e-9) {
        budgetBlocked = true;
        continue;
      }
      const claim: Partial<LibraryAssetRow> = { status: 'generating', attempts: r.attempts + 1, rev_seq: (r.rev_seq || 0) + 1, error: null };
      if (await deps.repo.updateAsset(v, r.id, claim, { status: ['pending'], runId })) {
        picks.push({ row: { ...r, ...claim } as LibraryAssetRow, entry });
        reserved += est;
      }
    }

    const outcomes = await Promise.all(
      picks.map(async (p) => {
        const out = await attemptOne(deps, run, p.row, p.entry, keys, adminId).catch(
          (err): AttemptOutcome => {
            logger.error('comic_library_attempt_crashed', { id: p.entry.id, message: (err as Error)?.message });
            return { id: p.entry.id, spent: 0, status: 'pending', note: 'crashed' };
          }
        );
        await bumpSpent(out.spent);
        return out;
      })
    );
    await chain;

    // Settle the run.
    const { rows: after } = await loadRows(deps, { tolerateMissing: false });
    const fresh: LibraryRunRow = { ...run, spent_usd: round4(run.spent_usd + spentThisStep) };
    let view = runView(fresh, after);
    const fatal = outcomes.find((o) => o.fatal)?.fatal;
    const inFlight = run.asset_ids.some((id) => {
      const r = after.get(id);
      return !!r && r.run_id === runId && (r.status === 'generating' || r.status === 'analyzing');
    });
    const remaining = view.counts.pending;
    let status: LibraryRunRow['status'] = 'running';
    let error: string | null = null;
    if (fatal) {
      status = 'failed';
      error = fatal.userMessage;
    } else if (remaining === 0) status = 'completed';
    else if (!picks.length && budgetBlocked && !inFlight) {
      status = 'budget_exhausted';
      error = `The budget of ${fmtUsd(run.budget_usd)} is used up (${fmtUsd(fresh.spent_usd)} spent). Start a new build to continue.`;
    }
    let finished = status !== 'running';
    // Real spend and progress are always recorded; the final status only lands while the run is
    // still running (an admin's Cancel that arrived mid-step is never overwritten by "completed").
    await deps.repo.updateRun(runId, { spent_usd: fresh.spent_usd, counts: view.counts });
    if (finished && !(await deps.repo.updateRun(runId, { status, finished_at: iso(deps.now()), error }, { status: 'running' }))) {
      const latest = await deps.repo.getRun(runId);
      status = latest?.status ?? status;
      error = latest?.error ?? null;
      finished = status !== 'running';
    } else if (!finished) {
      const latest = await deps.repo.getRun(runId);
      if (latest && latest.status !== 'running') {
        status = latest.status;
        finished = true;
      }
    }
    if (finished) {
      view = { ...view, status };
      await deps.audit?.({ actorId: adminId, action: 'comic.library.run_finish', targetType: 'library_runs', targetId: runId, detail: { status, spentUsd: fresh.spent_usd, counts: view.counts } });
    }

    const did = outcomes.map((o) => `${o.id} ${o.note}`).join(' · ');
    const waiting = !picks.length && inFlight && !finished;
    const message = [
      reset ? `Resumed ${reset} interrupted image${reset === 1 ? '' : 's'}.` : '',
      picks.length ? `Drew ${picks.length}: ${did}.` : '',
      waiting ? 'Waiting for an interrupted step to time out (up to 10 minutes).' : '',
      status === 'completed' ? 'Build finished.' : status === 'cancelled' ? 'Build cancelled; images already drawn are kept.' : '',
      error || '',
      `${fmtUsd(fresh.spent_usd)} spent of ${fmtUsd(run.budget_usd)}.`
    ]
      .filter(Boolean)
      .join(' ');
    const waitMs = finished ? 0 : outcomes.some((o) => o.rateLimited) ? 15_000 : waiting ? 30_000 : 0;
    return { ...view, message, waitMs };
  } finally {
    await deps.repo.releaseLease(runId);
  }
}

// ── Review actions ───────────────────────────────────────────────────────────

async function loadEditable(deps: LibraryDeps, id: string): Promise<{ row: LibraryAssetRow; entry: LibraryManifestEntry }> {
  if (!LIBRARY_ID_RE.test(id)) throw badRequest('That is not a library id.');
  const entry = entryOf(deps, id);
  if (!entry) throw new StudioError('NOT_FOUND', 'That asset is not in the library manifest.', { status: 404 });
  const row = await deps.repo.getAsset(versionOf(deps), id);
  if (!row) throw new StudioError('NOT_FOUND', "That asset hasn't been built yet.", { status: 404 });
  if (row.status === 'generating' || row.status === 'analyzing') {
    // A row left mid-attempt by a run that was cancelled (or died) is free once no step can still
    // hold it (the step lease has run out); while its run is running it belongs to that run.
    const run = row.run_id ? await deps.repo.getRun(row.run_id) : null;
    const dead = (!run || run.status !== 'running') && deps.now() - ms(row.updated_at) > LIBRARY_LEASE_MS;
    if (!dead) {
      throw new StudioError(
        'CONFLICT',
        run?.status === 'running'
          ? 'This asset is being drawn right now. Try again when the step finishes.'
          : 'This asset is finishing its last attempt. Try again in a few minutes.',
        { status: 409 }
      );
    }
  }
  return { row, entry };
}

export async function publishAsset(deps: LibraryDeps, id: string, revRaw: unknown, adminId: string): Promise<LibraryEntryView> {
  const { row, entry } = await loadEditable(deps, id);
  const rev = revRaw === undefined || revRaw === null ? row.rev : Number(revRaw);
  const cand = Number.isInteger(rev) ? row.candidates.find((c) => c.rev === rev) : undefined;
  if (!cand) throw new StudioError('NOT_FOUND', 'That candidate no longer exists.', { status: 404 });
  const patch = { ...settlePatch(deps, entry, row, cand, true, adminId), error: null };
  await deps.repo.updateAsset(versionOf(deps), id, patch);
  deps.onPublishedChange?.();
  await deps.audit?.({ actorId: adminId, action: 'comic.library.publish', targetType: 'library_assets', targetId: id, detail: { rev: cand.rev, score: cand.score } });
  return entryView(deps, entry, { ...row, ...patch } as LibraryAssetRow);
}

/**
 * Reject the asset's current candidate. When that candidate is the live image it comes down; a
 * weaker rebuild waiting for review is rejected while the earlier published image stays live,
 * unless `opts.unpublish` asks to take the live image down too (e.g. a takedown).
 */
export async function rejectAsset(
  deps: LibraryDeps,
  id: string,
  noteRaw: unknown,
  adminId: string,
  opts: { unpublish?: boolean } = {}
): Promise<LibraryEntryView> {
  const { row, entry } = await loadEditable(deps, id);
  const note = typeof noteRaw === 'string' ? noteRaw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_NOTE_CHARS) : '';
  const unpublish = !!row.published && (opts.unpublish === true || row.published.rev === row.rev);
  const patch: Partial<LibraryAssetRow> = {
    status: 'rejected',
    next_step: null,
    reviewed_by: adminId,
    error: note ? `Rejected: ${note}` : 'Rejected by an admin.',
    ...(unpublish ? { published: null, published_at: null } : {})
  };
  await deps.repo.updateAsset(versionOf(deps), id, patch);
  if (unpublish) deps.onPublishedChange?.();
  await deps.audit?.({ actorId: adminId, action: 'comic.library.reject', targetType: 'library_assets', targetId: id, detail: { rev: row.rev, unpublished: unpublish } });
  return entryView(deps, entry, { ...row, ...patch } as LibraryAssetRow);
}

/** A one-asset run (force) with an optional art-director note; the console then steps it. */
export async function regenerateAsset(
  deps: LibraryDeps,
  id: string,
  body: { note?: unknown; budgetUsd?: unknown; maxRetries?: unknown },
  adminId: string
): Promise<StartRunResult> {
  if (!LIBRARY_ID_RE.test(id) || !entryOf(deps, id)) throw new StudioError('NOT_FOUND', 'That asset is not in the library manifest.', { status: 404 });
  const note = cleanNote(body.note);
  return startRun(
    deps,
    {
      ids: [id],
      force: true,
      includeOptional: true,
      budgetUsd: typeof body.budgetUsd === 'number' ? body.budgetUsd : undefined,
      maxRetries: clampRetries(body.maxRetries),
      ...(note ? { note } : {})
    },
    adminId
  );
}

/** Delete stored candidates no row points at (current, published). Refused while a build runs. */
export async function purgeCandidates(deps: LibraryDeps, dryRun: boolean, adminId: string): Promise<{ dryRun: boolean; objects: number; bytes: number }> {
  const v = versionOf(deps);
  if (await deps.repo.activeRun(v)) throw new StudioError('CONFLICT', 'Finish or cancel the running build before purging candidates.', { status: 409 });
  const rows = await deps.repo.listAssets(v);
  const keep = new Set<string>();
  for (const r of rows) {
    if (r.path) keep.add(r.path);
    Object.values(r.thumb_paths || {}).forEach((p) => p && keep.add(p));
    if (r.published) {
      keep.add(r.published.path);
      Object.values(r.published.thumbs || {}).forEach((p) => p && keep.add(p));
    }
  }
  let objects = 0;
  let bytes = 0;
  const doomedByRow = new Map<string, { paths: string[]; revs: Set<number> }>();
  for (const r of rows) {
    for (const c of r.candidates) {
      if (keep.has(c.path)) continue;
      const paths = [c.path, ...Object.values(c.thumbs || {})].filter((p): p is string => !!p && isLibraryPath(p) && !keep.has(p));
      if (!paths.length) continue;
      const entry = doomedByRow.get(r.id) || { paths: [], revs: new Set<number>() };
      entry.paths.push(...paths);
      entry.revs.add(c.rev);
      doomedByRow.set(r.id, entry);
      objects += paths.length;
      bytes += c.bytes || 0;
    }
  }
  if (!dryRun && objects) {
    for (const [id, d] of doomedByRow) {
      for (let i = 0; i < d.paths.length; i += 100) await deps.storage.remove(d.paths.slice(i, i + 100));
      const row = rows.find((r) => r.id === id);
      if (row) await deps.repo.updateAsset(v, id, { candidates: row.candidates.filter((c) => !d.revs.has(c.rev)) });
    }
    await deps.audit?.({ actorId: adminId, action: 'comic.library.purge_candidates', targetType: 'library_assets', detail: { objects, bytes } });
  }
  return { dryRun, objects, bytes };
}
