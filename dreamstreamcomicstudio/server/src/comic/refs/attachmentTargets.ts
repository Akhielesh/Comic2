// Composer quick-assign ("Who's this?") — refs.md §4.4. Owner: P1-REFS.
//
// targets[i] belongs to attachments[i]; null = leave it to the director. The assignment is
// committed deterministically BEFORE the director turn, and the returned note is appended to
// the user's turn ("Images 1–3 → MAYA; image 4 → BRUNO (new character).") so the director only
// confirms and enriches the look — it never has to guess what the user already said.

import { newId, resolveCharacter, type CastKind, type ComicDoc, type RefAsset, type RefOwner } from '../../../../shared/comic/doc.js';
import type { AttachmentTarget } from '../../../../shared/comic/events.js';
import { applyOp, type DocOp } from '../../../../shared/comic/ops.js';
import { DOC_LIMITS } from '../../../../shared/comic/limits.js';
import { refOwnerKey, refsOf, totalRefs } from '../../../../shared/comic/refs.js';
import type { StudioContext } from '../types.js';
import { imagesWord, ownerName, planRefAdds, upperName } from './addRefs.js';

const CAST_KIND_SET = new Set<CastKind>(['person', 'animal', 'creature', 'robot', 'toy', 'vehicle', 'object']);

interface Group {
  owner: RefOwner;
  name: string;
  isNew: boolean;
  refs: RefAsset[];
  numbers: number[];
}

/**
 * Quick-assign attachments the user tagged in the composer. A new character is created once
 * per name (an existing cast member with that name is reused, case-insensitively). Never past
 * the caps; the note says what happened, including anything that did not fit.
 */
export async function applyAttachmentTargets(
  ctx: StudioContext,
  attachments: RefAsset[],
  targets: AttachmentTarget[]
): Promise<{ ops: DocOp[]; note: string }> {
  let doc: ComicDoc = ctx.session.doc;
  const ops: DocOp[] = [];
  const notes: string[] = [];
  const groups = new Map<string, Group>();
  const newCast = new Map<string, { id: string; name: string }>();
  const missing: number[] = [];

  (Array.isArray(targets) ? targets : []).forEach((target, i) => {
    const ref = attachments?.[i];
    if (!target || typeof target !== 'object' || !ref?.path) return;
    let owner: RefOwner;
    let name: string | undefined;
    let isNew = false;
    if (target.kind === 'new_character') {
      const wanted = String(target.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!wanted) return;
      const found = resolveCharacter(doc, wanted);
      if (found) {
        owner = { kind: 'character', id: found.id };
        name = upperName(found.name);
      } else {
        const key = wanted.toLowerCase();
        let entry = newCast.get(key);
        if (!entry) {
          if (doc.cast.length >= DOC_LIMITS.cast) {
            missing.push(i + 1);
            return;
          }
          entry = { id: newId('c'), name: wanted };
          newCast.set(key, entry);
          const kind = target.castKind && CAST_KIND_SET.has(target.castKind) ? target.castKind : undefined;
          const op: DocOp = {
            op: 'character',
            id: entry.id,
            patch: { name: wanted, tier: doc.cast.some((c) => c.tier === 'lead') ? 'support' : 'lead', look: { summary: '' }, ...(kind ? { kind } : {}) }
          };
          ops.push(op);
          doc = applyOp(doc, op);
          notes.push(`Added ${upperName(wanted)} to the cast.`);
        }
        owner = { kind: 'character', id: entry.id };
        name = upperName(entry.name);
        isNew = true;
      }
    } else if (target.kind === 'inbox') {
      return;
    } else {
      owner = target;
      name = ownerName(doc, owner);
    }
    if (!name || !refsOf(doc, owner)) {
      missing.push(i + 1);
      return;
    }
    const key = refOwnerKey(owner);
    const group = groups.get(key) || { owner, name, isNew, refs: [], numbers: [] };
    group.refs.push(ref);
    group.numbers.push(i + 1);
    groups.set(key, group);
  });

  let projectUsed = totalRefs(doc);
  const assigned: string[] = [];
  for (const group of groups.values()) {
    const planned = planRefAdds(doc, group.owner, group.refs, {}, { projectUsed, name: group.name });
    projectUsed = planned.projectUsed;
    ops.push(...planned.ops);
    for (const op of planned.ops) doc = applyOp(doc, op);
    const who = group.owner.kind === 'style' ? 'the style' : `${group.name}${group.isNew ? ' (new character)' : ''}`;
    assigned.push(`${imagesWord(group.numbers)} → ${who}`);
    // Only spell out the counts when something did not go in.
    if (planned.skipped || planned.duplicates || !planned.added) notes.push(planned.message);
  }
  const parts: string[] = [];
  if (assigned.length) parts.push(`${assigned.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()));
  parts.push(...notes);
  if (missing.length) parts.push(`${imagesWord(missing).replace(/^./, (c) => c.toUpperCase())}: that owner no longer exists, so I left ${missing.length === 1 ? 'it' : 'them'} unassigned.`);
  return { ops, note: parts.join(' ') };
}
