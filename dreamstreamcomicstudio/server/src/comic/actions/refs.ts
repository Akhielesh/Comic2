// Feature action "refs" (contract §12.1; refs.md §3 auto-crop): ref_crop. Owner: P1-REFS.
//
//   ref_crop {owner, path, box?, aspect?}   free sharp crop of a reference photo — `box` (normalized,
//                                           user-dragged) or, without a box, an attention crop that
//                                           tightens to the subject ("Tighten to subject").
//   ref_crop {owner, path, reset: true}     restores the original photo.
//
// The crop is always cut from the ORIGINAL (re-cropping never compounds), stored as a new private
// /ref/ asset and committed as one `ref_patch {path, w, h, crop, original}` — the photo keeps its
// place, label, note and safety verdict (same pixels, a subset). The original stays referenced, so
// the GC keeps it and "Reset crop" swaps it back. $0, no model call.

import { newId, type Card, type Msg, type RefAsset, type RefOwner } from '../../../../shared/comic/doc.js';
import type { RefPatch, StudioAction } from '../../../../shared/comic/ops.js';
import { refsOf } from '../../../../shared/comic/refs.js';
import { logger } from '../../lib/logger.js';
import type { ActionHandler } from '../extensions.js';
import type { RunActionOptions, StartedAction } from '../jobs.js';
import { StudioError, type StudioContext } from '../types.js';
import { ownerName } from '../refs/addRefs.js';

type CropAction = Extract<StudioAction, { type: 'ref_crop' }>;

const ASPECTS = new Set(['1:1', '3:4', '4:3']);
const finished = (outcome: StartedAction['outcome']): StartedAction => ({ outcome, done: Promise.resolve() });

/** Tell the user (into the director's message when collecting, else as a short assistant note). */
const say = (ctx: StudioContext, opts: RunActionOptions | undefined, tone: 'info' | 'warn' | 'success', text: string) => {
  const card: Card = { type: 'notice', id: newId('card'), tone, text };
  if (opts?.collectCard) {
    opts.collectCard(card);
    return;
  }
  const msg: Msg = { id: newId('msg'), role: 'assistant', text, at: Date.now(), cards: [card] };
  ctx.session.commit([{ op: 'message', msg }], { origin: 'job' });
};

const validBox = (box: unknown): box is { x: number; y: number; w: number; h: number } => {
  if (!box || typeof box !== 'object') return false;
  const b = box as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (![b.x, b.y, b.w, b.h].every(ok)) return false;
  const { x, y, w, h } = b as { x: number; y: number; w: number; h: number };
  return x >= 0 && y >= 0 && w > 0.02 && h > 0.02 && x + w <= 1.0001 && y + h <= 1.0001;
};

const ownerOk = (o: unknown): o is RefOwner =>
  !!o &&
  typeof o === 'object' &&
  (((o as RefOwner).kind === 'style' || (o as RefOwner).kind === 'inbox') ||
    (((o as RefOwner).kind === 'character' || (o as RefOwner).kind === 'place') && typeof (o as { id?: unknown }).id === 'string'));

export async function runRefCrop(ctx: StudioContext, action: CropAction, opts?: RunActionOptions): Promise<StartedAction> {
  if (!ownerOk(action?.owner) || typeof action.path !== 'string' || !action.path) {
    throw new StudioError('BAD_REQUEST', 'Pick a photo to crop.', { status: 400 });
  }
  const owner = action.owner;
  const doc = ctx.session.doc;
  const name = ownerName(doc, owner);
  const ref = refsOf(doc, owner)?.find((r) => r.path === action.path);
  if (!name || !ref) {
    const message = "That photo isn't there any more, so nothing was cropped.";
    say(ctx, opts, 'info', message);
    return finished({ status: 'blocked', message, code: 'NOT_FOUND' });
  }
  const origin = opts?.origin ?? (opts?.collectCard ? 'director' : 'user');

  if (action.reset) {
    if (!ref.original?.path) {
      const message = 'That photo was never cropped — it is already the original.';
      return finished({ status: 'done', message });
    }
    const patch: RefPatch = { path: ref.original.path, w: ref.original.w, h: ref.original.h };
    const reset = { ...patch, crop: null, original: null, variants: null, dhash: null } as unknown as RefPatch;
    ctx.session.commit([{ op: 'ref_patch', owner, path: ref.path, patch: reset }], { origin, label: 'Reset crop' });
    void ctx.publishUrls([ref.original.path]).catch(() => undefined);
    return finished({ status: 'done', message: `Restored the original photo on ${name}.` });
  }

  if (action.box !== undefined && !validBox(action.box)) throw new StudioError('BAD_REQUEST', 'That crop box is outside the photo.', { status: 400 });
  if (action.aspect !== undefined && !ASPECTS.has(action.aspect)) throw new StudioError('BAD_REQUEST', 'Crop to 1:1, 3:4 or 4:3.', { status: 400 });
  const sourcePath = ref.original?.path || ref.path;
  let cropped: RefAsset;
  try {
    cropped = await ctx.assets.cropRef({
      userId: ctx.userId,
      projectId: ctx.projectId,
      path: sourcePath,
      ...(action.box ? { box: action.box } : {}),
      ...(action.aspect ? { aspect: action.aspect } : !action.box ? { aspect: '1:1' as const } : {})
    });
  } catch (err) {
    const why = err instanceof StudioError ? err.userMessage.replace(/[.!]+$/, '') : 'the image could not be processed';
    if (!(err instanceof StudioError)) logger.warn('comic_ref_crop_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
    const message = `I couldn't crop that photo: ${why}. Nothing was changed.`;
    say(ctx, opts, 'warn', message);
    return finished({ status: 'blocked', message, code: err instanceof StudioError ? err.code : 'INTERNAL' });
  }
  if (!cropped?.path) throw new StudioError('INTERNAL', "Cropping didn't produce an image. Nothing was changed.", { status: 500 });

  // The doc may have moved on while storage worked (the photo was removed or re-cropped).
  const now = refsOf(ctx.session.doc, owner)?.find((r) => r.path === ref.path);
  if (!now) {
    void ctx.assets.remove([cropped.path]).catch(() => undefined);
    const message = 'That photo changed while I was cropping it, so I left it as it is.';
    say(ctx, opts, 'info', message);
    return finished({ status: 'blocked', message, code: 'CONFLICT' });
  }
  const original = now.original?.path ? now.original : { path: sourcePath, ...(cropped.original?.w ? { w: cropped.original.w } : ref.w ? { w: ref.w } : {}), ...(cropped.original?.h ? { h: cropped.original.h } : ref.h ? { h: ref.h } : {}) };
  const patch = {
    path: cropped.path,
    w: cropped.w,
    h: cropped.h,
    original,
    crop: cropped.crop ?? action.box ?? null,
    // A crop changes the pixels: the old near-duplicate hash no longer describes it.
    dhash: null,
    variants: cropped.variants?.length ? cropped.variants : null
  } as unknown as RefPatch;
  ctx.session.commit([{ op: 'ref_patch', owner, path: ref.path, patch }], { origin, label: 'Crop photo' });
  void ctx.publishUrls([cropped.path, ...(cropped.variants || []).map((v) => v.path)]).catch(() => undefined);
  return finished({ status: 'done', message: `Cropped the photo on ${name} — free, done by software. "Reset crop" brings the original back.` });
}

const refCropHandler: ActionHandler<CropAction> = {
  type: 'ref_crop',
  spend: false,
  run: runRefCrop
};

export const REFS_ACTIONS: ActionHandler[] = [refCropHandler as unknown as ActionHandler];
