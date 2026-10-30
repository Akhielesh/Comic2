// Staleness parts (Ship 2, K2a). Synthetic fixtures only.
import { describe, expect, it } from 'vitest';
import { normalizeDoc, normalizeVersionParts, type ComicDoc } from './doc';
import { applyOps } from './ops';
import { CONSISTENCY_LIMITS } from './limits';
import { historyV5Doc } from './history/__fixtures__/books';
import { partHash, partsOf } from './parts';

const v5 = (): ComicDoc => normalizeDoc(historyV5Doc());
const HEX6 = /^[0-9a-f]{6}$/;

describe('partsOf', () => {
  it('fingerprints every panel part with six hex, deterministically and normal by construction', () => {
    const doc = v5();
    const parts = partsOf(doc, doc.pages[0]);
    expect(Object.keys(parts.panels!)).toEqual(doc.pages[0].panels.map((p) => p.id));
    for (const p of Object.values(parts.panels!)) for (const v of Object.values(p)) expect(v).toMatch(HEX6);
    expect(parts.places).toEqual({ pl_market: partHash(doc.places[0].look) });
    expect(partsOf(v5(), v5().pages[0])).toEqual(parts);
    expect(normalizeVersionParts(parts)).toEqual(parts);
  });

  it('names only the part that changed (an action edit is the action; a look edit is the cast)', () => {
    const doc = v5();
    const page = doc.pages[0];
    const before = partsOf(doc, page);
    const acted = applyOps(doc, [{ op: 'panel', pageId: page.id, id: page.panels[1].id, patch: { action: 'Maya drops the tin' } }]);
    const after = partsOf(acted, acted.pages[0]);
    expect(after.panels![page.panels[1].id]).toEqual({ ...before.panels![page.panels[1].id], a: expect.not.stringMatching(before.panels![page.panels[1].id].a) });
    expect(after.panels![page.panels[0].id]).toEqual(before.panels![page.panels[0].id]);
    const restyled = applyOps(doc, [{ op: 'character', id: 'ch_maya', patch: { look: { ...doc.cast[0].look, outfit: 'a green kurta' } } }]);
    const changed = partsOf(restyled, restyled.pages[0]).panels!;
    expect(changed[page.panels[1].id].c).not.toBe(before.panels![page.panels[1].id].c); // Maya is in panel 2
    expect(changed[page.panels[0].id].c).toBe(before.panels![page.panels[0].id].c); // nobody in panel 1
  });

  it('key order never matters (a jsonb reload); direction and continuity count only when present, never their provenance', () => {
    const doc = v5();
    const reordered = { ...doc, cast: doc.cast.map((c) => ({ ...c, look: Object.fromEntries(Object.entries(c.look).reverse()) as typeof c.look })) };
    expect(partsOf(reordered, doc.pages[0])).toEqual(partsOf(doc, doc.pages[0]));
    expect(partsOf(doc, doc.pages[0]).panels![doc.pages[0].panels[0].id].d).toBeUndefined();
    expect(partsOf(doc, doc.pages[0]).cont).toBeUndefined();
    const directed = applyOps(doc, [{ op: 'panel', pageId: 'pg_1', id: 'pg_1_p1', patch: { direction: { lens: 'wide', by: 'writer' } } }]);
    const d1 = partsOf(directed, directed.pages[0]).panels!.pg_1_p1.d;
    expect(d1).toMatch(HEX6);
    const byUser = applyOps(doc, [{ op: 'panel', pageId: 'pg_1', id: 'pg_1_p1', patch: { direction: { lens: 'wide', by: 'user' } } }]);
    expect(partsOf(byUser, byUser.pages[0]).panels!.pg_1_p1.d).toBe(d1);
    const withState = { ...doc, scenes: [{ id: 'sc_1', name: 'Market', light: 'dawn' }] };
    const page = { ...doc.pages[0], continuity: { sceneId: 'sc_1', props: { tin: 'open' }, by: 'writer' as const } };
    const p1 = partsOf(withState, page);
    expect(p1.cont).toMatch(HEX6);
    expect(p1.props).toEqual({ tin: partHash('open') });
    // The scene's light is part of the continuity the page was drawn in.
    expect(partsOf({ ...withState, scenes: [{ id: 'sc_1', name: 'Market', light: 'dusk' }] }, page).cont).not.toBe(p1.cont);
    expect(partsOf(withState, { ...page, continuity: { ...page.continuity, by: 'user' as const } }).cont).toBe(p1.cont);
  });

  it('stays within CONSISTENCY_LIMITS.partsKeys', () => {
    const doc = v5();
    const props = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`prop${i}`, 'here']));
    const parts = partsOf(doc, { ...doc.pages[0], continuity: { props } });
    const keys = Object.keys(parts.panels || {}).length + Object.keys(parts.places || {}).length + Object.keys(parts.props || {}).length;
    expect(keys).toBe(CONSISTENCY_LIMITS.partsKeys);
  });
});
