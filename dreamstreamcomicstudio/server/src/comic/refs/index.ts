// Multi-reference seams (contract §12.8, refs.md). Wave-0 stub by P0-B; owned in wave 1 by
// P1-REFS, which replaces every function IN PLACE (same names, same signatures).
//
// Stub behaviour (buildplan §10): addRefs is honest-minimal — it appends up to the owner's
// cap and the project cap and SAYS how many were added ("Added 4 of 6 photos to MAYA
// (limit 12)") instead of silently dropping the rest. takeInbox / applyAttachmentTargets are
// real-minimal. carriedImages → [] and refIntentHint → undefined (no carry-over yet).

import { newId, refInboxOf, resolveCharacter, type CastKind, type ComicDoc, type RefAsset, type RefOwner } from '../../../../shared/comic/doc.js';
import type { AttachmentTarget } from '../../../../shared/comic/events.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import { REF_LIMITS, capFor, isRefLabel, refOwnerKey, refsOf, totalRefs } from '../../../../shared/comic/refs.js';
import { StudioError, type StudioContext } from '../types.js';

type AddOpts = { index?: number; labels?: Record<number, { label?: RefAsset['label']; note?: string }>; mainIndex?: number };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const upper = (s?: string) => (s || '').trim().toUpperCase() || 'UNNAMED';

/** How the user would name this owner in a sentence. */
const ownerName = (doc: ComicDoc, owner: RefOwner): string | undefined => {
  switch (owner.kind) {
    case 'character':
      return doc.cast.find((c) => c.id === owner.id) ? upper(doc.cast.find((c) => c.id === owner.id)!.name) : undefined;
    case 'place':
      return doc.places.find((p) => p.id === owner.id) ? upper(doc.places.find((p) => p.id === owner.id)!.name) : undefined;
    case 'style':
      return 'the style';
    case 'inbox':
      return 'your unassigned images';
    default:
      return undefined;
  }
};

/**
 * Plan ref_add ops for one owner. `existing` / `projectUsed` let a batch keep counting
 * across several calls before anything is committed.
 */
function planAdds(
  doc: ComicDoc,
  owner: RefOwner,
  refs: RefAsset[],
  opts: AddOpts,
  name: string,
  counts: { existing: RefAsset[]; projectUsed: number }
): { ops: DocOp[]; added: number; skipped: number; message: string; projectUsed: number } {
  const cap = capFor(owner);
  const seen = new Set(counts.existing.map((r) => r.path));
  const ordered = refs.map((ref, i) => ({ ref, i })).filter(({ ref }) => !!ref?.path);
  // The chosen main photo goes first, at index 0.
  if (opts.mainIndex !== undefined) {
    const at = ordered.findIndex((x) => x.i === opts.mainIndex);
    if (at > 0) ordered.unshift(...ordered.splice(at, 1));
  }
  const ops: DocOp[] = [];
  let have = counts.existing.length;
  let projectUsed = counts.projectUsed;
  let duplicates = 0;
  let index = opts.mainIndex !== undefined ? 0 : opts.index;
  for (const { ref, i } of ordered) {
    if (seen.has(ref.path)) {
      duplicates += 1;
      continue;
    }
    if (have >= cap || projectUsed >= REF_LIMITS.project) continue;
    const extra = opts.labels?.[i];
    const next: RefAsset = { ...ref };
    if (extra?.label && isRefLabel(extra.label)) next.label = extra.label;
    if (typeof extra?.note === 'string' && extra.note.trim()) next.note = extra.note.trim().slice(0, REF_LIMITS.noteChars);
    ops.push({ op: 'ref_add', owner, ref: next, ...(index !== undefined ? { index } : {}) });
    if (index !== undefined) index += 1;
    seen.add(ref.path);
    have += 1;
    projectUsed += 1;
  }
  const added = ops.length;
  const skipped = ordered.length - added - duplicates;
  const what = plural(ordered.length, 'photo');
  let message: string;
  if (!ordered.length) message = 'No images to add.';
  else if (!added && duplicates === ordered.length) message = `${ordered.length === 1 ? 'That photo is' : 'Those photos are'} already on ${name}.`;
  else if (!added && projectUsed >= REF_LIMITS.project) message = `This comic already has ${REF_LIMITS.project} reference images (the limit) — remove some to add more.`;
  else if (!added) message = `${name} already has ${cap} reference images (the limit) — remove one to add another.`;
  else if (skipped > 0) message = `Added ${added} of ${what} to ${name} (limit ${projectUsed >= REF_LIMITS.project ? `${REF_LIMITS.project} per comic` : cap}).`;
  else message = `Added ${plural(added, 'photo')} to ${name}${duplicates ? ` (${duplicates} already there)` : ''}.`;
  return { ops, added, skipped: Math.max(0, skipped), message, projectUsed };
}

/** Add reference images to an owner, honestly: never past the caps, always says what happened. */
export async function addRefs(
  ctx: StudioContext,
  owner: RefOwner,
  refs: RefAsset[],
  opts: AddOpts = {}
): Promise<{ ops: DocOp[]; added: number; skipped: number; message: string }> {
  const doc = ctx.session.doc;
  const name = ownerName(doc, owner);
  const existing = refsOf(doc, owner);
  if (!name || !existing) {
    return { ops: [], added: 0, skipped: refs.length, message: 'That reference owner no longer exists.' };
  }
  const { ops, added, skipped, message } = planAdds(doc, owner, refs || [], opts, name, { existing, projectUsed: totalRefs(doc) });
  return { ops, added, skipped, message };
}

/**
 * Move images the composer uploaded to the inbox into this message's attachments
 * (ref_remove from the inbox; the message op then carries the RefAssets). A path that is
 * not in this project's inbox is refused (400) — clients can never smuggle other paths.
 */
export async function takeInbox(ctx: StudioContext, inboxPaths: string[]): Promise<{ attachments: RefAsset[]; ops: DocOp[] }> {
  const inbox = refInboxOf(ctx.session.doc);
  const attachments: RefAsset[] = [];
  const ops: DocOp[] = [];
  const seen = new Set<string>();
  for (const path of inboxPaths || []) {
    if (typeof path !== 'string' || seen.has(path)) continue;
    const ref = inbox.find((r) => r.path === path);
    if (!ref) throw new StudioError('BAD_REQUEST', 'One of the images is no longer waiting to be sent — attach it again.', { status: 400 });
    seen.add(path);
    attachments.push(ref);
    ops.push({ op: 'ref_remove', owner: { kind: 'inbox' }, path });
  }
  if (attachments.length > REF_LIMITS.perMessageImages) {
    throw new StudioError('BAD_REQUEST', `Send up to ${REF_LIMITS.perMessageImages} images per message.`, { status: 400 });
  }
  return { attachments, ops };
}

/**
 * Quick-assign attachments the user tagged in the composer ("Who's this?"): targets[i]
 * applies to attachments[i]; null = leave it to the director. A new character is created
 * once per name (an existing cast member with that name is reused).
 */
export async function applyAttachmentTargets(
  ctx: StudioContext,
  attachments: RefAsset[],
  targets: AttachmentTarget[]
): Promise<{ ops: DocOp[]; note: string }> {
  const doc = ctx.session.doc;
  const ops: DocOp[] = [];
  const notes: string[] = [];
  const groups = new Map<string, { owner: RefOwner; name: string; refs: RefAsset[]; existing: RefAsset[] }>();
  const newCast = new Map<string, string>();
  (targets || []).forEach((target, i) => {
    const ref = attachments?.[i];
    if (!target || !ref?.path) return;
    let owner: RefOwner;
    let name: string | undefined;
    let existing: RefAsset[] | undefined;
    if (target.kind === 'new_character') {
      const wanted = String(target.name || '').trim().slice(0, 80);
      if (!wanted) return;
      const found = resolveCharacter(doc, wanted);
      if (found) {
        owner = { kind: 'character', id: found.id };
        name = upper(found.name);
        existing = found.refs;
      } else {
        const key = wanted.toLowerCase();
        let id = newCast.get(key);
        if (!id) {
          id = newId('c');
          newCast.set(key, id);
          const kind: CastKind | undefined = target.castKind;
          ops.push({
            op: 'character',
            id,
            patch: { name: wanted, tier: doc.cast.some((c) => c.tier === 'lead') ? 'support' : 'lead', look: { summary: '' }, ...(kind ? { kind } : {}) }
          });
          notes.push(`Added ${upper(wanted)} to the cast.`);
        }
        owner = { kind: 'character', id };
        name = upper(wanted);
        existing = [];
      }
    } else {
      owner = target;
      name = ownerName(doc, owner);
      existing = refsOf(doc, owner);
    }
    if (!name || !existing) return;
    const key = refOwnerKey(owner);
    const group = groups.get(key) || { owner, name, refs: [], existing };
    group.refs.push(ref);
    groups.set(key, group);
  });
  let projectUsed = totalRefs(doc);
  for (const group of groups.values()) {
    const planned = planAdds(doc, group.owner, group.refs, {}, group.name, { existing: group.existing, projectUsed });
    projectUsed = planned.projectUsed;
    ops.push(...planned.ops);
    notes.push(planned.message);
  }
  return { ops, note: notes.join(' ') };
}

/** Unassigned images from the previous user turns (numbering continues). Stub: none carried. */
export function carriedImages(_doc: ComicDoc, _current: RefAsset[]): RefAsset[] {
  return [];
}

/** Free regex pre-pass: what the user probably wants done with the images. Stub: no hint. */
export function refIntentHint(_text: string, _imageCount: number): string | undefined {
  return undefined;
}
