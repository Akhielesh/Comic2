// "Undo the last AI change" (versions plan §6.4; H0): untouched AI keys revert, keys the user changed since are
// conflicts until decided; the plan applied through restoreOps reverts exactly those keys.
import { describe, expect, it } from 'vitest';
import { normalizeDoc, type ComicDoc } from '../doc';
import { applyOps } from '../ops';
import { historyV5Doc } from './__fixtures__/books';
import { planUndoLastAi, pageIdsOfKeys, undoAiScope } from './lastAi';
import { historyRestoreOp, restoreOps } from './restore';
import { excludedOf, joinSections, sectionSignatures, splitSections } from './sections';

describe('planUndoLastAi (three-way)', () => {
  it('reverts keys untouched since the AI and reports the ones the user changed as conflicts', () => {
    const P = { 'page:pg_1': 'a', 'page:pg_2': 'b', 'art:pg_3': 'c', meta: 'm' };
    const R = { 'page:pg_1': 'A', 'page:pg_2': 'B', 'art:pg_3': 'c', meta: 'm', 'page:pg_9': 'new' };
    const live = { 'page:pg_1': 'A', 'page:pg_2': 'MINE', 'art:pg_3': 'c', meta: 'm', 'page:pg_9': 'new' };
    const plan = planUndoLastAi(P, R, live);
    expect(plan.changed).toEqual(['page:pg_1', 'page:pg_2', 'page:pg_9']);
    expect(plan.revert).toEqual(['page:pg_1', 'page:pg_9']);
    expect(plan.conflicts).toEqual(['page:pg_2']);
    expect(pageIdsOfKeys(plan.conflicts)).toEqual(['pg_2']);
    // Decisions resolve the conflict either way.
    expect(planUndoLastAi(P, R, live, { 'page:pg_2': 'earlier' })).toMatchObject({ revert: ['page:pg_1', 'page:pg_2', 'page:pg_9'], conflicts: [] });
    expect(planUndoLastAi(P, R, live, { 'page:pg_2': 'mine' })).toMatchObject({ kept: ['page:pg_2'], conflicts: [] });
    expect(undoAiScope(plan)).toEqual({ kind: 'keys', keys: ['page:pg_1', 'page:pg_9'] });
    expect(undoAiScope(planUndoLastAi(P, P, P))).toBeNull();
  });

  it('end to end: the AI revised pages 2 and 3 and added page 7; the user then edited page 3 — undo reverts page 2 and removes page 7 only', () => {
    const P = normalizeDoc(historyV5Doc());
    const R = applyOps(
      P,
      [
        { op: 'line', pageId: 'pg_2', panelId: 'pg_2_p2', id: 'pg_2_l2', patch: { text: 'AI line 2' } },
        { op: 'line', pageId: 'pg_3', panelId: 'pg_3_p2', id: 'pg_3_l2', patch: { text: 'AI line 3' } },
        { op: 'page_insert', id: 'pg_ai', after: 6, patch: { summary: 'AI page' } }
      ],
      10
    );
    const live = applyOps(R, [{ op: 'line', pageId: 'pg_3', panelId: 'pg_3_p2', id: 'pg_3_l2', patch: { text: 'My line 3' } }], 11);
    const plan = planUndoLastAi(sectionSignatures(P), sectionSignatures(R), sectionSignatures(live));
    expect(plan.conflicts).toEqual(['page:pg_3']);
    expect(plan.revert).toEqual(expect.arrayContaining(['page:pg_2', 'page:pg_ai', 'art:pg_ai']));
    const version: ComicDoc = joinSections(splitSections(P), excludedOf(P));
    const after = applyOps(live, [historyRestoreOp(restoreOps(live, version, undoAiScope(plan)!), { versionId: 'P', at: 12 })], 12);
    expect(after.pages.find((p) => p.id === 'pg_2')!.panels[1].lines[0].text).toBe(P.pages[1].panels[1].lines[0].text);
    expect(after.pages.find((p) => p.id === 'pg_3')!.panels[1].lines[0].text).toBe('My line 3');
    expect(after.pages.some((p) => p.id === 'pg_ai')).toBe(false);
    expect(after.trash!.some((t) => t.page.id === 'pg_ai')).toBe(true);
  });
});
