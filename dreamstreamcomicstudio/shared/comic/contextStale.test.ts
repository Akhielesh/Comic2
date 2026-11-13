import { describe, expect, it } from 'vitest';
import { normalizeDoc, normalizeVersionParts, pageSpecHash, isPageStale, type ComicDoc } from './doc';
import { historyV5Doc } from './history/__fixtures__/books';
import { partsOf } from './parts';
import { partsStale } from './anchors';
import { pageTargets } from './plan';

const drawnBook = (): ComicDoc => {
  const doc = normalizeDoc(historyV5Doc());
  doc.pages = doc.pages.slice(0, 3);
  doc.scenes = [{ id: 'scene_a', name: 'Market' }, { id: 'scene_b', name: 'Home' }];
  for (const page of doc.pages) {
    for (const panel of page.panels) { panel.placeId = doc.places[0].id; panel.castIds = [doc.cast[0].id]; }
    delete page.continuity;
  }
  doc.pages[0].continuity = { sceneId: 'scene_a', cast: { [doc.cast[0].id]: { outfit: 'red coat', holding: ['tin'] } } };
  doc.pages[2].continuity = { sceneId: 'scene_b', cast: { [doc.cast[0].id]: { outfit: 'blue coat' } } };
  for (const page of doc.pages) page.render = { ...page.render, status: 'ready', specHash: pageSpecHash(doc, page), parts: partsOf(doc, page) };
  return doc;
};

describe('rendered page prompt context', () => {
  it('tracks a changed previous beat in stale status and the redraw quote, without crossing scenes', () => {
    const doc = drawnBook();
    expect(pageTargets(doc)).toEqual([]);
    doc.pages[0].panels.at(-1)!.action = 'The courier drops the tin.';
    expect(isPageStale(doc, doc.pages[1])).toBe(true);
    expect(partsStale(doc, doc.pages[1])).toBe(true);
    expect(pageTargets(doc).map((p) => p.id)).toEqual([doc.pages[0].id, doc.pages[1].id]);
    expect(isPageStale(doc, doc.pages[2])).toBe(false);
  });

  it('tracks carried content but ignores overridden outfits, expired holdings and provenance', () => {
    const doc = drawnBook();
    const id = doc.cast[0].id;
    doc.pages[0].continuity!.cast![id] = { outfit: 'green coat', holding: ['umbrella'] };
    expect(isPageStale(doc, doc.pages[1])).toBe(true);
    expect(partsStale(doc, doc.pages[1])).toBe(true);
    expect(isPageStale(doc, doc.pages[2])).toBe(false);
    doc.pages[0].continuity!.cast![id] = { outfit: 'red coat', holding: ['tin'] };
    doc.pages[0].continuity!.by = 'user';
    expect(isPageStale(doc, doc.pages[1])).toBe(false);
  });

  it('preserves context on normalization and leaves legacy versions without it current', () => {
    const doc = drawnBook();
    const page = doc.pages[1];
    expect(normalizeVersionParts(page.render.parts)).toEqual(page.render.parts);
    delete page.render.parts!.context;
    doc.pages[0].panels.at(-1)!.action = 'A changed ending.';
    doc.pages[0].continuity!.cast![doc.cast[0].id] = { outfit: 'green coat' };
    expect(isPageStale(doc, page)).toBe(false);
    expect(partsStale(doc, page)).toBe(false);
    expect(pageTargets(doc).map((p) => p.id)).not.toContain(page.id);
  });
});
