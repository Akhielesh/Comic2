import { describe, expect, it } from 'vitest';
import { harbourComic, lakeStory, readyRender } from './__fixtures__/consistencyBooks';
import {
  CONTINUITY_CARRY,
  continuityAnchorFor,
  deriveScenes,
  lintContinuity,
  resolveContinuity,
  runChains,
  sceneIndex,
  type ContinuityIssueKind
} from './continuity';
import { normalizeDoc, type ComicDoc, type PageContinuity } from './doc';
import { nearestReadyBefore } from './sendable';

const withLedger = (ledger: Record<number, PageContinuity>, mutate?: (doc: ComicDoc) => void): ComicDoc =>
  harbourComic((doc) => {
    doc.pages = doc.pages.map((p) => (ledger[p.n] ? { ...p, continuity: ledger[p.n] } : p));
    mutate?.(doc);
  });

const kinds = (doc: ComicDoc): ContinuityIssueKind[] => lintContinuity(doc).map((i) => i.kind);

describe('resolveContinuity — carry rules and since', () => {
  it('carries outfit and marks book-wide, holding for the scene, where for one page, each with the page it was set on', () => {
    expect(CONTINUITY_CARRY).toEqual({ outfit: 'book', marks: 'book', holding: 'scene', where: 'page' });
    const doc = withLedger({
      1: { cast: { c_meera: { outfit: 'blue sari', holding: ['the lantern'], where: 'by the gate', marks: ['scar on left cheek'] } } },
      2: { cast: { c_ravi: { outfit: 'wet kurta' } } }
    });
    const p1 = resolveContinuity(doc, 'pg_1')!;
    expect(p1.cast.c_meera).toEqual({
      outfit: 'blue sari',
      holding: ['the lantern'],
      where: 'by the gate',
      marks: ['scar on left cheek'],
      since: { outfit: 1, holding: 1, where: 1, marks: 1 }
    });
    // Page 2 (same scene, the gate): holding carries, where does not.
    const p2 = resolveContinuity(doc, 'pg_2')!;
    expect(p2.cast.c_meera).toEqual({ outfit: 'blue sari', holding: ['the lantern'], marks: ['scar on left cheek'], since: { outfit: 1, holding: 1, marks: 1 } });
    expect(p2.cast.c_ravi).toEqual({ outfit: 'wet kurta', since: { outfit: 2 } });
    // Page 3 starts the market scene (derived from places): holding is dropped; outfit and marks carry from page 1.
    const p3 = resolveContinuity(doc, 'pg_3')!;
    expect(p3.cast.c_meera).toEqual({ outfit: 'blue sari', marks: ['scar on left cheek'], since: { outfit: 1, marks: 1 } });
    expect(p3.sceneFrom).toBe('derived');
    expect(p3.sceneSince).toBe(3);
    expect(p3.content).toBe(true);
  });

  it('a ledger scene carries until another page names one; null clears a field or a whole character; props carry and go', () => {
    const doc = withLedger(
      {
        1: { sceneId: 'sc_night', cast: { c_meera: { holding: ['lantern'], outfit: 'raincoat' } }, props: { lantern: 'lit, swinging' } },
        3: { cast: { c_meera: { outfit: null } }, notes: ['It starts to rain.'] },
        4: { sceneId: 'sc_dawn', cast: { c_ravi: { outfit: 'torn shirt', marks: ['bandaged hand'] } } },
        5: { cast: { c_ravi: null }, props: { lantern: null } }
      },
      (d) => {
        d.scenes = [
          { id: 'sc_night', name: 'Night run', time: 'night' },
          { id: 'sc_dawn', name: 'Dawn', time: 'dawn' }
        ];
      }
    );
    // Pages 1–3 are one ledger scene even though page 3 is at the market: holding carries to page 3.
    const p3 = resolveContinuity(doc, 'pg_3')!;
    expect(p3.sceneId).toBe('sc_night');
    expect(p3.scene?.name).toBe('Night run');
    expect(p3.sceneSince).toBe(1);
    expect(p3.sceneFrom).toBe('ledger');
    expect(p3.cast.c_meera).toEqual({ holding: ['lantern'], since: { holding: 1 } });
    expect(p3.notes).toEqual(['It starts to rain.']);
    expect(p3.props).toEqual({ lantern: { state: 'lit, swinging', since: 1 } });
    // Page 4: a new scene drops what Meera was holding.
    const p4 = resolveContinuity(doc, 'pg_4')!;
    expect(p4.sceneId).toBe('sc_dawn');
    expect(p4.cast.c_meera).toBeUndefined();
    expect(p4.cast.c_ravi.since).toEqual({ outfit: 4, marks: 4 });
    expect(p4.notes).toEqual([]);
    // Page 5: null clears every change for Ravi; the lantern is gone from page 5.
    const p5 = resolveContinuity(doc, 'pg_5')!;
    expect(p5.cast).toEqual({});
    expect(p5.props).toEqual({});
    expect(p5.gone).toEqual({ lantern: 5 });
    expect(p5.sceneSince).toBe(4);
    expect(p5.content).toBe(true);
  });

  it('a book without ledger data has no content on any page (no CONTINUITY block, I8) and unknown pages resolve to undefined', () => {
    for (const doc of [harbourComic(), lakeStory(), normalizeDoc(harbourComic())]) {
      for (const p of doc.pages) {
        const s = resolveContinuity(doc, p)!;
        expect(s.content).toBe(false);
        expect(s.cast).toEqual({});
      }
    }
    expect(resolveContinuity(harbourComic(), 'pg_nope')).toBeUndefined();
  });

  it('ignores changes for someone not in the cast (the lint names them)', () => {
    const doc = withLedger({ 1: { cast: { c_ghost: { outfit: 'sheet' } } } });
    expect(resolveContinuity(doc, 'pg_1')!.cast).toEqual({});
    expect(kinds(doc)).toEqual(['unknown_cast']);
  });
});

describe('lintContinuity', () => {
  it('a book without ledger data lints clean', () => {
    expect(lintContinuity(harbourComic())).toEqual([]);
    expect(lintContinuity(lakeStory())).toEqual([]);
  });

  it('flags a scene the book does not have', () => {
    const doc = withLedger({ 2: { sceneId: 'sc_missing' } });
    const [issue] = lintContinuity(doc);
    expect(issue).toMatchObject({ kind: 'unknown_scene', severity: 'major', pageId: 'pg_2', n: 2 });
    expect(issue.text).toBe("Page 2 is set in a scene the book doesn't have.");
  });

  it('flags where someone stands on a page they are not drawn on', () => {
    const doc = withLedger({ 1: { cast: { c_ravi: { where: 'on the wall' } } } });
    expect(lintContinuity(doc)).toEqual([
      { pageId: 'pg_1', n: 1, kind: 'not_on_page', severity: 'minor', castId: 'c_ravi', text: "Page 1 says where RAVI is, but RAVI isn't drawn on page 1." }
    ]);
  });

  it('flags one item in two hands, where it arises', () => {
    const doc = withLedger({ 1: { cast: { c_meera: { holding: ['the lantern'] } } }, 2: { cast: { c_ravi: { holding: ['Lantern'] } } } });
    const issues = lintContinuity(doc);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'held_twice', severity: 'major', n: 2 });
    expect(issues[0].text).toBe('On page 2 MEERA and RAVI both hold “the lantern”.');
  });

  it('flags a gone prop that someone still holds', () => {
    const doc = withLedger({ 1: { cast: { c_meera: { holding: ['the old lantern'] } }, props: { lantern: 'lit' } }, 2: { props: { lantern: null } } });
    const issues = lintContinuity(doc);
    expect(issues.map((i) => i.kind)).toEqual(['prop_gone_held']);
    expect(issues[0].text).toBe('On page 2 MEERA still holds “the old lantern”, but “lantern” is gone from page 2.');
  });

  it('flags a ledger scene set where none of the page panels are', () => {
    const doc = withLedger({ 3: { sceneId: 'sc_gate' } }, (d) => {
      d.scenes = [{ id: 'sc_gate', name: 'At the gate', placeId: 'pl_gate' }];
    });
    const issues = lintContinuity(doc);
    // Pages 3–6 carry the gate scene but are drawn at the market and the temple.
    expect(issues.map((i) => [i.kind, i.n])).toEqual([
      ['scene_place', 3],
      ['scene_place', 4],
      ['scene_place', 5],
      ['scene_place', 6]
    ]);
    expect(issues[0].text).toBe("Page 3's scene is at CHITRAKULAM GATE, but none of its panels are there.");
  });

  it('flags clears with nothing to clear and changes to what is already true', () => {
    const doc = withLedger({
      1: { cast: { c_meera: { outfit: 'blue sari' }, c_ravi: null }, props: { kite: null } },
      2: { cast: { c_meera: { outfit: 'blue sari', marks: null } } }
    });
    expect(lintContinuity(doc).map((i) => [i.kind, i.n, i.text])).toEqual([
      ['clears_nothing', 1, 'Page 1 clears every change for RAVI, but none was set before.'],
      ['clears_nothing', 1, 'Page 1 says “kite” is gone, but it was never there.'],
      ['clears_nothing', 2, "Page 2 clears MEERA's marks, but nothing was set before."],
      ['repeats', 2, "Page 2 sets MEERA's outfit to what it already is."]
    ]);
  });
});

describe('deriveScenes and sceneIndex', () => {
  it('derives one scene per run of the same place, named from the place, with ids no scene uses', () => {
    const doc = harbourComic((d) => {
      d.scenes = [{ id: 'sc_auto_1', name: 'Taken' }];
    });
    const { scenes, byPage } = deriveScenes(doc);
    expect(scenes.map((s) => [s.id, s.name, s.placeId])).toEqual([
      ['sc_auto_2', 'Chitrakulam Gate', 'pl_gate'],
      ['sc_auto_3', 'Night Market', 'pl_market'],
      ['sc_auto_4', 'Sea Temple', 'pl_temple']
    ]);
    expect(byPage).toEqual({ pg_1: 'sc_auto_2', pg_2: 'sc_auto_2', pg_3: 'sc_auto_3', pg_4: 'sc_auto_3', pg_5: 'sc_auto_4', pg_6: 'sc_auto_4' });
  });

  it('a placeless opening page joins the first place; a placeless page later stays in its scene', () => {
    const doc = harbourComic((d) => {
      d.pages[0] = { ...d.pages[0], panels: d.pages[0].panels.map(({ placeId: _p, ...panel }) => panel) };
      d.pages[3] = { ...d.pages[3], panels: d.pages[3].panels.map(({ placeId: _p, ...panel }) => panel) };
    });
    const { scenes, byPage } = deriveScenes(doc);
    expect(scenes.map((s) => s.placeId)).toEqual(['pl_gate', 'pl_market', 'pl_temple']);
    expect(byPage.pg_1).toBe(byPage.pg_2);
    expect(byPage.pg_4).toBe(byPage.pg_3);
  });

  it('the ledger wins over derivation as soon as one page names a scene', () => {
    const doc = withLedger({ 2: { sceneId: 'sc_a' } });
    const idx = sceneIndex(doc, { derive: true });
    expect(idx.from).toBe('ledger');
    expect(idx.byPage).toEqual({ pg_1: undefined, pg_2: 'sc_a', pg_3: 'sc_a', pg_4: 'sc_a', pg_5: 'sc_a', pg_6: 'sc_a' });
    expect(sceneIndex(harbourComic()).from).toBe('none');
  });
});

describe('continuityAnchorFor', () => {
  const drawnBook = (ledger: Record<number, PageContinuity> = {}, undrawn: number[] = []) =>
    withLedger(ledger, (d) => {
      d.scenes = [
        { id: 'sc_a', name: 'A' },
        { id: 'sc_b', name: 'B' }
      ];
      d.pages = d.pages.map((p) => (undrawn.includes(p.n) ? p : { ...p, render: readyRender(`u/o/h/p${p.n}.webp`) }));
    });

  it('without ledger scenes it is exactly nearestReadyBefore (I8)', () => {
    for (const doc of [drawnBook({}, [2]), drawnBook({}, [1, 2, 3]), harbourComic(), lakeStory()]) {
      for (const page of doc.pages) {
        const a = continuityAnchorFor(doc, page);
        expect(a.page?.id).toBe(nearestReadyBefore(doc, page)?.id);
        expect(a.why).toBe(a.page ? 'previous' : 'none');
      }
    }
  });

  it('with ledger scenes: the adjacent drawn page of the same scene; nothing at a scene start; never a page further back', () => {
    const doc = drawnBook({ 1: { sceneId: 'sc_a' }, 4: { sceneId: 'sc_b' } }, [2]);
    const at = (n: number) => continuityAnchorFor(doc, doc.pages[n - 1]);
    expect(at(1)).toEqual({ why: 'none' });
    expect(at(2)).toMatchObject({ why: 'same_scene', page: { id: 'pg_1' } });
    // Page 3's neighbour (page 2) is in its scene but not drawn: wait for it — page 1 is never attached instead.
    expect(at(3)).toEqual({ why: 'waiting' });
    expect(at(4)).toEqual({ why: 'scene_start' });
    expect(at(5)).toMatchObject({ why: 'same_scene', page: { id: 'pg_4' } });
  });

  it('pages a run draws first count as drawn (pending)', () => {
    const doc = drawnBook({ 1: { sceneId: 'sc_a' } }, [2]);
    const a = continuityAnchorFor(doc, doc.pages[2], { assumeDrawn: new Set(['pg_2']) });
    expect(a).toMatchObject({ why: 'same_scene', pending: true, page: { id: 'pg_2' } });
  });
});

describe('runChains', () => {
  it('chains the pages of each scene; the first page goes alone first; scenes then run side by side', () => {
    const doc = harbourComic();
    const all = runChains(doc, doc.pages.map((p) => p.id));
    expect(all.first).toBe('pg_1');
    expect(all.chains.map((c) => c.pageIds)).toEqual([
      ['pg_1', 'pg_2'],
      ['pg_3', 'pg_4'],
      ['pg_5', 'pg_6']
    ]);
    expect(all.after).toEqual({ pg_2: 'pg_1', pg_4: 'pg_3', pg_6: 'pg_5', pg_3: 'pg_1', pg_5: 'pg_1' });
  });

  it('a page waits only on its adjacent page in the run, never on one further back', () => {
    const doc = harbourComic();
    // Page 4 is not redrawn: page 5 and 6 (temple) chain; page 3 runs alone; no book-first page in the run.
    const some = runChains(doc, ['pg_6', 'pg_3', 'pg_5']);
    expect(some.first).toBeUndefined();
    expect(some.chains.map((c) => c.pageIds)).toEqual([['pg_3'], ['pg_5', 'pg_6']]);
    expect(some.after).toEqual({ pg_6: 'pg_5' });
    // Ledger scenes override places: one scene for the whole book chains every page.
    const one = runChains(withLedger({ 1: { sceneId: 'sc_x' } }), ['pg_2', 'pg_3', 'pg_4']);
    expect(one.chains).toEqual([{ sceneId: 'sc_x', pageIds: ['pg_2', 'pg_3', 'pg_4'] }]);
  });

  it('storyOrder off = today: every page on its own', () => {
    const doc = harbourComic();
    expect(runChains(doc, ['pg_1', 'pg_2'], { storyOrder: false })).toEqual({ chains: [{ pageIds: ['pg_1'] }, { pageIds: ['pg_2'] }], after: {} });
  });
});
