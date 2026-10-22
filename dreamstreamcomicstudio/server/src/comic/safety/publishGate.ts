// The publish gate (safety.md §3.4, sharing.md §8). Owner: P1-SAFETY.
//
// Runs before ANY publication — unlisted and public alike — and covers every published
// language's text. Nothing fails open here: a page, cover or text that could not be checked
// is `unchecked`, the gate answers `needs_check`, and the publisher refuses with 503 "Safety
// checks are unavailable right now". Checks are platform-paid (costUsd is reported, never
// billed to the comic). Verdicts are committed to the live doc so the board shows them.

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
import type { StudioContext } from '../types.js';
import { SAFETY_CHECK_USD, SAFETY_TEXT_USD, checkImage, classifyText } from './check.js';
import { categoryWords, contentHash, prefilterDetail } from './contentPolicy.js';
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

  const judge = async (target: RenderTarget, asset: AssetRef | undefined): Promise<{ status: SafetyStatus; reasons: string[] }> => {
    if (!asset) return { status: 'unchecked', reasons: ['Not drawn yet'] };
    let verdict = asset.safety;
    // Unchecked or still pending (a fail-open render): check it now. Blocked stays blocked.
    if (!verdict?.quarantined && !verdict?.assessed) {
      const checked = await checkAsset(ctx, asset, rating);
      costUsd += checked.costUsd;
      if (checked.verdict) {
        verdict = checked.verdict;
        ops.push({ op: 'asset_meta', path: asset.path, patch: { safety: verdict } });
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

  // Every publishable word, including the published translations.
  const languages = [...new Set((opts.languages || []).filter((l) => typeof l === 'string' && l && l !== doc.format.language))];
  const words = publishableText(doc, languages);
  const textHash = sha256Hex(`${rating}\n${words}`).slice(0, 16);
  let text: { status: SafetyStatus; reasons: string[] };
  const cached = doc.safety?.text;
  let textVerdict: { assessed?: SafetyVerdict['assessed']; categories: SafetyCategory[]; model?: string } | null = null;
  if (cached && cached.hash === textHash && cached.assessed) {
    textVerdict = { assessed: cached.assessed, categories: cached.categories || [], ...(cached.model ? { model: cached.model } : {}) };
  } else if (!words.trim()) {
    textVerdict = { assessed: 'G', categories: [], model: 'empty' };
  } else {
    const pre = prefilterDetail(words, rating);
    if (pre.decision === 'block') {
      textVerdict = { assessed: 'X', categories: pre.categories, model: 'prefilter' };
    } else {
      const llm = deps.platformLlm();
      const classified = llm && deps.classifierOn() ? await classifyText(llm, { text: words, rating, surface: 'publish', signal: ctx.signal }) : null;
      if (classified) {
        costUsd += classified.costUsd ?? SAFETY_TEXT_USD;
        textVerdict = { assessed: classified.assessed, categories: classified.categories, ...(classified.model ? { model: classified.model } : {}) };
      }
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
