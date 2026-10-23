// Honest reference adds (refs.md §3, §4.9; contract §12.8). Owner: P1-REFS.
//
// Every way a reference image reaches an owner (director tools, composer quick-assign, the
// upload endpoint, client patches) plans through here, so the caps are enforced in ONE place
// and the result always SAYS what happened: "Added 4 of 6 photos to MAYA (limit 12)." —
// never the old silent `slice(-4)` / truncate-to-12.

import type { ComicDoc, RefAsset, RefLabel, RefOwner } from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import { REF_LIMITS, capFor, isRefLabel, refsOf, totalRefs } from '../../../../shared/comic/refs.js';
import type { StudioContext } from '../types.js';

export type AddOpts = {
  /** 0-based insert position for the first added ref (0 = main). */
  index?: number;
  /** Per-input-index label / note (indexes into the `refs` argument). */
  labels?: Record<number, { label?: RefLabel; note?: string }>;
  /** Input index of the ref to make the main one (moved first, inserted at 0). */
  mainIndex?: number;
};

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
export const upperName = (s?: string): string => (s || '').trim().toUpperCase() || 'UNNAMED';

/** "1–3, 5" for a list of 1-based numbers. */
export const numberRanges = (ns: number[]): string => {
  const sorted = [...new Set(ns.filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return parts.join(', ');
};

/** "image 3" / "images 1–3, 5" */
export const imagesWord = (ns: number[]): string => `${ns.length === 1 ? 'image' : 'images'} ${numberRanges(ns)}`;

/** How the user would name this owner in a sentence (undefined = the owner no longer exists). */
export const ownerName = (doc: ComicDoc, owner: RefOwner): string | undefined => {
  switch (owner?.kind) {
    case 'character': {
      const c = doc.cast.find((x) => x.id === owner.id);
      return c ? upperName(c.name) : undefined;
    }
    case 'place': {
      const p = doc.places.find((x) => x.id === owner.id);
      return p ? upperName(p.name) : undefined;
    }
    case 'style':
      return 'the style';
    case 'inbox':
      return 'your unassigned images';
    default:
      return undefined;
  }
};

/** A user/director note: one line, no control characters, ≤ REF_LIMITS.noteChars. */
export const cleanNote = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, REF_LIMITS.noteChars).trim() : undefined;
};

/** A sanitized original filename (`[\w .()-]`, ≤ REF_LIMITS.nameChars), or undefined. */
export const cleanFileName = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const base = v.split(/[\\/]/).pop() || '';
  const t = base.replace(/[^\w .()-]+/g, '_').replace(/_+/g, '_').replace(/\s+/g, ' ').trim().slice(0, REF_LIMITS.nameChars).trim();
  return t && !/^[._ -]+$/.test(t) ? t : undefined;
};

/** Room left on an owner and in the whole comic (`pending` = adds already reserved elsewhere). */
export const roomFor = (doc: ComicDoc, owner: RefOwner, pending: { owner?: number; project?: number } = {}): { owner: number; project: number } => {
  const refs = refsOf(doc, owner);
  if (!refs) return { owner: 0, project: 0 };
  return {
    owner: Math.max(0, capFor(owner) - refs.length - (pending.owner || 0)),
    project: Math.max(0, REF_LIMITS.project - totalRefs(doc) - (pending.project || 0))
  };
};

/** The honest 409 copy for a full owner (or the whole comic when `project`). */
export const limitMessage = (doc: ComicDoc, owner: RefOwner, which: 'owner' | 'project' = 'owner'): string => {
  if (which === 'project') {
    return `This comic already has ${REF_LIMITS.project} reference photos (the limit) — remove some to add more.`;
  }
  const cap = capFor(owner);
  switch (owner.kind) {
    case 'inbox':
      return `You have ${cap} photos waiting to be sent or assigned (the limit) — send or assign them first.`;
    case 'style':
      return `The style already has ${cap} reference images (the limit) — remove one to add another.`;
    default:
      return `${ownerName(doc, owner) || 'That character'} already has ${cap} photos (the limit) — remove one to add another.`;
  }
};

export interface PlannedAdds {
  ops: DocOp[];
  added: number;
  /** Not added because a cap was reached. */
  skipped: number;
  /** Already on this owner (same path or the same original file). */
  duplicates: number;
  message: string;
  /** Project ref count after these adds (lets a batch keep counting across owners). */
  projectUsed: number;
  /** The refs that were added, in insert order. */
  refs: RefAsset[];
}

/**
 * Plan ref_add ops (plus one ref_move when the chosen main photo is already there) for one owner against `doc` (which may be a simulated doc with an owner
 * created earlier in the same batch). Never past the owner cap or the project cap; duplicates
 * (same path, or the same original file by `hash`) are skipped and counted; the message says
 * exactly what happened.
 */
export function planRefAdds(
  doc: ComicDoc,
  owner: RefOwner,
  refs: RefAsset[],
  opts: AddOpts = {},
  counts: { projectUsed?: number; name?: string } = {}
): PlannedAdds {
  const existing = refsOf(doc, owner);
  const name = counts.name ?? ownerName(doc, owner);
  let projectUsed = counts.projectUsed ?? totalRefs(doc);
  if (!existing || !name) {
    const n = (refs || []).filter((r) => !!r?.path).length;
    return { ops: [], added: 0, skipped: n, duplicates: 0, message: 'That reference owner no longer exists.', projectUsed, refs: [] };
  }
  const cap = capFor(owner);
  const seenPaths = new Set(existing.map((r) => r.path));
  const seenHashes = new Set(existing.map((r) => r.hash).filter((h): h is string => !!h));
  const ordered = (refs || []).map((ref, i) => ({ ref, i })).filter(({ ref }) => !!ref && typeof ref.path === 'string' && !!ref.path);
  // The chosen main photo goes first, at index 0.
  if (opts.mainIndex !== undefined) {
    const at = ordered.findIndex((x) => x.i === opts.mainIndex);
    if (at > 0) ordered.unshift(...ordered.splice(at, 1));
  }
  const ops: DocOp[] = [];
  const added: RefAsset[] = [];
  let have = existing.length;
  let duplicates = 0;
  let projectFull = false;
  // Only the main photo jumps to the front; the others keep the owner's order (appended, or from
  // opts.index), so photos the user already ranked are not pushed down by a batch of new ones.
  let index = typeof opts.index === 'number' && Number.isFinite(opts.index) ? Math.max(0, Math.floor(opts.index)) : undefined;
  for (const { ref, i } of ordered) {
    const isMain = opts.mainIndex !== undefined && i === opts.mainIndex;
    if (seenPaths.has(ref.path) || (ref.hash && seenHashes.has(ref.hash))) {
      duplicates += 1;
      // The chosen main photo is already here: make it the main one rather than ignoring the choice.
      if (isMain) {
        const there = existing.find((r) => r.path === ref.path) || existing.find((r) => !!ref.hash && r.hash === ref.hash);
        if (there && existing[0]?.path !== there.path) ops.push({ op: 'ref_move', owner, path: there.path, to: 0 });
      }
      continue;
    }
    if (have >= cap) continue;
    if (projectUsed >= REF_LIMITS.project) {
      projectFull = true;
      continue;
    }
    const extra = opts.labels?.[i];
    const next: RefAsset = { ...ref };
    if (extra?.label && isRefLabel(extra.label)) next.label = extra.label;
    const note = cleanNote(extra?.note);
    if (note) next.note = note;
    else if (typeof next.note === 'string') {
      const kept = cleanNote(next.note);
      if (kept) next.note = kept;
      else delete next.note;
    }
    const at = isMain ? 0 : index;
    ops.push({ op: 'ref_add', owner, ref: next, ...(at !== undefined ? { index: at } : {}) });
    added.push(next);
    // Everything after an insert shifts by one.
    if (index !== undefined) index += 1;
    seenPaths.add(next.path);
    if (next.hash) seenHashes.add(next.hash);
    have += 1;
    projectUsed += 1;
  }
  const n = ordered.length;
  const skipped = Math.max(0, n - added.length - duplicates);
  const what = plural(n, 'photo');
  let message: string;
  if (!n) message = 'No images to add.';
  else if (!added.length && duplicates === n) message = `${n === 1 ? 'That photo is' : 'Those photos are'} already on ${name}.`;
  else if (!added.length && (projectFull || projectUsed >= REF_LIMITS.project)) message = limitMessage(doc, owner, 'project');
  else if (!added.length) message = `${name} already has ${cap} reference images (the limit) — remove one to add another.`;
  else if (skipped > 0) message = `Added ${added.length} of ${what} to ${name} (limit ${projectFull ? `${REF_LIMITS.project} per comic` : cap}).`;
  else message = `Added ${plural(added.length, 'photo')} to ${name}${duplicates ? ` (${duplicates} already there)` : ''}.`;
  return { ops, added: added.length, skipped, duplicates, message, projectUsed, refs: added };
}

/** Add reference images to an owner, honestly: never past the caps, always says what happened. */
export async function addRefs(
  ctx: StudioContext,
  owner: RefOwner,
  refs: RefAsset[],
  opts: AddOpts = {}
): Promise<{ ops: DocOp[]; added: number; skipped: number; message: string }> {
  const planned = planRefAdds(ctx.session.doc, owner, refs || [], opts);
  return { ops: planned.ops, added: planned.added, skipped: planned.skipped, message: planned.message };
}
