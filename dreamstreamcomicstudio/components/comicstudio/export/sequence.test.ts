import { describe, expect, it } from 'vitest';
import { fakeUrlFor } from '../board/__fixtures__/sampleDoc';
import { makeBook } from './__fixtures__/books';
import { ExportError } from './errors';
import { availableLanguages, collectExportSlots, exportLanguages, localizedFor, trimAspectOf, uniformTrimOf } from './sequence';

describe('collectExportSlots (the one book order for every export)', () => {
  it('cover → title → drawn pages → The End → back cover, named in reading order', () => {
    const { slots, skipped } = collectExportSlots(makeBook(), fakeUrlFor);
    expect(slots.map((s) => s.key)).toEqual(['cover', 'title', 'pg_1', 'pg_5', 'end', 'back_cover']);
    expect(slots.map((s) => s.fileBase)).toEqual(['00-cover', '01-title', '02-page-01', '03-page-05', '04-end', '05-back-cover']);
    expect(slots.filter((s) => s.plate).map((s) => s.plate)).toEqual(['title', 'end', 'back_cover']);
    expect(slots[0].url).toBe('https://cdn.test/u/proj/cover.png');
    expect(slots.find((s) => s.plate)?.url).toBeUndefined();
    expect(skipped).toEqual(['Page 2 (not drawn yet)', 'Page 3 (not drawn yet)', 'Page 4 (not drawn yet)', 'Page 6 (not drawn yet)']);
  });

  it('can leave the plates out', () => {
    const { slots } = collectExportSlots(makeBook(), fakeUrlFor, { plates: false });
    expect(slots.map((s) => s.fileBase)).toEqual(['00-cover', '01-page-01', '02-page-05']);
  });

  it('never fetches a withheld image and says why it is missing', () => {
    const doc = makeBook((d) => {
      d.pages[4].render.asset = { ...d.pages[4].render.asset!, safety: { assessed: 'X', at: 1 } };
      d.cover.render.asset = { ...d.cover.render.asset!, safety: { quarantined: true, at: 1 } };
    });
    const seen: string[] = [];
    const { slots, skipped } = collectExportSlots(doc, (a) => {
      seen.push(typeof a === 'string' ? a : a?.path || '');
      return fakeUrlFor(a);
    });
    expect(slots.map((s) => s.key)).not.toContain('pg_5');
    expect(slots.map((s) => s.key)).not.toContain('cover');
    expect(skipped).toContain('Page 5 (withheld by the safety check)');
    expect(skipped).toContain('Cover (withheld by the safety check)');
    expect(seen).not.toContain('u/proj/pages/p5.png');
    expect(seen).not.toContain('u/proj/cover.png');
  });

  it('reports unsigned links and keeps an undrawn cover quiet', () => {
    const doc = makeBook((d) => {
      d.cover.render = { status: 'none', history: [] };
    });
    const { slots, skipped } = collectExportSlots(doc, (a) => (typeof a === 'object' && a?.path === 'u/proj/pages/p1.png' ? undefined : fakeUrlFor(a)));
    expect(slots[0].key).toBe('title');
    expect(skipped[0]).toBe('Page 1 (image link not ready yet)');
    expect(skipped.some((s) => s.startsWith('Cover'))).toBe(false);
  });

  it('never lets a malformed page number into a file name (no path pieces in ZIP entries)', () => {
    const doc = makeBook((d) => {
      (d.pages[0] as unknown as { n: unknown }).n = '../../evil';
    });
    const { slots } = collectExportSlots(doc, fakeUrlFor);
    for (const s of slots) expect(s.fileBase).toMatch(/^[0-9]{2,}-[a-z0-9-]+$/);
  });

  it('uses the book trim and its uniform-trim switch', () => {
    const doc = makeBook();
    expect(trimAspectOf(doc)).toBeCloseTo(2 / 3, 6);
    expect(uniformTrimOf(doc)).toBe(true);
    doc.book = { ...doc.book!, uniformTrim: false };
    expect(uniformTrimOf(doc)).toBe(false);
  });
});

describe('languages', () => {
  it('lists the source and its editions, and only exports languages that exist', () => {
    const doc = makeBook();
    expect(availableLanguages(doc)).toEqual(['en', 'te']);
    expect(exportLanguages(doc)).toEqual(['en']);
    expect(exportLanguages(doc, ['te', 'en', 'hi'])).toEqual(['en', 'te']);
    expect(exportLanguages(doc, ['te'])).toEqual(['te']);
    doc.publication = { visibility: 'unlisted', status: 'live', publishedRev: 1, publishedAt: 1, languages: ['en', 'te'] };
    expect(exportLanguages(doc)).toEqual(['en', 'te']);
  });

  it('localizes for an edition and refuses one that does not exist', () => {
    const doc = makeBook();
    const te = localizedFor(doc, 'te');
    expect(te.format.language).toBe('te');
    expect(te.pages[0].panels[0].lines[0].text).toBe('పాత దిల్లీ. ఎండకు ముందు.');
    expect(te.cover.title).toBe('కుంకుమపువ్వు దొంగ');
    expect(localizedFor(doc, 'en')).toBe(doc);
    expect(localizedFor(doc)).toBe(doc);
    expect(() => localizedFor(doc, 'hi')).toThrow(ExportError);
    expect(() => localizedFor(doc, 'hi')).toThrow('There is no Hindi edition of this comic yet.');
  });
});
