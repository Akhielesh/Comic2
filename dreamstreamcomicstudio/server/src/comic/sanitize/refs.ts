// Client-patch sanitizers "refs" (contract §5.4 / §12.1; refs.md §2.2): ref_add, ref_patch,
// ref_move, ref_remove, ref_transfer. Owner: P1-REFS.
//
// Path-addressed ops commute with server commits (an upload landing, the director attaching),
// unlike the old whole-array `refs` patches. Rules:
//   ref_add       only a path this comic already holds ("Use as reference" from a page, a sheet or
//                 the media bin), or this project's own private ref lane (Undo of a remove). The server
//                 REBUILDS the ref: client-sent hash/dhash/quality/caption/subject/safety/original/crop
//                 are dropped; metadata is copied from where the path already lives. Blocked or
//                 quarantined images are refused. Never into the inbox (uploads only).
//   ref_patch     label (a known label, or null) and note (≤ 140, one line, or null) only.
//   ref_move      the owner and the path exist; `to` is clamped.
//   ref_remove    idempotent (an already-removed photo is a no-op).
//   ref_transfer  both owners exist; never into the inbox; the destination's capacity is checked.
// Caps are never silent: a full owner or comic answers 409 LIMIT with the limit in the message.
// A batch keeps a running count, so two adds in one patch cannot squeeze past a cap together.
// Free text (notes) is then screened by the safety patch screen with every other op's text.

import { collectAssetPaths, mapAssetRefs, type AssetRef, type ComicDoc, type RefAsset, type RefOwner } from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import { SAFE_ID_RE } from '../../../../shared/comic/ops.js';
import { REF_LABELS_FOR, REF_LIMITS, capFor, findRefOwners, isRefLabel, refOwnerKey, refsOf, totalRefs } from '../../../../shared/comic/refs.js';
import { canServeToOwner } from '../../../../shared/comic/safety.js';
import type { OpSanitizer, SanitizeCtx } from '../extensions.js';
import { StudioError } from '../types.js';
import { cleanNote, limitMessage, ownerName } from '../refs/addRefs.js';

type Op<K extends DocOp['op']> = Extract<DocOp, { op: K }>;

const bad = (message: string) => new StudioError('BAD_REQUEST', message, { status: 400 });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A well-formed owner (ids must be safe ids). Throws 400 otherwise. */
const ownerArg = (raw: unknown, what = 'owner'): RefOwner => {
  if (!isObject(raw)) throw bad(`Invalid photo ${what}.`);
  if (raw.kind === 'style') return { kind: 'style' };
  if (raw.kind === 'inbox') return { kind: 'inbox' };
  if ((raw.kind === 'character' || raw.kind === 'place') && typeof raw.id === 'string' && SAFE_ID_RE.test(raw.id)) {
    return { kind: raw.kind, id: raw.id };
  }
  throw bad(`Invalid photo ${what}.`);
};

const missingOwner = (owner: RefOwner) =>
  bad(owner.kind === 'character' ? 'That character is no longer in the cast.' : owner.kind === 'place' ? 'That place is no longer in the story.' : 'Invalid photo owner.');

/** The owner's ref list, or a 400 when the owner no longer exists. */
const listOf = (doc: ComicDoc, owner: RefOwner): RefAsset[] => {
  const refs = refsOf(doc, owner);
  if (!refs) throw missingOwner(owner);
  return refs;
};

const pathArg = (v: unknown): string => {
  if (typeof v !== 'string' || !v || v.length > 512 || v.includes('..') || /[\u0000-\u001f\\]/.test(v)) throw bad('Invalid photo path.');
  return v;
};

/** A label this owner can carry (character views for a character, place views for a place, …). */
const labelFits = (owner: RefOwner, v: unknown): v is NonNullable<RefAsset['label']> =>
  isRefLabel(v) && (owner.kind === 'inbox' || REF_LABELS_FOR[owner.kind].includes(v));

const indexArg = (v: unknown): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('Invalid photo position.');
  return Math.max(0, Math.min(REF_LIMITS.project, Math.floor(v)));
};

// ── Batch bookkeeping (running counts per sanitize call) ─────────────────────

interface BatchCounts {
  doc: ComicDoc;
  owner: Map<string, number>;
  project: number;
}
const batches = new WeakMap<object, BatchCounts>();

/** Running deltas for this patch batch (the same SanitizeCtx object is passed for every op of a batch). */
const batchFor = (doc: ComicDoc, ctx: SanitizeCtx): BatchCounts => {
  const key = ctx as unknown as object;
  const hit = key && typeof key === 'object' ? batches.get(key) : undefined;
  if (hit && hit.doc === doc) return hit;
  const fresh: BatchCounts = { doc, owner: new Map(), project: 0 };
  if (key && typeof key === 'object') batches.set(key, fresh);
  return fresh;
};

/** 409 LIMIT unless one more ref fits on `owner` (and in the comic, unless it is only moving). */
const ensureRoom = (doc: ComicDoc, owner: RefOwner, batch: BatchCounts, opts: { projectNeutral?: boolean } = {}) => {
  const key = refOwnerKey(owner);
  const have = listOf(doc, owner).length + (batch.owner.get(key) || 0);
  if (have >= capFor(owner)) throw new StudioError('LIMIT', limitMessage(doc, owner), { status: 409 });
  if (!opts.projectNeutral && totalRefs(doc) + batch.project >= REF_LIMITS.project) {
    throw new StudioError('LIMIT', limitMessage(doc, owner, 'project'), { status: 409 });
  }
};

const count = (batch: BatchCounts, owner: RefOwner, delta: number, projectDelta = delta) => {
  const key = refOwnerKey(owner);
  batch.owner.set(key, (batch.owner.get(key) || 0) + delta);
  batch.project += projectDelta;
};

// ── ref_add rebuild ──────────────────────────────────────────────────────────

const SERVER_KEYS = ['w', 'h', 'source', 'model', 'at', 'variants', 'safety', 'libraryId', 'derivedFrom'] as const;
const REF_META_KEYS = ['caption', 'subject', 'hash', 'dhash', 'quality', 'name', 'original', 'crop', 'label', 'note'] as const;

/** The first AssetRef in the doc with this path (pages, sheets, refs, attachments, archive…). */
const assetAt = (doc: ComicDoc, path: string): AssetRef | undefined => {
  let found: AssetRef | undefined;
  mapAssetRefs(doc, (a) => {
    if (!found && a?.path === path) found = a;
    return a;
  });
  return found;
};

/** The same ref on another owner (keeps its labels, hash, safety… when re-used). */
const refElsewhere = (doc: ComicDoc, path: string): RefAsset | undefined => {
  for (const owner of findRefOwners(doc, path)) {
    const ref = refsOf(doc, owner)?.find((r) => r.path === path);
    if (ref) return ref;
  }
  return undefined;
};

/** u/<user>/p/<project>/ref/<id>.webp of THIS user and THIS project (the private upload lane). */
const isOwnRefLane = (path: string, ctx: SanitizeCtx, doc: ComicDoc): boolean => {
  if (!ctx?.userId || !doc?.id) return false;
  const m = /^u\/([^/]+)\/p\/([^/]+)\/ref\/[A-Za-z0-9_-]{1,80}\.webp$/.exec(path);
  return !!m && m[1] === ctx.userId && m[2] === doc.id;
};

const refAdd: OpSanitizer<Op<'ref_add'>> = {
  op: 'ref_add',
  sanitize(doc, op, ctx) {
    const owner = ownerArg(op.owner);
    if (owner.kind === 'inbox') throw bad('Photos reach the inbox by uploading them.');
    const refs = listOf(doc, owner);
    if (!isObject(op.ref)) throw bad('Invalid photo.');
    const path = pathArg(op.ref.path);
    const index = indexArg(op.index);
    if (refs.some((r) => r.path === path)) {
      // Already there: a harmless no-op (applyOp skips it).
      return { op: 'ref_add', owner, ref: refs.find((r) => r.path === path)!, ...(index !== undefined ? { index } : {}) };
    }
    const known = new Set(collectAssetPaths(doc));
    const source = refElsewhere(doc, path) ?? assetAt(doc, path);
    if (!known.has(path) && !isOwnRefLane(path, ctx, doc)) throw bad("That image isn't part of this comic.");
    if (source && (!canServeToOwner(source) || source.safety?.quarantined)) {
      throw new StudioError('CONTENT_POLICY', "That image didn't pass the content check, so it can't be used as a reference.", { status: 422 });
    }
    const batch = batchFor(doc, ctx);
    ensureRoom(doc, owner, batch);
    const now = ctx?.now ?? Date.now();
    const ref: RefAsset = { path, source: 'upload', at: now, addedBy: 'user' };
    if (source) {
      for (const k of SERVER_KEYS) if (source[k] !== undefined) (ref as unknown as Record<string, unknown>)[k] = source[k];
      const asRef = source as RefAsset;
      for (const k of REF_META_KEYS) if (asRef[k] !== undefined) (ref as unknown as Record<string, unknown>)[k] = asRef[k];
      ref.at = now;
    }
    // The client may name the view and add a note; everything else it sent is ignored.
    if (labelFits(owner, op.ref.label)) ref.label = op.ref.label;
    else if (ref.label && !labelFits(owner, ref.label)) delete ref.label; // a view copied from another owner that does not fit here
    const note = cleanNote(op.ref.note);
    if (note) ref.note = note;
    if (!ref.addedBy || ref.addedBy === 'director') ref.addedBy = 'user';
    count(batch, owner, 1);
    return { op: 'ref_add', owner, ref, ...(index !== undefined ? { index } : {}) };
  }
};

const PATCHABLE = new Set(['label', 'note']);

const refPatch: OpSanitizer<Op<'ref_patch'>> = {
  op: 'ref_patch',
  sanitize(doc, op) {
    const owner = ownerArg(op.owner);
    const path = pathArg(op.path);
    if (!listOf(doc, owner).some((r) => r.path === path)) throw bad(`That photo is no longer on ${ownerName(doc, owner) || 'it'}.`);
    if (!isObject(op.patch)) throw bad('Nothing to change.');
    const keys = Object.keys(op.patch);
    if (!keys.length) throw bad('Nothing to change.');
    const extra = keys.filter((k) => !PATCHABLE.has(k));
    if (extra.length) throw bad('Only the label and the note of a photo can be changed here.');
    const patch: Op<'ref_patch'>['patch'] = {};
    if ('label' in op.patch) {
      const v = op.patch.label as unknown;
      if (v === null || v === '') (patch as Record<string, unknown>).label = null;
      else if (labelFits(owner, v)) patch.label = v;
      else throw bad(isRefLabel(v) ? `That label doesn't fit ${ownerName(doc, owner) || 'this owner'}.` : 'Unknown photo label.');
    }
    if ('note' in op.patch) {
      const v = op.patch.note as unknown;
      if (v === null || v === '') (patch as Record<string, unknown>).note = null;
      else if (typeof v === 'string') {
        const note = cleanNote(v);
        if (note) patch.note = note;
        else (patch as Record<string, unknown>).note = null;
      } else throw bad('Invalid photo note.');
    }
    return { op: 'ref_patch', owner, path, patch };
  }
};

const refMove: OpSanitizer<Op<'ref_move'>> = {
  op: 'ref_move',
  sanitize(doc, op) {
    const owner = ownerArg(op.owner);
    const path = pathArg(op.path);
    const refs = listOf(doc, owner);
    if (!refs.some((r) => r.path === path)) throw bad(`That photo is no longer on ${ownerName(doc, owner) || 'it'}.`);
    const to = indexArg(op.to);
    if (to === undefined) throw bad('Invalid photo position.');
    return { op: 'ref_move', owner, path, to: Math.min(to, Math.max(0, refs.length - 1)) };
  }
};

const refRemove: OpSanitizer<Op<'ref_remove'>> = {
  op: 'ref_remove',
  sanitize(doc, op, ctx) {
    const owner = ownerArg(op.owner);
    const path = pathArg(op.path);
    const refs = refsOf(doc, owner);
    // Idempotent: removing a photo that is already gone (or whose owner was deleted) changes nothing.
    if (refs?.some((r) => r.path === path)) count(batchFor(doc, ctx), owner, -1);
    return { op: 'ref_remove', owner, path };
  }
};

const refTransfer: OpSanitizer<Op<'ref_transfer'>> = {
  op: 'ref_transfer',
  sanitize(doc, op, ctx) {
    const from = ownerArg(op.from, 'source');
    const to = ownerArg(op.to, 'destination');
    if (to.kind === 'inbox') throw bad('Photos reach the inbox by uploading them.');
    if (refOwnerKey(from) === refOwnerKey(to)) throw bad('That photo is already there.');
    const path = pathArg(op.path);
    if (!listOf(doc, from).some((r) => r.path === path)) throw bad(`That photo is no longer on ${ownerName(doc, from) || 'it'}.`);
    if (listOf(doc, to).some((r) => r.path === path)) {
      throw new StudioError('CONFLICT', `That photo is already on ${ownerName(doc, to)} — remove it from ${ownerName(doc, from)} instead.`, { status: 409 });
    }
    const batch = batchFor(doc, ctx);
    ensureRoom(doc, to, batch, { projectNeutral: true });
    count(batch, to, 1, 0);
    count(batch, from, -1, 0);
    const index = indexArg(op.index);
    return { op: 'ref_transfer', from, to, path, ...(index !== undefined ? { index } : {}) };
  }
};

export const REFS_SANITIZERS: OpSanitizer[] = [
  refAdd as unknown as OpSanitizer,
  refPatch as unknown as OpSanitizer,
  refMove as unknown as OpSanitizer,
  refRemove as unknown as OpSanitizer,
  refTransfer as unknown as OpSanitizer
];
