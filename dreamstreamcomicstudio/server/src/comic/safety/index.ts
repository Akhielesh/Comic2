// PG-13 safety seams (contract §12.6; safety.md). Owner: P1-SAFETY (wave 1), replacing the
// wave-0 stubs IN PLACE (same names, same signatures).
//
// Layers, cheapest first:
//   L2 input   prefilterText ($0, lexicon + obscenity) → classifier only for ambiguous text,
//              long pastes, scripts and long non-Latin text → upload/attachment image checks
//   L3 output  rating rules in the director/writer/compilers (contentPolicyBlock here)
//   L4 renders QC verdict (verdictFromVision) or a standalone check → onRenderVerdict
//   L5 publish runPublishGate (both visibilities, published translations included)
//   L6 UX      deterministic warm redirects (respondBlocked), adapt notes, IP steering
//
// Who pays: every standalone check runs on the PLATFORM key (keys.platformStudioKeys()) and is
// recorded in comic_safety_events.cost_usd and generation_cost_events with billable_usd 0.
// Without a platform key the owner's private view fails open after 20 s (jobs.ts) — publishing
// never does (the gate answers needs_check → 503 "Safety checks are unavailable right now").
//
// Logs and rows NEVER contain the screened text or image: categories, decisions, a one-way
// hash and costs only.

import type { RequestHandler } from 'express';
import {
  getRender,
  newId,
  targetLabel,
  type AssetRef,
  type Card,
  type ComicDoc,
  type Msg,
  type NextStep,
  type RefAsset,
  type RefLabel,
  type RefSubject,
  type RenderTarget
} from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import {
  HARD_BLOCK,
  PLATFORM_CEILING,
  audienceCeiling,
  canServeToOwner,
  minRating,
  ratingRank,
  safetyStatusOf,
  softenAction,
  type ContentRating,
  type SafetyCategory,
  type SafetyVerdict
} from '../../../../shared/comic/safety.js';
import { logger } from '../../lib/logger.js';
import { StudioError, type StudioContext, type StudioSessionApi } from '../types.js';
import { appealMessage, flaggedSteps, recordReportImpl, runAppeal, type AppealResult } from './cases.js';
import { SAFETY_CHECK_USD, SAFETY_TEXT_USD, UPLOAD_CHECK_TIMEOUT_MS, checkImage, classifyText, verdictFromVisionBlock } from './check.js';
import {
  CRISIS_LINE,
  LANGUAGE_NOTE,
  buildSafetyNote,
  categoryWords,
  contentHash,
  decideInput,
  fillTitle,
  grawlixLine,
  needsClassifier,
  prefilterDetail,
  redirectFor,
  severityFor,
  type PrefilterDetail
} from './contentPolicy.js';
import {
  CAPS,
  DAY,
  HOUR,
  addBlockedHash,
  ceilingCache,
  cooldownCache,
  cooldownFromStrikes,
  errorFacts,
  findAssetByPath,
  imageMime,
  isBlockedHash,
  quarantineAsset,
  ratingOf,
  recordDecision,
  safetyDeps,
  statusCache,
  takeSlot
} from './deps.js';
import { runPublishGateImpl, type PublishGateResult } from './publishGate.js';

export { configureSafety, resetSafety, invalidateModerationCache, cooldownFromStrikes } from './deps.js';
export { contentPolicyBlock, findIpNames, homageHint, grawlixLine, REDIRECT_COPY } from './contentPolicy.js';
export { runAppeal, appealMessage, flaggedSteps, type AppealResult } from './cases.js';
export type { PublishGateResult } from './publishGate.js';

// ── Text ─────────────────────────────────────────────────────────────────────

export interface PrefilterResult {
  decision: 'clear' | 'ambiguous' | 'block';
  categories: SafetyCategory[];
  /** Named IP spotted (Shin-chan, LEGO, Marvel…) → the director makes an original homage. */
  ip: string[];
}

/** Free, synchronous word/phrase pre-filter (obscenity + lexicon + IP list). Never logs the text. */
export function prefilterText(text: string, rating: ContentRating): PrefilterResult {
  try {
    const d = prefilterDetail(text, rating);
    return { decision: d.decision, categories: d.categories, ip: d.ip };
  } catch (err) {
    logger.warn('comic_prefilter_failed', { ...errorFacts(err) });
    return { decision: 'clear', categories: [], ip: [] };
  }
}

export interface ScreenResult {
  decision: 'allow' | 'adapt' | 'block';
  categories: SafetyCategory[];
  note?: string;
  strike: 0 | 1 | 3;
  blockedAttachmentPaths: string[];
}

const ALLOW: ScreenResult = { decision: 'allow', categories: [], strike: 0, blockedAttachmentPaths: [] };

type TextOutcome = { decision: 'allow' | 'adapt' | 'block'; categories: SafetyCategory[]; severity: 0 | 1 | 3; note?: string; crisis?: boolean };

/**
 * Decide one piece of user text: pre-filter → (ambiguous / long / script / non-Latin) classifier
 * on the platform key (60 per hour per user) → decideInput. Records one event without content.
 */
async function screenText(
  ctx: StudioContext,
  text: string,
  rating: ContentRating,
  surface: 'message' | 'script'
): Promise<TextOutcome> {
  const deps = safetyDeps();
  const detail = prefilterDetail(text, rating);
  const hash = contentHash(text);
  const base = { userId: ctx.userId, projectId: ctx.projectId, surface, effective: rating, contentHash: hash } as const;
  if (detail.decision === 'block') {
    await recordDecision({ ...base, layer: 'prefilter', decision: 'block', categories: detail.categories, severity: detail.severity });
    return { decision: 'block', categories: detail.categories, severity: detail.severity, crisis: detail.crisis };
  }
  const languageOnly = detail.decision === 'ambiguous' && detail.categories.every((c) => c === 'language');
  const route = detail.decision === 'ambiguous' ? !languageOnly : needsClassifier(text, { file: surface === 'script' });
  if (!route) {
    if (languageOnly) {
      await recordDecision({ ...base, layer: 'prefilter', decision: 'adapt', categories: detail.categories, severity: 0 });
      return { decision: 'allow', categories: detail.categories, severity: 0, note: surface === 'message' ? LANGUAGE_NOTE(rating) : buildSafetyNote({ rating, categories: detail.categories }) };
    }
    return { decision: 'allow', categories: [], severity: 0 };
  }
  const llm = deps.platformLlm();
  const capped = !takeSlot(`text:${ctx.userId}`, CAPS.textPerHour, HOUR);
  const verdict = llm && deps.classifierOn() && !capped ? await classifyText(llm, { text, rating, surface, signal: ctx.signal }) : null;
  if (!verdict) {
    // Fail open on wording (generation + output layers still protect), never on minors.
    await recordDecision({ ...base, layer: 'classifier_unavailable', decision: detail.decision === 'ambiguous' ? 'adapt' : 'allow', categories: detail.categories, severity: 0 });
    if (detail.decision !== 'ambiguous') return { decision: 'allow', categories: [], severity: 0 };
    if (detail.categories.includes('minor_sexual') && detail.categories.includes('sexual')) {
      return { decision: 'block', categories: ['minor_sexual'], severity: 0 };
    }
    return { decision: 'adapt', categories: detail.categories, severity: 0, note: buildSafetyNote({ rating, categories: detail.categories }) };
  }
  const decided = decideInput(verdict, rating);
  await recordDecision({
    ...base,
    layer: 'classifier',
    decision: decided.decision,
    categories: decided.categories,
    assessed: verdict.assessed,
    severity: decided.decision === 'block' ? decided.severity : 0,
    model: verdict.model,
    costUsd: verdict.costUsd ?? SAFETY_TEXT_USD,
    operation: 'comic.safety.text'
  });
  if (decided.decision === 'adapt') {
    return { decision: 'adapt', categories: decided.categories, severity: 0, note: buildSafetyNote({ rating, categories: decided.categories, suggestion: decided.suggestion }) };
  }
  if (decided.decision === 'block') return { decision: 'block', categories: decided.categories, severity: decided.severity, crisis: detail.crisis };
  // Within the rating. A script with over-rating scenes elsewhere still gets neutral adapt notes (writer).
  if (surface === 'script' && verdict.spans.length) {
    commitSourceNotes(ctx, text, verdict.assessed, verdict.categories, verdict.spans);
  }
  return { decision: 'allow', categories: [], severity: 0 };
}

/** doc.safety.source: neutral locators only ("chapter 3: graphic injury"), never excerpts. */
function commitSourceNotes(ctx: StudioContext, text: string, assessed: SafetyVerdict['assessed'], categories: SafetyCategory[], spans: { where: string; category: SafetyCategory }[]) {
  try {
    const adaptNotes = spans.map((s) => `${s.where}: ${categoryWords([s.category])}`).slice(0, 6);
    ctx.session.commit([{ op: 'safety', patch: { source: { hash: contentHash(text), ...(assessed ? { assessed } : {}), categories, adaptNotes, at: safetyDeps().now() } } }], { origin: 'job' });
  } catch (err) {
    logger.warn('comic_source_notes_failed', { projectId: ctx.projectId, ...errorFacts(err) });
  }
}

interface ImageOutcome {
  path: string;
  verdict?: SafetyVerdict;
  blocked: boolean;
  severity: 0 | 1 | 3;
  categories: SafetyCategory[];
}

/** Check one attachment/upload image already in storage (verdict reused when present). */
async function screenStoredImage(ctx: StudioContext, a: RefAsset | AssetRef, rating: ContentRating): Promise<ImageOutcome> {
  const existing = a.safety;
  if (existing?.assessed || existing?.quarantined) {
    const blocked = safetyStatusOf(existing, PLATFORM_CEILING) === 'blocked';
    const categories = existing.categories || [];
    return { path: a.path, verdict: existing, blocked, severity: blocked ? severityFor(categories) : 0, categories };
  }
  let preview: Buffer | null = null;
  try {
    const dataUrl = await ctx.assets.previewDataUrl(a.path, 768);
    const m = /^data:[^;]+;base64,(.*)$/s.exec(dataUrl);
    preview = m ? Buffer.from(m[1], 'base64') : null;
  } catch {
    preview = null;
  }
  if (!preview) return { path: a.path, blocked: false, severity: 0, categories: [] };
  const out = await screenUploadPreview(ctx, preview, 'attachment');
  const verdict = out.verdict;
  const blocked = out.decision === 'block';
  const categories = verdict?.categories || [];
  return { path: a.path, ...(verdict ? { verdict } : {}), blocked, severity: blocked ? severityFor(categories, { hash: verdict?.by === 'upload' && !verdict.model }) : 0, categories };
}

const withTimeout = <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });

/** Screen a user turn (text + attachments + a pasted/imported script) before the director sees it. */
export async function screenTurnInput(
  ctx: StudioContext,
  input: { text: string; attachments: RefAsset[]; sourceText?: string; rating: ContentRating }
): Promise<ScreenResult> {
  const deps = safetyDeps();
  if (!deps.enabled()) return { ...ALLOW };
  const rating = input.rating || ratingOf(ctx);
  const text = typeof input.text === 'string' ? input.text : '';
  const source = typeof input.sourceText === 'string' ? input.sourceText : '';

  const [msg, src, images] = await Promise.all([
    text.trim() ? screenText(ctx, text, rating, 'message') : Promise.resolve<TextOutcome>({ decision: 'allow', categories: [], severity: 0 }),
    source.trim() ? screenText(ctx, source, rating, 'script') : Promise.resolve<TextOutcome>({ decision: 'allow', categories: [], severity: 0 }),
    Promise.all(
      (input.attachments || [])
        .slice(0, 6)
        .filter((a) => a && typeof a.path === 'string' && a.path)
        .map((a) => withTimeout(screenStoredImage(ctx, a, rating), UPLOAD_CHECK_TIMEOUT_MS, { path: a.path, blocked: false, severity: 0 as const, categories: [] }))
    )
  ]);

  // Record verdicts on the stored attachments (the reference gate reads them); blocked ones are held.
  const metaOps: DocOp[] = [];
  for (const img of images) {
    const known = findAssetByPath(ctx.session.doc, img.path);
    if (img.verdict && known && !known.safety?.assessed && !known.safety?.quarantined) {
      metaOps.push({ op: 'asset_meta', path: img.path, patch: { safety: img.verdict } });
    }
  }
  const blockedImages = images.filter((i) => i.blocked);
  for (const img of blockedImages) {
    const q = await quarantineAsset(ctx.assets, { path: img.path, projectId: ctx.projectId, userId: ctx.userId, categories: img.categories });
    if (q) metaOps.push({ op: 'asset_meta', path: img.path, patch: { safety: { ...(img.verdict || { assessed: 'X', at: deps.now() }), assessed: 'X', quarantined: true } } });
  }
  if (metaOps.length) {
    try {
      ctx.session.commit(metaOps, { origin: 'job' });
    } catch (err) {
      logger.warn('comic_attachment_verdicts_failed', { projectId: ctx.projectId, ...errorFacts(err) });
    }
  }
  const blockedAttachmentPaths = blockedImages.map((i) => i.path);
  const severeImage = blockedImages.some((i) => i.severity >= 3);

  if (msg.decision === 'block' || src.decision === 'block' || severeImage) {
    const categories = [...new Set([...(msg.decision === 'block' ? msg.categories : []), ...(src.decision === 'block' ? src.categories : []), ...(severeImage ? blockedImages.flatMap((i) => i.categories) : [])])];
    const strike = Math.max(msg.decision === 'block' ? msg.severity : 0, src.decision === 'block' ? src.severity : 0, severeImage ? 3 : 0) as 0 | 1 | 3;
    const copy = redirectFor(categories);
    const crisis = (msg.crisis || src.crisis) && categories.includes('self_harm');
    return {
      decision: 'block',
      categories,
      strike,
      blockedAttachmentPaths,
      note: [fillTitle(copy.text, ctx.session.doc.brief.title), crisis ? CRISIS_LINE : ''].filter(Boolean).join(' ')
    };
  }
  const notes = [msg.note, src.note].filter((n): n is string => !!n);
  const adapt = msg.decision === 'adapt' || src.decision === 'adapt';
  const categories = [...new Set([...(adapt ? [...msg.categories, ...src.categories] : []), ...blockedImages.flatMap((i) => i.categories)])];
  return {
    decision: adapt ? 'adapt' : 'allow',
    categories,
    strike: 0,
    blockedAttachmentPaths,
    ...(notes.length ? { note: notes.join('\n') } : {})
  };
}

/** Deterministic reply for a hard block (no director call, $0, never silent, never echoes the text). */
export async function respondBlocked(ctx: StudioContext, _prepared: { userMsgId: string }, result: ScreenResult): Promise<void> {
  const copy = redirectFor(result.categories || []);
  const text = (result.note && result.note.trim()) || fillTitle(copy.text, ctx.session.doc.brief.title);
  const cards: Card[] = copy.options.length
    ? [{ type: 'options', id: newId('card'), question: 'Where to next?', choices: copy.options.map((o, i) => ({ id: `safe_${i + 1}`, label: o.label, reply: o.reply })) }]
    : [];
  const msg: Msg = { id: newId('msg'), role: 'assistant', text, at: Date.now(), ...(cards.length ? { cards } : {}) };
  ctx.session.commit([{ op: 'message', msg }]);
}

// ── Client patches ───────────────────────────────────────────────────────────

/** Ops whose text is published as the comic's own words (overlay lettering, cover, book plates). */
const DIALOGUE_OPS: ReadonlySet<string> = new Set(['line', 'translation', 'edition_text', 'book', 'reader', 'cover']);
/** Keys that never hold free text (ids, paths, styles, enums the server validates). */
const SKIP_KEYS: ReadonlySet<string> = new Set([
  'id', 'op', 'kind', 'lang', 'style', 'titleStyle', 'balloons', 'balloon', 'order', 'target', 'ref', 'refs', 'owner', 'at', 'status',
  'sourceHash', 'model', 'gloss', 'issue', 'register', 'presetId', 'speakers', 'variants', 'crop', 'original', 'rating', 'quality', 'aspect'
]);
const isSkipKey = (k: string) => SKIP_KEYS.has(k) || /(?:Id|Ids|path|Path)$/.test(k);
/** Categories that make a dialogue line wait for a rewrite (409) when they go past the rating. */
const DIALOGUE_STRICT: ReadonlySet<SafetyCategory> = new Set(['language', 'hate', 'harassment', 'sexual', 'nudity', 'graphic_gore', 'self_harm', 'minor_sexual']);

/** Every free-text string inside one op (ids, paths and styles skipped; bounded). */
export const opTexts = (op: DocOp): string[] => {
  const out: string[] = [];
  const walk = (value: unknown, key: string, depth: number) => {
    if (out.length >= 400 || depth > 6 || value === null || value === undefined || isSkipKey(key)) return;
    if (typeof value === 'string') {
      if (value.trim().length >= 2) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value.slice(0, 200)) walk(v, key, depth + 1);
      return;
    }
    if (typeof value === 'object') for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k, depth + 1);
  };
  if (op && typeof op === 'object') for (const [k, v] of Object.entries(op as Record<string, unknown>)) walk(v, k, 0);
  return out;
};

const ceilingFor = (doc: ComicDoc, accountCeiling?: ContentRating): ContentRating => minRating(audienceCeiling(doc), accountCeiling ?? PLATFORM_CEILING);

/**
 * Screen the free text of a sanitized client batch with the pre-filter ($0, synchronous):
 * `block` anywhere → 422 CONTENT_POLICY (the whole batch is refused, the doc is unchanged);
 * dialogue that goes past the rating in a strict category → 409 with a suggested rewrite
 * (grawlixes for swearing). Everything else passes and is re-checked at publish.
 */
export function screenOpsText(
  doc: ComicDoc,
  ops: DocOp[],
  ctx: { userId?: string; projectId?: string; rating: ContentRating; ceiling?: ContentRating }
): void {
  if (!safetyDeps().enabled()) return;
  for (const op of ops || []) {
    if (!op || typeof op !== 'object') continue;
    const dialogue = DIALOGUE_OPS.has(op.op);
    for (const text of opTexts(op)) {
      const d: PrefilterDetail = prefilterDetail(text, ctx.rating);
      if (d.decision === 'clear') continue;
      if (d.decision === 'block') {
        void recordDecision({ userId: ctx.userId ?? null, projectId: ctx.projectId ?? doc.id, surface: 'patch', layer: 'prefilter', decision: 'block', categories: d.categories, effective: ctx.rating, severity: d.severity, contentHash: contentHash(text) });
        throw new StudioError('CONTENT_POLICY', `That text doesn't fit DreamStream's content rules (${categoryWords(d.categories)}) — try different wording.`, { status: 422 });
      }
      if (!dialogue) continue;
      const strict = d.categories.filter((c) => DIALOGUE_STRICT.has(c));
      if (!strict.length) continue;
      void recordDecision({ userId: ctx.userId ?? null, projectId: ctx.projectId ?? doc.id, surface: 'patch', layer: 'prefilter', decision: 'adapt', categories: strict, effective: ctx.rating, severity: 0, contentHash: contentHash(text) });
      const ceiling = ctx.ceiling ?? ceilingFor(doc);
      const canRaise = ratingRank(ctx.rating) < ratingRank(ceiling);
      const languageOnly = strict.every((c) => c === 'language');
      const suggestion = languageOnly ? grawlixLine(text, ctx.rating) : (() => {
        const soft = softenAction(text);
        return soft && soft !== text.trim() ? soft : undefined;
      })();
      const tail = canRaise ? ", or change the comic's rating" : '';
      throw new StudioError(
        'CONTENT_POLICY',
        languageOnly
          ? `That line goes past ${ctx.rating} (strong language).${suggestion ? ` Try: “${suggestion.slice(0, 200)}”` : ' Try a grawlix like “@#$%!”'}${tail}.`
          : `That line may go past ${ctx.rating} (${categoryWords(strict)}). Try gentler wording${suggestion ? `: “${suggestion.slice(0, 200)}”` : ''}${tail}.`,
        { status: 409 }
      );
    }
  }
}

/** Screen the text inside client patch ops. Throws StudioError CONTENT_POLICY (422) or a 409 suggestion. */
export async function screenPatch(ctx: StudioContext, ops: DocOp[], rating: ContentRating): Promise<void> {
  screenOpsText(ctx.session.doc, ops, { userId: ctx.userId, projectId: ctx.projectId, rating, ceiling: ceilingFor(ctx.session.doc, ctx.caps?.ratingCeiling) });
}

// ── Images ───────────────────────────────────────────────────────────────────

const DENYLIST_CATEGORIES: ReadonlySet<SafetyCategory> = new Set<SafetyCategory>(['minor_sexual', 'sexual', 'nudity', 'hate']);

/** Check an uploaded image preview (≤ 768 px); piggybacks a description for ref ranking. */
export async function screenUploadPreview(
  ctx: StudioContext,
  preview768: Buffer,
  surface: 'upload' | 'attachment' | 'import'
): Promise<{
  decision: 'allow' | 'block' | 'unavailable';
  verdict?: SafetyVerdict;
  describe?: { subject: RefSubject; view?: RefLabel; caption: string; multipleSubjects: boolean };
}> {
  const deps = safetyDeps();
  if (!deps.enabled()) return { decision: 'allow' };
  const mime = Buffer.isBuffer(preview768) ? imageMime(preview768) : null;
  if (!mime) return { decision: 'unavailable' };
  const now = deps.now();
  const evSurface = surface === 'import' ? 'import' : 'upload';
  let dhash: string | undefined;
  try {
    dhash = await ctx.assets.dHash(preview768);
  } catch {
    dhash = undefined;
  }
  // $0 denylist (near-duplicates of images already blocked).
  if (dhash && (await isBlockedHash(dhash))) {
    const verdict: SafetyVerdict = { assessed: 'X', by: 'upload', at: now };
    await recordDecision({ userId: ctx.userId, projectId: ctx.projectId, surface: evSurface, layer: 'hash', decision: 'block', categories: [], severity: 3, contentHash: dhash });
    return { decision: 'block', verdict };
  }
  const llm = deps.platformLlm();
  if (!llm || !deps.classifierOn() || !takeSlot(`image:${ctx.userId}`, CAPS.imagePerHour, HOUR)) return { decision: 'unavailable' };
  const dataUrl = `data:${mime};base64,${preview768.toString('base64')}`;
  const check = await checkImage(llm, { dataUrl, by: 'upload', describe: true, timeoutMs: UPLOAD_CHECK_TIMEOUT_MS, now, signal: ctx.signal });
  if (!check) {
    await recordDecision({ userId: ctx.userId, projectId: ctx.projectId, surface: evSurface, layer: 'classifier_unavailable', decision: 'allow', categories: [], severity: 0, ...(dhash ? { contentHash: dhash } : {}) });
    return { decision: 'unavailable' };
  }
  const verdict = check.verdict;
  const blocked = safetyStatusOf(verdict, PLATFORM_CEILING) === 'blocked';
  const categories = verdict.categories || [];
  await recordDecision({
    userId: ctx.userId,
    projectId: ctx.projectId,
    surface: evSurface,
    layer: 'vision_check',
    decision: blocked ? 'block' : 'allow',
    categories,
    ...(verdict.assessed ? { assessed: verdict.assessed } : {}),
    severity: blocked ? severityFor(categories) : 0,
    ...(dhash ? { contentHash: dhash } : {}),
    model: check.model,
    costUsd: check.costUsd ?? SAFETY_CHECK_USD,
    operation: 'comic.safety.upload'
  });
  if (blocked) {
    // Only abuse imagery joins the $0 denylist (a re-upload is then a severe strike); a gory
    // horror still is simply checked again next time.
    const abusive = categories.find((c) => DENYLIST_CATEGORIES.has(c));
    if (abusive) await addBlockedHash(dhash, abusive);
    return { decision: 'block', verdict };
  }
  return { decision: 'allow', verdict, ...(check.describe ? { describe: check.describe } : {}) };
}

/** Standalone render check on the platform key (when QC did not fold one in). undefined = unchecked. */
export async function checkRenderSafety(ctx: StudioContext, target: RenderTarget, asset: AssetRef): Promise<SafetyVerdict | undefined> {
  const deps = safetyDeps();
  if (!deps.enabled()) return undefined;
  const llm = deps.platformLlm();
  if (!llm || !deps.classifierOn() || !asset?.path) return undefined;
  let dataUrl = '';
  try {
    dataUrl = await ctx.assets.previewDataUrl(asset.path, 768);
  } catch {
    dataUrl = await ctx.assets.loadDataUrl(asset.path).catch(() => '');
  }
  if (!dataUrl) return undefined;
  const rating = ratingOf(ctx);
  const check = await checkImage(llm, { dataUrl, rating, by: 'check', now: deps.now(), signal: ctx.signal });
  if (!check) {
    logger.info('comic_safety_check_unavailable', { projectId: ctx.projectId, target: target.kind });
    return undefined;
  }
  const status = safetyStatusOf(check.verdict, rating);
  await recordDecision({
    userId: ctx.userId,
    projectId: ctx.projectId,
    surface: 'render',
    layer: 'vision_check',
    decision: status === 'blocked' ? 'withhold' : 'allow',
    categories: check.verdict.categories || [],
    effective: rating,
    ...(check.verdict.assessed ? { assessed: check.verdict.assessed } : {}),
    severity: 0,
    model: check.model,
    costUsd: check.costUsd ?? SAFETY_CHECK_USD,
    operation: 'comic.safety.render'
  });
  return check.verdict;
}

/** vision.ts QC folds the safety block into its JSON; missing ⇒ undefined (unchecked, never pass). */
export function verdictFromVision(raw: unknown, model?: string): SafetyVerdict | undefined {
  return verdictFromVisionBlock(raw, model, safetyDeps().now());
}

// ── Render verdicts ──────────────────────────────────────────────────────────

interface Followups {
  notices: Card[];
  steps: NextStep[];
}
const followups = new WeakMap<StudioSessionApi, Followups>();

/**
 * Notices and chips produced by render verdicts since the last call (blocked → "Redraw it
 * safer" / "Check again"; over the rating → a warning). The job runner merges them into its
 * summary message (P1-JOBS, wave 2) so the turn stays one message.
 */
export function takeRenderSafetyFollowups(session: StudioSessionApi): Followups {
  const f = followups.get(session) || { notices: [], steps: [] };
  followups.delete(session);
  return f;
}

const pushFollowup = (session: StudioSessionApi, notice: Card, steps: NextStep[]) => {
  const f = followups.get(session) || { notices: [], steps: [] };
  f.notices.push(notice);
  for (const s of steps) if (!f.steps.some((x) => x.label === s.label && JSON.stringify(x.action) === JSON.stringify(s.action))) f.steps.push(s);
  f.notices = f.notices.slice(-6);
  f.steps = f.steps.slice(0, 6);
  followups.set(session, f);
};

/**
 * Commit the verdict (asset_meta); blocked → quarantine + auto-restore the previous passing
 * version + a notice with chips; over the rating → a warning notice. undefined → nothing (the
 * job runner records "unchecked").
 */
export async function onRenderVerdict(ctx: StudioContext, target: RenderTarget, asset: AssetRef, verdict: SafetyVerdict | undefined): Promise<void> {
  if (!verdict || !asset?.path) return;
  const deps = safetyDeps();
  const doc = ctx.session.doc;
  const rating = ratingOf(ctx, doc);
  const clean: SafetyVerdict = { ...verdict };
  delete (clean as { pending?: true }).pending;
  const status = safetyStatusOf(clean, rating);
  const label = targetLabel(doc, target);

  if (status === 'blocked') {
    const categories = clean.categories || [];
    const quarantinePath = await quarantineAsset(ctx.assets, { path: asset.path, projectId: ctx.projectId, userId: ctx.userId, categories });
    ctx.session.commit([{ op: 'asset_meta', path: asset.path, patch: { safety: { ...clean, assessed: 'X', ...(quarantinePath ? { quarantined: true } : {}) } } }], { origin: 'job' });
    // Auto-restore the newest version that passes (else the newest the owner may see).
    const render = getRender(ctx.session.doc, target);
    if (render?.asset?.path === asset.path) {
      const history = render.history || [];
      const previous = history.find((v) => safetyStatusOf(v.safety, rating) === 'pass') || history.find((v) => canServeToOwner(v));
      if (previous) ctx.session.commit([{ op: 'render_use', target, path: previous.path, at: deps.now() }], { origin: 'job', label: 'Restore previous version' });
    }
    await recordDecision({
      userId: ctx.userId,
      projectId: ctx.projectId,
      surface: 'render',
      layer: clean.by === 'qc' ? 'vision_qc' : 'vision_check',
      decision: 'withhold',
      categories,
      effective: rating,
      assessed: 'X',
      severity: 0,
      ...(clean.model ? { model: clean.model } : {})
    });
    // Generated art flagged for minors: a human looks (never an automatic account restriction).
    if (categories.some((c) => c === 'minor_sexual')) {
      await deps.store
        .openCase({ kind: 'auto', projectId: ctx.projectId, ownerUserId: ctx.userId, target: { target, path: asset.path, ...(quarantinePath ? { quarantinePath } : {}), check: { assessed: 'X', categories, by: clean.by || 'qc' } }, reason: 'render flagged: minors' })
        .catch(() => undefined);
    }
    pushFollowup(
      ctx.session,
      { type: 'notice', id: newId('card'), tone: 'warn', text: `${label} didn't fit the content rules${categories.length ? ` (${categoryWords(categories)})` : ''}. A safer redraw is one tap away, or ask for a second look.` },
      flaggedSteps(target)
    );
    return;
  }

  ctx.session.commit([{ op: 'asset_meta', path: asset.path, patch: { safety: clean } }], { origin: 'job' });
  if (status === 'over_rating') {
    const ceiling = ceilingFor(doc, ctx.caps?.ratingCeiling);
    const assessed = clean.assessed as ContentRating;
    const canRaise = ratingRank(assessed) <= ratingRank(ceiling) ? assessed : undefined;
    await recordDecision({ userId: ctx.userId, projectId: ctx.projectId, surface: 'render', layer: clean.by === 'qc' ? 'vision_qc' : 'vision_check', decision: 'adapt', categories: clean.categories || [], effective: rating, assessed, severity: 0 });
    pushFollowup(
      ctx.session,
      { type: 'notice', id: newId('card'), tone: 'warn', text: `${label} came out ${assessed} — this comic is ${rating}. Redraw it safer${canRaise ? `, or set the rating to ${canRaise}` : ''}.` },
      flaggedSteps(target, { ...(canRaise ? { changeRating: canRaise } : {}) })
    );
  }
}

/** May the owner see this asset? Only a `blocked` verdict hides it (never pending/unchecked). */
export function isServableToOwner(asset?: AssetRef): boolean {
  return canServeToOwner(asset);
}

// ── Publish gate ─────────────────────────────────────────────────────────────

/** Gate a publish (both visibilities; published translations included). Never fails open. */
export async function runPublishGate(
  ctx: StudioContext,
  doc: ComicDoc,
  opts: { pageIds: string[]; includeCover: boolean; languages: string[] }
): Promise<PublishGateResult> {
  return runPublishGateImpl(ctx, doc, opts);
}

// ── Reports, appeals, accounts ───────────────────────────────────────────────

/** A reader's report on a published comic (always accepted; deduped into cases). */
export async function recordReport(r: { slug: string; reason: string; note?: string; page?: number; reporterUserId?: string; ipHash: string }): Promise<void> {
  await recordReportImpl(r);
}

/** "Check again" from a UI tap or the REST route: the appeal result as an assistant message. */
export async function appealAndTell(ctx: StudioContext, target: RenderTarget, note?: string): Promise<AppealResult> {
  const result = await runAppeal(ctx, target, note);
  appealMessage(ctx.session, result);
  return result;
}

const SUSPENDED_MESSAGE = 'This account is suspended. Contact support if you think this is a mistake.';
const RESTRICTED_UPLOAD_MESSAGE = 'Your account is limited right now, so uploads and publishing are paused. You can still read and edit your comics.';

/** Restricted accounts may read and edit; these writes are refused (spend is refused in the stream). */
const RESTRICTED_WRITE = /\/(?:refs|publication(?:\/regenerate)?)\/?(?:\?|$)/;

/**
 * user_moderation_status (60 s cache): suspended → 403; restricted → uploads and publishing are
 * refused here, spend in the stream (res.locals.moderationStatus). A failed lookup lets the user
 * through (the generation and output layers still protect) and is logged.
 */
export function requireActiveUser(): RequestHandler {
  return (req, res, next) => {
    const userId = (req as { user?: { id?: string } }).user?.id;
    if (!userId) return next();
    const decide = (status: 'active' | 'restricted' | 'suspended') => {
      if (status === 'suspended') {
        res.status(403).json({ error: { message: SUSPENDED_MESSAGE, code: 'FORBIDDEN' } });
        return;
      }
      if (res.locals) res.locals.moderationStatus = status;
      const method = String(req.method || 'GET').toUpperCase();
      const url = String(req.originalUrl || req.url || '');
      if (status === 'restricted' && (method === 'POST' || method === 'PUT' || method === 'PATCH') && RESTRICTED_WRITE.test(url)) {
        res.status(403).json({ error: { message: RESTRICTED_UPLOAD_MESSAGE, code: 'FORBIDDEN' } });
        return;
      }
      next();
    };
    const cached = statusCache.get(userId);
    if (cached) return decide(cached);
    safetyDeps()
      .store.moderationStatus(userId)
      .then((status) => {
        statusCache.set(userId, status);
        decide(status);
      })
      .catch((err) => {
        logger.warn('comic_moderation_lookup_failed', { userId, ...errorFacts(err) });
        decide('active');
      });
  };
}

/** Whole years between a YYYY-MM-DD date of birth and now (UTC). */
export const ageFromDob = (dob: string, now: number): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob || '');
  if (!m) return null;
  const today = new Date(now);
  let age = today.getUTCFullYear() - Number(m[1]);
  const beforeBirthday = today.getUTCMonth() + 1 < Number(m[2]) || (today.getUTCMonth() + 1 === Number(m[2]) && today.getUTCDate() < Number(m[3]));
  if (beforeBirthday) age -= 1;
  return Number.isFinite(age) && age >= 0 ? age : null;
};

/**
 * Account-age ceiling from profile_private.dob (10-min LRU; the DOB never reaches the doc):
 * under 13 → PG, otherwise (or unknown) PG-13. A failed lookup THROWS so the caller can apply
 * the conservative ceiling (access.ts: PG) — it must never lift it.
 */
export async function accountCeilingFor(userId: string): Promise<ContentRating> {
  const deps = safetyDeps();
  if (!userId || !deps.store.configured) return PLATFORM_CEILING;
  const cached = ceilingCache.get(userId);
  if (cached) return cached;
  const dob = await deps.store.accountDob(userId);
  const age = dob ? ageFromDob(dob, deps.now()) : null;
  const rating: ContentRating = age !== null && age < 13 ? 'PG' : PLATFORM_CEILING;
  ceilingCache.set(userId, rating);
  return rating;
}

/** Strike cooldown, if one is active (3 points in 24 h → 15 min; 6 in 7 days → 24 h). */
export async function cooldownFor(userId: string): Promise<{ until: number } | null> {
  const deps = safetyDeps();
  if (!userId || !deps.store.configured) return null;
  const now = deps.now();
  const cached = cooldownCache.get(userId);
  if (cached !== undefined) return cached && cached.until > now ? cached : null;
  const strikes = await deps.store.strikes(userId, now - 7 * DAY).catch(() => []);
  const value = cooldownFromStrikes(strikes, now);
  cooldownCache.set(userId, value);
  return value;
}

/** True when the category set has a hard-block member (UI copy helpers). */
export const isHardBlock = (categories: SafetyCategory[]): boolean => categories.some((c) => HARD_BLOCK.has(c));
