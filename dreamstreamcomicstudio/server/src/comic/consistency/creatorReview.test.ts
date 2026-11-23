import { describe, expect, it } from 'vitest';
import { being, pageOf } from '../../../../shared/comic/__fixtures__/consistencyBooks.js';
import { createEmptyDoc, normalizeDoc, type ComicDoc } from '../../../../shared/comic/doc.js';
import { inverseOps } from '../../../../shared/comic/undo.js';
import { correctionOp, pagesUsing } from '../../../../shared/comic/pageCorrection.js';
import { fakeDocStore, newSession, testContext } from '../orchestrator.fakes.js';
import { runAction } from '../jobs.js';
import { compilePage } from '../prompts.js';

const artist = { kind: 'cast', id: 'maya', field: 'outfit' } as const;
function comic(id: string): ComicDoc {
  const doc = createEmptyDoc(id, 'The Crossing');
  doc.cast = [being('maya', 'Maya', 'lead')];
  doc.pages = Array.from({ length: 16 }, (_, i) => pageOf(i + 1, [{ cast: i === 12 ? [] : ['maya'] }]));
  doc.pages[10].continuity = { cast: { maya: { holding: ['journal'] } }, props: { Compass: 'brass' }, by: 'writer' };
  doc.pages[14].continuity = { cast: { maya: { outfit: 'wool cloak' } }, by: 'writer' };
  return doc;
}

describe('creator correction in a long comic', () => {
  it('persists a page correction through the real patch action and feeds only later eligible render prompts until superseded', async () => {
    const doc = comic('creator-first');
    const store = fakeDocStore();
    const session = newSession(doc, store);
    const ctx = testContext(session);
    const other = comic('creator-other');
    newSession(other, store, 'another-owner');
    const op = correctionOp(doc.pages[10], artist, 'left sleeve stitched with indigo thread').op!;
    const undo = inverseOps(doc, [op]);
    await runAction(ctx, { type: 'patch', ops: [op] }, { confirmed: false });
    await session.flush();
    const stored = normalizeDoc(store.docs.get(doc.id)!.doc);
    expect(stored.pages[10].continuity).toMatchObject({ by:'user', cast:{ maya: { outfit:'left sleeve stitched with indigo thread', holding:['journal'] } }, props:{ Compass:'brass' } });
    expect(pagesUsing(stored, stored.pages[10], artist)).toEqual([11,12,14]);
    expect(compilePage(stored, stored.pages[11]).prompt).toContain('left sleeve stitched with indigo thread');
    expect(compilePage(stored, stored.pages[9]).prompt).not.toContain('indigo thread');
    expect(compilePage(stored, stored.pages[12]).prompt).not.toContain('indigo thread');
    expect(compilePage(stored, stored.pages[15]).prompt).toContain('wool cloak');
    expect(compilePage(stored, stored.pages[15]).prompt).not.toContain('indigo thread');
    const otherStored = store.docs.get(other.id)!;
    expect(otherStored.userId).toBe('another-owner');
    expect(otherStored.doc).toEqual(other);
    expect(compilePage(otherStored.doc, otherStored.doc.pages[11]).prompt).not.toContain('indigo thread');
    await expect(runAction(ctx, { type:'patch', ops:[op] }, { confirmed:false })).rejects.toMatchObject({ code:'CONFLICT' });
    await runAction(ctx, { type:'patch', ops:undo }, { confirmed:false });
    expect(session.doc.pages[10].continuity).toEqual(doc.pages[10].continuity);
    expect(compilePage(session.doc, session.doc.pages[11]).prompt).not.toContain('indigo thread');
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(ctx.llmFake.calls).toHaveLength(0);
    expect(ctx.billingFake.reserves).toHaveLength(0);
    expect(session.doc.spend.entries).toEqual([]);
    await session.flush();
  });

  it('retains sibling facts, lists multiple distinctive marks and reverses a prop edit without drawing', () => {
    const doc = comic('creator-second');
    const page = doc.pages[10];
    const prop = { kind:'prop', name:'Compass' } as const;
    expect(correctionOp(page, prop, 'cracked face').op?.patch).toMatchObject({ props:{ Compass:'cracked face' } });
    expect(correctionOp(page, prop, null).op?.patch).toMatchObject({ props:null });
    expect(correctionOp(page, { ...artist, field:'marks' }, 'white patch\nshort tail').op?.patch).toMatchObject({cast:{maya:{holding:['journal'], marks:['white patch','short tail']}}});
    expect(correctionOp(page, prop, 'x'.repeat(121)).error).toBeTruthy();
  });
});
