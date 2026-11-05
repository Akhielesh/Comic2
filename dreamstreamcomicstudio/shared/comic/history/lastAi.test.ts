// "Undo the last AI change" (versions plan §6.4; H0): untouched AI keys revert, keys the user changed since are
// conflicts until decided; the plan applied through restoreOps reverts exactly those keys.
import { describe, expect, it } from 'vitest';
import { normalizeDoc, type ComicDoc } from '../doc';
import { applyOps } from '../ops';
import { historyV5Doc } from './__fixtures__/books';
import { planUndoLastAi, pageIdsOfKeys, undoAiScope } from './lastAi';
import { historyRestoreOp, restoreOps } from './restore';
import { semanticSectionContent } from './diff';
import { excludedOf, joinSections, sectionChunks, sectionSignatures, splitSections } from './sections';

/** key → body of every section of an in-memory doc (H3 reads the same bodies from chunks). */
const bodies = (doc: ComicDoc): Map<string, unknown> => new Map(sectionChunks(splitSections(doc)).map((c) => [c.key, c.body]));
/** The `sameContent` H3 builds: the live and R bodies compared after the semantic filter. */
const sameContentOf = (R: ComicDoc, live: ComicDoc) => {
  const r = bodies(R);
  const l = bodies(live);
  return (key: string) => r.has(key) && l.has(key) && semanticSectionContent(r.get(key)) === semanticSectionContent(l.get(key));
};

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

  it('an AI redraw followed only by the studio\'s own variant and safety commits reverts with no conflict', () => {
    const P = normalizeDoc(historyV5Doc());
    const AI = 'u/user-b/p/proj-v5/img/p3-ai.webp';
    const R = applyOps(P, [{ op: 'render', target: { kind: 'page', id: 'pg_3' }, patch: { status: 'ready', asset: { path: AI, source: 'generated', at: 20 }, origin: 'render' } }], 20);
    // No user action: the variant backfill on session load and an async safety verdict (asset_meta only).
    const live = applyOps(R, [{ op: 'asset_meta', path: AI, patch: { variants: [{ path: 'u/user-b/p/proj-v5/img/p3-ai_w480.webp', w: 480, h: 720 }], safety: { assessed: 'G', at: 21 } } }], 21);
    const [hp, hr, hl] = [sectionSignatures(P), sectionSignatures(R), sectionSignatures(live)];
    expect(hl['art:pg_3']).not.toBe(hr['art:pg_3']); // the raw hash did change
    // Raw hashes alone would claim "You've changed page 3 since".
    expect(planUndoLastAi(hp, hr, hl).conflicts).toEqual(['art:pg_3']);
    // With the semantic comparison it is untouched since the AI: revert, no conflict.
    const plan = planUndoLastAi(hp, hr, hl, {}, sameContentOf(R, live));
    expect(plan).toMatchObject({ changed: ['art:pg_3'], revert: ['art:pg_3'], conflicts: [] });
    // A real change since still asks: the user picked an older drawing back.
    const mine = applyOps(live, [{ op: 'render_use', target: { kind: 'page', id: 'pg_3' }, path: P.pages[2].render.asset!.path, at: 22 }], 22);
    expect(planUndoLastAi(hp, hr, sectionSignatures(mine), {}, sameContentOf(R, mine)).conflicts).toEqual(['art:pg_3']);
    // A key the user removed since is a conflict whatever sameContent says.
    expect(planUndoLastAi({ 'page:pg_3': 'a' }, { 'page:pg_3': 'b' }, {}, {}, () => true).conflicts).toEqual(['page:pg_3']);
  });
});
