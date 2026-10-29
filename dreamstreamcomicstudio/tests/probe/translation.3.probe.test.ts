// @vitest-environment node
// Probe: Undo after "Remove the Telugu translation" and after editing a translated line.
//  (a) LanguagesTab removes an edition with studio.patch([{op:'edition', patch:null}]) (undoable). The
//      client's inverse (shared/comic/undo.ts case 'edition') is one `edition` op plus one `translation`
//      op per line. jobs.ts sanitizePatchOps validates every op against the doc BEFORE the batch, and
//      sanitize/i18n.ts sanitizeTranslation requires the edition to exist → the whole undo batch is a
//      400 → "Couldn't save your change" and the (paid) edition is gone for good.
//  (b) Undoing an edit of a reviewed line: the inverse restores the full previous entry, but the
//      sanitizer FORCES status 'edited' and clears gloss/issue/model — undo does not restore the state.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../shared/comic/doc.js';
import { editionReadiness, i18nOf, lineSourceHash } from '../../shared/comic/i18n.js';
import { applyOps, type DocOp } from '../../shared/comic/ops.js';
import { inverseOps, isUndoable } from '../../shared/comic/undo.js';
import { sanitizePatchOps } from '../../server/src/comic/jobs.js';
import { sixPageKidsDoc } from '../../server/src/comic/i18n/testing.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const lines = (doc: ComicDoc) => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));
function translated(lang = 'te'): ComicDoc {
  let d = applyOps(sixPageKidsDoc(), [{ op: 'edition', lang, patch: {} }]);
  const out: Record<string, { text: string; status: 'reviewed' | 'machine'; sourceHash: string; at: number; gloss?: string; issue?: { severity: 'major'; note: string } }> = {};
  for (const l of lines(d)) out[l.id] = { text: `తెలుగు ${l.id}`, status: 'reviewed', sourceHash: lineSourceHash(l), at: 1, gloss: `Means: ${l.text}` };
  // One line the review flagged (blocks publishing until the author looks at it).
  out.l3 = { text: 'తెలుగు l3', status: 'machine', sourceHash: lineSourceHash(lines(d).find((l) => l.id === 'l3')!), at: 1, issue: { severity: 'major', note: 'Wrong meaning.' } };
  d = applyOps(d, [{ op: 'translations', lang, lines: out }]);
  return d;
}

describe('undo of translation edits through the client-patch sanitizer', () => {
  it('(a) Remove edition → Undo: the restore batch is accepted and the edition comes back', () => {
    const before = translated();
    const remove: DocOp[] = [{ op: 'edition', lang: 'te', patch: null }];
    expect(isUndoable(before, remove)).toBe(true); // the client puts it on the undo stack
    const after = applyOps(before, remove);
    expect(i18nOf(after).editions.te).toBeUndefined();
    const inverse = inverseOps(before, remove);
    let error: string | undefined;
    let restored: ComicDoc | undefined;
    try {
      const clean = sanitizePatchOps(after, inverse);
      restored = applyOps(after, clean);
    } catch (err) {
      error = (err as Error).message;
    }
    process.stderr.write(`probe translation.3a ${JSON.stringify({ inverseOps: inverse.length, firstOp: inverse[0], error, restoredLines: restored ? Object.keys(i18nOf(restored).editions.te?.lines || {}).length : null })}\n`);
    expect(error).toBeUndefined();
    expect(Object.keys(i18nOf(restored!).editions.te?.lines || {})).toHaveLength(12);
  });

  it('(b) Edit a reviewed line → Undo: the line is reviewed again with its gloss (and a flagged line stays flagged)', () => {
    const before = translated();
    const l1 = lines(before).find((l) => l.id === 'l1')!;
    const l3 = lines(before).find((l) => l.id === 'l3')!;
    // The author edits l1 (reviewed, with a gloss) and l3 (flagged by the review) in the Review tab.
    const edits: DocOp[] = [
      { op: 'translation', lang: 'te', lineId: 'l1', patch: { text: 'కొత్త l1', status: 'edited', sourceHash: lineSourceHash(l1), at: 2 } },
      { op: 'translation', lang: 'te', lineId: 'l3', patch: { text: 'కొత్త l3', status: 'edited', sourceHash: lineSourceHash(l3), at: 2 } }
    ];
    const cleanEdits = sanitizePatchOps(before, edits);
    const edited = applyOps(before, cleanEdits);
    expect(i18nOf(edited).editions.te.lines.l1).toMatchObject({ text: 'కొత్త l1', status: 'edited' });
    // Undo (the inverse is computed on the client against the doc the user saw).
    const inverse = inverseOps(before, cleanEdits);
    const clean = sanitizePatchOps(edited, inverse);
    const undone = applyOps(edited, clean);
    const got1 = i18nOf(undone).editions.te.lines.l1;
    const got3 = i18nOf(undone).editions.te.lines.l3;
    process.stderr.write(`probe translation.3b ${JSON.stringify({ inverse, l1: got1, l3: got3, publishableBefore: editionReadiness(before, 'te').publishable, publishableAfterUndo: editionReadiness(undone, 'te').publishable })}\n`);
    expect(got1).toMatchObject({ text: 'తెలుగు l1', status: 'reviewed', gloss: 'Means: Where did the moon go?' });
    expect(got3).toMatchObject({ text: 'తెలుగు l3', status: 'machine', issue: { severity: 'major' } });
    expect(editionReadiness(undone, 'te').publishable).toBe(editionReadiness(before, 'te').publishable);
  });
});
