// The publish gate (safety.md §3.4, sharing.md §8). Owner: P1-SAFETY.
//
// Runs before ANY publication — unlisted and public alike — and covers every published
// language's text. Nothing fails open here: a page, cover or text that could not be checked
// is `unchecked`, the gate answers `needs_check`, and the publisher refuses with 503 "Safety
// checks are unavailable right now". Checks are platform-paid (costUsd is reported, never
// billed to the comic). Verdicts are committed to the live doc so the board shows them.
//
// Two rules close the gaps the gate review found (S13, S14):
//  - EVERY character of the publishable text is read: long text is split into overlapping windows
//    of at most CLASSIFIER_CHARS (so the classifier's head/middle/tail sampling never kicks in),
//    each window is pre-filtered and classified, the strictest answer wins and any window that
//    can't be checked leaves the whole text unchecked (fail closed). Text past a hard cap is
//    refused up front with an honest message, before anything is spent.
//  - A page verdict from render QC is never trusted as-is: the QC call also reads the author's
//    script, so a QC pass is re-rated image-only (checkImage, no author text) on the platform key
//    once and the result committed (by:'check'), so later publishes reuse it at $0.

import {
  findPage,
  type AssetRef,
  type ComicDoc,
  type RenderTarget,
  type SafetyBlocker
} from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import {
  publishableText,
  ratingRank,
  safetyStatusOf,
  type ContentRating,
  type SafetyCategory,
  type SafetyStatus,
  type SafetyVerdict
} from '../../../../shared/comic/safety.js';
import { logger } from '../../lib/logger.js';
import { StudioError, type StudioContext } from '../types.js';
import { SAFETY_CHECK_USD, SAFETY_TEXT_USD, checkImage, classifyText } from './check.js';
import { CLASSIFIER_CHARS, categoryWords, contentHash, prefilterDetail } from './contentPolicy.js';
import { errorFacts, ratingOf, recordDecision, safetyDeps, sha256Hex } from './deps.js';

export interface PublishGateResult {
  status: 'cleared' | 'needs_check' | 'blocked';
  rating: ContentRating;
  pages: Record<string, { status: SafetyStatus; reasons: string[] }>;
  cover: { status: SafetyStatus; reasons: string[] } | null;
  /** Includes published translations. */
  text: { status: SafetyStatus; reasons: string[] };
  checkedHash: string;
  /** Platform-paid. */
  costUsd: number;
}

const PARALLEL = 4;

/** Text repeated at the start of the next window, so words split across a cut are seen whole. */
export const WINDOW_OVERLAP = 2_000;
/**
 * The most publishable text one gate reads (about 17 windows, so about 17 platform text checks
 * per publish whose text changed). Far above a long comic in several languages; past it the publish
 * is refused honestly before any check runs. An owner-tunable cost/latency knob.
 */
export const MAX_GATE_TEXT_CHARS = 16 * CLASSIFIER_CHARS;
export const TOO_MUCH_TEXT_MESSAGE =
  'This comic has more words than the safety check can read at once. Publish fewer languages or shorten some text, then try again.';

/**
 * Consecutive windows of at most `size` characters covering every character of `text`. A window
 * ends between lines when it can (each part of the publishable text is one line), and the next
 * one starts up to `overlap`·2 characters earlier — on a line start when possible — so anything
 * that straddles a cut is read whole. Text of `size` or less is exactly one window.
 */
export function gateWindows(text: string, size = CLASSIFIER_CHARS, overlap = WINDOW_OVERLAP): string[] {
  size = Math.max(1, Math.floor(size));
  overlap = Math.max(0, Math.floor(overlap));
  if (text.length <= size) return [text];
  const out: string[] = [];
  let start = 0;
  for (;;) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end - 1);
      if (nl > start + size / 2) end = nl; // cut at a line break (never a window under half size)
    }
    out.push(text.slice(start, end));
    if (end >= text.length) return out;
    const lineStart = text.lastIndexOf('\n', end - overlap);
    const next = lineStart >= end - 2 * overlap && lineStart + 1 > start ? lineStart + 1 : end - overlap;
    // Always forward: a window too small for the overlap (a retuned size) gets none, never a loop
    // that holds the publish lock forever.
    start = next > start ? next : end;
  }
}

/** Every window pre-filtered: any block blocks (categories of the blocking windows), else any ambiguity is ambiguous. */
function prefilterWindows(windows: string[], rating: ContentRating): { decision: 'block' | 'ambiguous' | 'clear'; categories: SafetyCategory[] } {
  const blocked = new Set<SafetyCategory>();
  let ambiguous = false;
  let block = false;
  for (const w of windows) {
    const pre = prefilterDetail(w, rating);
    if (pre.decision === 'block') {
      block = true;
      pre.categories.forEach((c) => blocked.add(c));
    } else if (pre.decision === 'ambiguous') ambiguous = true;
  }
  return block ? { decision: 'block', categories: [...blocked] } : { decision: ambiguous ? 'ambiguous' : 'clear', categories: [] };
}

/** The stricter of two verdicts (higher rating; X wins), categories merged — never looser than either. */
const stricterVerdict = (a: SafetyVerdict, b: SafetyVerdict): SafetyVerdict => {
  const rank = (v: SafetyVerdict) => (v.assessed ? ratingRank(v.assessed) : -1);
  const top = rank(a) > rank(b) ? a : b;
  const categories = [...new Set([...(a.categories || []), ...(b.categories || [])])];
  return { ...top, ...(categories.length ? { categories } : {}) };
};

/** Owner-facing, neutral reasons for a status (never quotes content). */
export const reasonsFor = (status: SafetyStatus, verdict: SafetyVerdict | undefined, rating: ContentRating): string[] => {
  switch (status) {
    case 'blocked':
      return [`Didn't fit the content rules${verdict?.categories?.length ? ` (${categoryWords(verdict.categories)})` : ''}`, ...(verdict?.notes || [])].slice(0, 3);
    case 'over_rating':
      return [`Rated ${verdict?.assessed} — this comic is ${rating}`, ...(verdict?.notes || [])].slice(0, 3);
    case 'pending':
    case 'unchecked':
      return ["Couldn't be checked right now"];
    default:
      return [];
  }
};

/** The image check for one asset (platform key); undefined when unavailable. */
async function checkAsset(ctx: StudioContext, asset: AssetRef, rating: ContentRating): Promise<{ verdict?: SafetyVerdict; costUsd: number }> {
  const deps = safetyDeps();
  const llm = deps.platformLlm();
  if (!llm || !deps.classifierOn()) return { costUsd: 0 };
  let dataUrl: string;
  try {
    dataUrl = await ctx.assets.previewDataUrl(asset.path, 768);
  } catch {
    try {
      dataUrl = await ctx.assets.loadDataUrl(asset.path);
    } catch {
      return { costUsd: 0 };
    }
  }
  const check = await checkImage(llm, { dataUrl, rating, by: 'check', now: deps.now(), signal: ctx.signal });
  if (!check) return { costUsd: 0 };
  return { verdict: check.verdict, costUsd: check.costUsd ?? SAFETY_CHECK_USD };
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/** Gate a publish (both visibilities, every published language). */
export async function runPublishGateImpl(
  ctx: StudioContext,
  doc: ComicDoc,
  opts: { pageIds: string[]; includeCover: boolean; languages: string[] }
): Promise<PublishGateResult> {
  const deps = safetyDeps();
  const rating = ratingOf(ctx, doc);
  const at = deps.now();
  const ops: DocOp[] = [];
  let costUsd = 0;
  const blockers: SafetyBlocker[] = [];
  const statusesForHash: string[] = [rating];

  // Every publishable word, including the published translations. Measured first: text past the
  // cap is refused before any page or text check is paid for.
  const languages = [...new Set((opts.languages || []).filter((l) => typeof l === 'string' && l && l !== doc.format.language))];
  const words = publishableText(doc, languages);
  if (words.length > MAX_GATE_TEXT_CHARS) {
    logger.info('comic_publish_gate_text_too_long', { projectId: ctx.projectId, chars: words.length });
    throw new StudioError('LIMIT', TOO_MUCH_TEXT_MESSAGE, { status: 409 });
  }

  const judge = async (target: RenderTarget, asset: AssetRef | undefined): Promise<{ status: SafetyStatus; reasons: string[] }> => {
    if (!asset) return { status: 'unchecked', reasons: ['Not drawn yet'] };
    let verdict = asset.safety;
    // A render-QC pass came from the call that also read the author's script (vision.ts), so it is
    // not vouched for until an image-only check agrees (S14). QC blocks and over-ratings stand (a
    // re-check could only loosen them); pre-filter-only operator mode keeps QC verdicts.
    const qcPass = verdict?.by === 'qc' && !verdict.quarantined && deps.classifierOn() && safetyStatusOf(verdict, rating) === 'pass';
    // Unchecked or still pending (a fail-open render): check it now. Blocked stays blocked.
    if (qcPass || (!verdict?.quarantined && !verdict?.assessed)) {
      const checked = await checkAsset(ctx, asset, rating);
      costUsd += checked.costUsd;
      if (checked.verdict) {
        // Committed as by:'check' (paid once per asset); never looser than what QC saw.
        verdict = qcPass && verdict ? { ...stricterVerdict(verdict, checked.verdict), by: 'check' } : checked.verdict;
        ops.push({ op: 'asset_meta', path: asset.path, patch: { safety: verdict } });
      } else if (qcPass) {
        verdict = undefined; // the re-rate couldn't run: unchecked → needs_check → the honest 503
      }
    }
    const status = safetyStatusOf(verdict, rating);
    statusesForHash.push(`${target.kind}:${'id' in target ? target.id : ''}:${asset.path}:${verdict?.assessed || status}`);
    if (status !== 'pass') blockers.push({ target, status, categories: verdict?.categories || [], ...(verdict?.notes?.[0] ? { note: verdict.notes[0] } : {}) });
    return { status, reasons: reasonsFor(status, verdict, rating) };
  };

  // Pages (deduplicated, in the requested order).
  const pageIds = [...new Set((opts.pageIds || []).filter((id) => typeof id === 'string' && id))];
  const pageResults = await inBatches(pageIds, PARALLEL, async (id) => [id, await judge({ kind: 'page', id }, findPage(doc, id)?.render.asset)] as const);
  const pages = Object.fromEntries(pageResults);

  // Cover (only when it is drawn and included).
  const coverAsset = doc.cover.render.asset;
  const cover = opts.includeCover && coverAsset ? await judge({ kind: 'cover' }, coverAsset) : null;

  /**
   * The platform classifier over every window (batches of PARALLEL). The strictest rating wins and
   * categories are merged; one window that can't be checked leaves the text unchecked (null). Stops
   * early once a window is unusable or rated X — nothing after it can change the outcome.
   */
  async function classifyWindows(parts: string[]): Promise<{ assessed?: SafetyVerdict['assessed']; categories: SafetyCategory[]; model?: string } | null> {
    const llm = deps.platformLlm();
    if (!llm) return null;
    let assessed: SafetyVerdict['assessed'] | undefined;
    const categories = new Set<SafetyCategory>();
    let model: string | undefined;
    for (let i = 0; i < parts.length; i += PARALLEL) {
      const batch = await Promise.all(parts.slice(i, i + PARALLEL).map((w) => classifyText(llm, { text: w, rating, surface: 'publish', signal: ctx.signal })));
      let unusable = false;
      for (const c of batch) {
        if (!c) {
          unusable = true;
          continue;
        }
        costUsd += c.costUsd ?? SAFETY_TEXT_USD;
        if (!assessed || ratingRank(c.assessed) > ratingRank(assessed)) assessed = c.assessed;
        c.categories.forEach((cat) => categories.add(cat));
        model ??= c.model;
      }
      if (unusable) return null;
      if (assessed === 'X') break;
    }
    return assessed ? { assessed, categories: [...categories], ...(model ? { model } : {}) } : null;
  }

  // The text verdict is cached by hash. Long text (more than one window) hashes with a version
  // prefix, so a verdict taken from a sampled read before windowing is never reused; short text
  // keeps its exact hash (no re-check).
  const windows = gateWindows(words);
  const textHash = sha256Hex(`${windows.length > 1 ? 'w2\n' : ''}${rating}\n${words}`).slice(0, 16);
  let text: { status: SafetyStatus; reasons: string[] };
  const cached = doc.safety?.text;
  let textVerdict: { assessed?: SafetyVerdict['assessed']; categories: SafetyCategory[]; model?: string } | null = null;
  // A pass the pre-filter gave on its own (pre-filter-only operator mode) was never read by a model:
  // once the classifier is on it is not reused (a block still is — it can only keep text out).
  const prefilterOnlyPass = cached?.model === 'prefilter' && cached.assessed !== 'X' && deps.classifierOn();
  if (cached && cached.hash === textHash && cached.assessed && !prefilterOnlyPass) {
    textVerdict = { assessed: cached.assessed, categories: cached.categories || [], ...(cached.model ? { model: cached.model } : {}) };
  } else if (!words.trim()) {
    textVerdict = { assessed: 'G', categories: [], model: 'empty' };
  } else {
    const pre = prefilterWindows(windows, rating);
    if (pre.decision === 'block') {
      textVerdict = { assessed: 'X', categories: pre.categories, model: 'prefilter' };
    } else if (!deps.classifierOn()) {
      // The operator chose pre-filter-only mode (COMIC_SAFETY_CLASSIFIER=off): clear text is within
      // the rating; anything ambiguous stays unchecked (never published unread). An outage with
      // the classifier ON is different: it never clears (below).
      if (pre.decision === 'clear') textVerdict = { assessed: rating, categories: [], model: 'prefilter' };
    } else {
      textVerdict = await classifyWindows(windows);
    }
    if (textVerdict?.assessed) {
      ops.push({ op: 'safety', patch: { text: { hash: textHash, assessed: textVerdict.assessed, categories: textVerdict.categories, at, ...(textVerdict.model ? { model: textVerdict.model } : {}) } } });
    }
  }
  if (!textVerdict?.assessed) {
    text = { status: 'unchecked', reasons: ["The text couldn't be checked right now"] };
    blockers.push({ target: { kind: 'text' }, status: 'unchecked', categories: [] });
  } else {
    const status: SafetyStatus = textVerdict.assessed === 'X' ? 'blocked' : ratingRank(textVerdict.assessed) > ratingRank(rating) ? 'over_rating' : 'pass';
    const reasons =
      status === 'blocked'
        ? [`Some text doesn't fit the content rules (${categoryWords(textVerdict.categories)})`]
        : status === 'over_rating'
          ? [`Some text reads as ${textVerdict.assessed} — this comic is ${rating}`]
          : [];
    text = { status, reasons };
    if (status !== 'pass') blockers.push({ target: { kind: 'text' }, status, categories: textVerdict.categories });
  }
  statusesForHash.push(`text:${textHash}:${text.status}`);

  const all = [...Object.values(pages), ...(cover ? [cover] : []), text];
  const status: PublishGateResult['status'] = all.some((r) => r.status === 'blocked' || r.status === 'over_rating')
    ? 'blocked'
    : all.some((r) => r.status !== 'pass')
      ? 'needs_check'
      : 'cleared';
  const checkedHash = sha256Hex(statusesForHash.join('\n')).slice(0, 24);
  costUsd = Math.round(costUsd * 1e6) / 1e6;

  ops.push({ op: 'safety', patch: { publish: { ok: status === 'cleared', rating, rev: doc.rev, at, blockers: blockers.slice(0, 50) } } });
  try {
    ctx.session.commit(ops, { origin: 'job' });
  } catch (err) {
    logger.warn('comic_publish_gate_commit_failed', { projectId: ctx.projectId, ...errorFacts(err) });
  }

  const categories = [...new Set(blockers.flatMap((b) => b.categories))];
  await recordDecision({
    userId: ctx.userId,
    projectId: ctx.projectId,
    surface: 'publish',
    layer: 'vision_check',
    decision: status === 'cleared' ? 'allow' : 'withhold',
    categories,
    effective: rating,
    severity: 0,
    contentHash: contentHash(words),
    costUsd,
    operation: 'comic.safety.publish'
  });
  if (status === 'blocked') {
    await deps.store
      .moderationAction({
        projectId: ctx.projectId,
        ownerUserId: ctx.userId,
        action: 'publish_blocked',
        reason: categoryWords(categories),
        actedBy: null,
        metadata: { source: 'publish_gate', blockers: blockers.length, rating }
      })
      .catch(() => undefined);
  }
  return { status, rating, pages, cover, text, checkedHash, costUsd };
}
