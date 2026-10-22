// Feature actions "timeline" (contract §5.1 / §12.1 / §12.2 "Aspect"): fit_render. Owner: P1-TIMELINE.
//
// fit_render { target, mode? } — FREE, software only. A page or cover that came back at the wrong
// shape (bug "4:5 page rendered 1:1") is padded with its edge colour or cropped (≤ 8 %) to the
// book's page aspect by AssetStore.fitToAspect (P1-STORAGE, derive.ts). The result is a NEW version
// (source 'derived', origin 'derived'): the original stays one tap away in the version stack, the
// version keeps the source's specHash (so staleness stays honest) and its QC boxes and balloons are
// remapped through the same geometry, so lettering lands where it did and QC never re-runs.
// Never automatic, never a redraw: when software can't fix it (crop too deep, storage down) the
// outcome says so and offers the quoted paid redraw as a chip.

import {
  archiveOf,
  findPage,
  getRender,
  newId,
  renderTargetKey,
  targetLabel,
  type AspectRatio,
  type AssetRef,
  type Balloon,
  type Box,
  type Card,
  type ComicDoc,
  type Msg,
  type NextStep,
  type QcReport,
  type RenderState,
  type RenderTarget
} from '../../../../shared/comic/doc.js';
import type { DocOp, SpendAction, StudioAction } from '../../../../shared/comic/ops.js';
import { aspectFromSize, aspectMatches, aspectRatioOf, formatUsd } from '../../../../shared/comic/models.js';
import { unitPrice } from '../../../../shared/comic/plan.js';
import { canServeToOwner } from '../../../../shared/comic/safety.js';
import type { ActionHandler } from '../extensions.js';
import { spendIsByok, type ActionOutcome, type RunActionOptions, type StartedAction } from '../jobs.js';
import { parseRenderTarget } from '../sanitize/timeline.js';
import { StudioError, type StudioContext } from '../types.js';
import { logger } from '../../lib/logger.js';

type FitAction = Extract<StudioAction, { type: 'fit_render' }>;
export type FitMode = 'pad' | 'crop';

/** Deepest crop software will make (contract §12.8 derive: "crop ≤ 8 %"); beyond it, pad. */
export const MAX_FIT_CROP = 0.08;

const isBusy = (r?: RenderState) => !!r && (r.status === 'queued' || r.status === 'rendering');
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round4 = (n: number) => Math.round(n * 10000) / 10000;

// ── Geometry (pure; exported for tests and the client preview) ───────────────

/** Fraction of the long side a crop to `want` would remove (0 when the shape already matches). */
export const cropNeeded = (w: number, h: number, want: AspectRatio): number => {
  if (!(w > 0) || !(h > 0)) return 0;
  const r = w / h;
  const R = aspectRatioOf(want);
  return Math.max(0, 1 - Math.min(r / R, R / r));
};

/** 'auto' → crop when it removes ≤ MAX_FIT_CROP, else pad (nothing of the art is ever lost). */
export const resolveFitMode = (w: number, h: number, want: AspectRatio, mode: FitAction['mode']): FitMode =>
  mode === 'pad' || mode === 'crop' ? mode : cropNeeded(w, h, want) <= MAX_FIT_CROP ? 'crop' : 'pad';

/**
 * Where the source image sits inside the fitted frame, in source pixels: the frame is W×H and a
 * source pixel (px, py) lands at (px + ox, py + oy). Pad = contain + centre; crop = cover + centre.
 */
export interface FitFrame { W: number; H: number; ox: number; oy: number; w: number; h: number }
export const fitFrame = (w: number, h: number, want: AspectRatio, mode: FitMode): FitFrame => {
  const R = aspectRatioOf(want);
  const tooTall = w / h < R;
  let W = w;
  let H = h;
  if (mode === 'pad') {
    if (tooTall) W = h * R;
    else H = w / R;
  } else if (tooTall) H = w / R;
  else W = h * R;
  return { W, H, ox: (W - w) / 2, oy: (H - h) / 2, w, h };
};

const mapX = (f: FitFrame, x: number) => (x * f.w + f.ox) / f.W;
const mapY = (f: FitFrame, y: number) => (y * f.h + f.oy) / f.H;

/** A normalized box moved into the fitted frame and clipped to it; undefined when cropped away. */
export const mapBox = (f: FitFrame, b: Box): Box | undefined => {
  const x0 = clamp01(mapX(f, b.x));
  const y0 = clamp01(mapY(f, b.y));
  const x1 = clamp01(mapX(f, b.x + b.w));
  const y1 = clamp01(mapY(f, b.y + b.h));
  if (x1 - x0 <= 0.001 || y1 - y0 <= 0.001) return undefined;
  return { x: round4(x0), y: round4(y0), w: round4(x1 - x0), h: round4(y1 - y0) };
};

const mapPoint = (f: FitFrame, p: { x: number; y: number }) => ({ x: round4(clamp01(mapX(f, p.x))), y: round4(clamp01(mapY(f, p.y))) });

/** QC panel boxes, keep-outs and speaker marks follow the art; score, issues and text stay. */
export const remapQc = (qc: QcReport | undefined, f: FitFrame): QcReport | undefined => {
  if (!qc) return undefined;
  const out: QcReport = { ...qc };
  if (qc.panelBoxes) out.panelBoxes = qc.panelBoxes.map((b) => mapBox(f, b)).filter((b): b is Box => !!b);
  if (qc.keepOut) {
    out.keepOut = qc.keepOut
      .map((k) => {
        const box = mapBox(f, k.box);
        return box ? { ...k, box } : undefined;
      })
      .filter((k): k is NonNullable<typeof k> => !!k);
  }
  if (qc.heads) out.heads = qc.heads.map((m) => ({ ...m, head: mapPoint(f, m.head), ...(m.mouth ? { mouth: mapPoint(f, m.mouth) } : {}) }));
  return out;
};

/** Balloons keep their place on the art (positions and widths through the same frame). */
export const remapBalloons = (balloons: Balloon[], f: FitFrame): Balloon[] =>
  balloons.map((b) => {
    const next: Balloon = { ...b, x: round4(clamp01(mapX(f, b.x))), y: round4(clamp01(mapY(f, b.y))), w: round4(Math.min(1, Math.max(0.04, (b.w * f.w) / f.W))) };
    if (typeof b.tailX === 'number') next.tailX = round4(clamp01(mapX(f, b.tailX)));
    if (typeof b.tailY === 'number') next.tailY = round4(clamp01(mapY(f, b.tailY)));
    return next;
  });

// ── The action ───────────────────────────────────────────────────────────────

const labelOf = (doc: ComicDoc, target: RenderTarget) => (target.kind === 'cover' ? 'the cover' : targetLabel(doc, target).replace(/^Page/, 'page'));
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A notice (and chips) into the director's message, or a new assistant message for a UI tap. */
function say(ctx: StudioContext, opts: RunActionOptions | undefined, tone: 'info' | 'warn' | 'error' | 'success', text: string, steps: NextStep[] = []): void {
  const card: Card = { type: 'notice', id: newId('card'), tone, text };
  if (opts?.collectCard) {
    // The director speaks for itself; only problems ride along as a card.
    if (tone !== 'success') opts.collectCard(card);
    if (steps.length) opts.collectNextSteps?.(steps);
    return;
  }
  const msg: Msg = { id: newId('msg'), role: 'assistant', text, at: Date.now(), cards: [card], ...(steps.length ? { nextSteps: steps } : {}) };
  ctx.session.commit([{ op: 'message', msg }]);
}

const done = (outcome: ActionOutcome): StartedAction => ({ outcome, done: Promise.resolve() });

/** The quoted paid alternative ("Redraw at 4:5 ≈ $0.06"), always as an explicit chip. */
const redrawStep = (doc: ComicDoc, target: RenderTarget, byok: boolean): NextStep => {
  const kind = target.kind === 'cover' ? 'cover' : 'page';
  const { usd } = unitPrice(doc, kind, { byok });
  const action: SpendAction =
    target.kind === 'cover' ? { type: 'render_cover', quotedUsd: usd } : { type: 'render_pages', pageIds: [(target as { id: string }).id], force: true, quotedUsd: usd };
  return { label: `Redraw at ${doc.format.pageAspect}`, action, usd };
};

export async function runFitRender(ctx: StudioContext, action: FitAction, opts: RunActionOptions): Promise<StartedAction> {
  const target = parseRenderTarget(action?.target);
  const before = ctx.session.doc;
  if (target.kind !== 'page' && target.kind !== 'cover') {
    const message = 'Only pages and the cover have a book shape to fit.';
    say(ctx, opts, 'info', message);
    return done({ status: 'blocked', message, code: 'BAD_REQUEST' });
  }
  const render = getRender(before, target);
  if (!render) throw new StudioError('BAD_REQUEST', 'That page is no longer in the book.', { status: 400 });
  const label = labelOf(before, target);
  if (isBusy(render)) throw new StudioError('CONFLICT', `${capital(label)} is still drawing — fit it when it's done.`, { status: 409 });
  const asset = render.asset;
  if (render.status !== 'ready' || !asset) {
    const message = `${capital(label)} isn't drawn yet, so there is nothing to fit.`;
    say(ctx, opts, 'info', message);
    return done({ status: 'blocked', message, code: 'NOT_READY' });
  }
  if (!canServeToOwner(asset)) throw new StudioError('CONTENT_POLICY', "That image didn't pass the content check, so it can't be changed.", { status: 409 });
  const want = before.format.pageAspect;
  const { w, h } = asset;
  if (!w || !h) {
    const message = `I can't measure ${label}'s size, so I can't fit it safely. Nothing was changed.`;
    say(ctx, opts, 'warn', message);
    return done({ status: 'blocked', message, code: 'NOT_READY' });
  }
  if (aspectMatches(want, w, h)) {
    const message = `${capital(label)} already fits ${want} — nothing to change ($0).`;
    say(ctx, opts, 'info', message);
    return done({ status: 'done', message });
  }

  const byok = spendIsByok(ctx.keys);
  const got = aspectFromSize(w, h);
  const mode = resolveFitMode(w, h, want, action.mode);
  const cut = cropNeeded(w, h, want);
  if (mode === 'crop' && cut > MAX_FIT_CROP) {
    const pct = Math.round(cut * 100);
    const redraw = redrawStep(before, target, byok);
    const message = `Cropping ${label} from ${got} to ${want} would cut ${pct}% of the art, so I didn't. Padding the edges keeps everything (free), or redraw it at ${want} (≈${formatUsd(redraw.usd ?? 0)}).`;
    say(ctx, opts, 'warn', message, [{ label: `Fit to ${want} with padding`, action: { type: 'fit_render', target, mode: 'pad' }, usd: 0 }, redraw]);
    return done({ status: 'blocked', message, code: 'BAD_REQUEST' });
  }

  let fitted: AssetRef;
  try {
    fitted = await ctx.assets.fitToAspect({ userId: ctx.userId, projectId: ctx.projectId, path: asset.path, aspect: want, mode });
  } catch (err) {
    const why = err instanceof StudioError ? err.userMessage : 'the image could not be processed';
    if (!(err instanceof StudioError)) logger.warn('comic_fit_render_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
    const redraw = redrawStep(before, target, byok);
    const message = `I couldn't fit ${label} to ${want}: ${why.replace(/[.!]+$/, '')}. Nothing was changed${redraw.usd ? ` — a redraw at ${want} is ≈${formatUsd(redraw.usd)}` : ''}.`;
    say(ctx, opts, 'warn', message, [redraw]);
    return done({ status: 'blocked', message, code: err instanceof StudioError ? err.code : 'INTERNAL' });
  }
  if (!fitted?.path) throw new StudioError('INTERNAL', `Fitting ${label} didn't produce an image. Nothing was changed.`, { status: 500 });
  if (!fitted.variants?.length) {
    try {
      const variants = await ctx.assets.ensureVariants(fitted);
      if (variants?.length) fitted = { ...fitted, variants };
    } catch {
      /* variants are a speed-up, never required: the original size is shown instead */
    }
  }

  // The doc may have moved on while storage worked (a redraw landed, the page was deleted).
  const doc = ctx.session.doc;
  const now = getRender(doc, target);
  if (!now || isBusy(now) || now.asset?.path !== asset.path) {
    const message = `${capital(label)} changed while I was fitting it, so I left it as it is. Nothing was spent.`;
    say(ctx, opts, 'info', message);
    return done({ status: 'blocked', message, code: 'CONFLICT' });
  }

  const frame = fitFrame(w, h, want, mode);
  const fittedAsset: AssetRef = { ...fitted, source: 'derived', derivedFrom: asset.path };
  if (asset.safety && !fittedAsset.safety) fittedAsset.safety = asset.safety; // same pixels, same verdict
  const at = Date.now();
  const patch: Partial<RenderState> = {
    status: 'ready',
    asset: fittedAsset,
    origin: 'derived',
    parentPath: asset.path,
    aspect: want,
    costUsd: 0,
    note: `Fitted to ${want} (${mode === 'pad' ? 'padded edges' : 'trimmed edges'})`,
    updatedAt: at,
    error: undefined
  };
  if (now.specHash) patch.specHash = now.specHash; // same art, same spec: staleness stays honest
  if (now.resolution) patch.resolution = now.resolution;
  if (now.continuityPath) patch.continuityPath = now.continuityPath;
  if (now.refPaths) patch.refPaths = now.refPaths;
  const qc = remapQc(now.qc, frame);
  if (qc) patch.qc = qc;
  const ops: DocOp[] = [{ op: 'render', target, patch }];
  const page = target.kind === 'page' ? findPage(doc, target.id) : undefined;
  if (page?.balloons.length) ops.push({ op: 'balloons', pageId: page.id, balloons: remapBalloons(page.balloons, frame) });
  // "Saved by software" (decisions-final #6): the quoted alternative to a fit is a redraw at the right shape.
  // Counted once per original: re-fitting the same image (after flipping back to it) saves nothing new.
  const key = renderTargetKey(target);
  const fittedBefore =
    now.history.some((v) => v.derivedFrom === asset.path || (v.origin === 'derived' && v.parentPath === asset.path)) ||
    archiveOf(doc).some((a) => a.targetKey === key && a.derivedFrom === asset.path);
  const saved = fittedBefore ? 0 : unitPrice(doc, target.kind === 'cover' ? 'cover' : 'page', { byok }).usd;
  ops.push({
    op: 'spend',
    entry: {
      id: newId('sp'),
      at,
      kind: target.kind === 'cover' ? 'cover' : 'page',
      label: `Fit ${label} to ${want} (software)`,
      usd: 0,
      byok,
      estimated: false,
      target: key,
      ...(saved > 0 ? { savedUsd: saved } : {})
    }
  });
  ctx.session.commit(ops, { origin: opts?.origin ?? (opts?.collectCard ? 'director' : 'user'), label: `Fit ${label} to ${want}` });
  void ctx.publishUrls([fittedAsset.path, ...(fittedAsset.variants || []).map((v) => v.path)]).catch(() => undefined);
  const how = mode === 'pad' ? 'padding the edges' : `trimming ${Math.max(1, Math.round(cut * 100))}% off the edges`;
  const message = `Fitted ${label} from ${got} to ${want} by ${how} — free, done by software. The ${got} original is kept in its versions.`;
  say(ctx, opts, 'success', message);
  return done({ status: 'done', message });
}

const fitRenderHandler: ActionHandler<FitAction> = {
  type: 'fit_render',
  spend: false,
  run: runFitRender
};

export const TIMELINE_ACTIONS: ActionHandler[] = [fitRenderHandler as unknown as ActionHandler];
