import { describe, expect, it } from 'vitest';
import { emptyRender, pageSpecHash, type ComicDoc } from '../../../shared/comic/doc.js';
import { InflightJobs, findJobHashAsset, findSpecHashVersion, isReadyAndCurrent, jobHashOf, reusedLabel } from './reuse.js';
import { plannedDoc } from './orchestrator.fakes.js';

const page1 = { kind: 'page' as const, id: 'pg_1' };
const withPage1 = (doc: ComicDoc, render: ComicDoc['pages'][number]['render']) => {
  doc.pages[0] = { ...doc.pages[0], render };
  return doc;
};

describe('R1 isReadyAndCurrent', () => {
  it('is true only for a ready image whose spec still matches', () => {
    const doc = plannedDoc();
    expect(isReadyAndCurrent(doc, page1)).toBe(false);
    withPage1(doc, { ...emptyRender(), status: 'ready', asset: { path: 'p.webp', source: 'generated', at: 1 }, specHash: pageSpecHash(doc, doc.pages[0]) });
    expect(isReadyAndCurrent(doc, page1)).toBe(true);
    doc.pages[0].render.specHash = 'old';
    expect(isReadyAndCurrent(doc, page1)).toBe(false);
  });
});

describe('R2 findSpecHashVersion', () => {
  it('finds a history version made from the current spec (newest first), never a blocked one', () => {
    const doc = plannedDoc();
    const spec = pageSpecHash(doc, doc.pages[0]);
    withPage1(doc, {
      ...emptyRender(),
      status: 'ready',
      asset: { path: 'now.webp', source: 'generated', at: 3 },
      specHash: 'other',
      history: [
        { path: 'blocked.webp', source: 'generated', at: 2, specHash: spec, safety: { assessed: 'X', at: 2 } },
        { path: 'match.webp', source: 'generated', at: 1, specHash: spec },
        { path: 'older.webp', source: 'generated', at: 0, specHash: spec }
      ]
    });
    expect(findSpecHashVersion(doc, page1)).toMatchObject({ path: 'match.webp', from: 'history' });
  });

  it('falls back to this target\'s archive entries, and is null when the current image already matches', () => {
    const doc = plannedDoc();
    const spec = pageSpecHash(doc, doc.pages[0]);
    withPage1(doc, { ...emptyRender(), status: 'failed' });
    doc.archive = [
      { path: 'other-target.webp', source: 'generated', at: 1, targetKey: 'page:pg_2', label: 'Page 2', archivedAt: 1, specHash: spec },
      { path: 'archived.webp', source: 'generated', at: 1, targetKey: 'page:pg_1', label: 'Page 1', archivedAt: 1, specHash: spec }
    ];
    expect(findSpecHashVersion(doc, page1)).toMatchObject({ path: 'archived.webp', from: 'archive' });
    withPage1(doc, { ...emptyRender(), status: 'ready', asset: { path: 'cur.webp', source: 'generated', at: 1 }, specHash: spec });
    expect(findSpecHashVersion(doc, page1)).toBeNull();
  });

  it('never brings back a version that came back in the wrong shape (4:5 asked, 1:1 drawn)', () => {
    const doc = plannedDoc();
    const spec = pageSpecHash(doc, doc.pages[0]);
    withPage1(doc, {
      ...emptyRender(),
      status: 'failed',
      history: [
        { path: 'square.webp', source: 'generated', at: 2, specHash: spec, aspect: '4:5', w: 2048, h: 2048 },
        { path: 'tall.webp', source: 'generated', at: 1, specHash: spec, aspect: '4:5', w: 1638, h: 2048 }
      ]
    });
    expect(findSpecHashVersion(doc, page1)).toMatchObject({ path: 'tall.webp' });
    doc.pages[0].render.history = doc.pages[0].render.history.slice(0, 1);
    expect(findSpecHashVersion(doc, page1)).toBeNull();
    doc.archive = [{ path: 'arch-square.webp', source: 'generated', at: 1, targetKey: 'page:pg_1', label: 'Page 1', archivedAt: 1, specHash: spec, aspect: '4:5', w: 1024, h: 1024 }];
    expect(findSpecHashVersion(doc, page1)).toBeNull();
  });

  it('style options have no spec hash: never reused by spec', () => {
    const doc = plannedDoc();
    doc.style.options = [{ id: 'so_1', name: 'A', spec: 'a', render: { ...emptyRender(), history: [{ path: 'x.webp', source: 'generated', at: 1, specHash: 'h' }] } }];
    expect(findSpecHashVersion(doc, { kind: 'style_option', id: 'so_1' })).toBeNull();
  });
});

describe('R3 jobHashOf / findJobHashAsset', () => {
  const job = { specId: 'nano-banana-2.1', resolution: '2K', aspect: '4:5', prompt: 'Draw page 1', referencePaths: ['b.webp', 'a.webp'] };

  it('is a stable 96-bit fingerprint, order-insensitive for references, sensitive to everything else', () => {
    const h = jobHashOf(job);
    expect(h).toMatch(/^[0-9a-f]{24}$/);
    expect(jobHashOf({ ...job, referencePaths: ['a.webp', 'b.webp'] })).toBe(h);
    for (const change of [{ prompt: 'Draw page 2' }, { aspect: '1:1' }, { resolution: '1K' }, { specId: 'other' }, { referencePaths: ['a.webp'] }]) {
      expect(jobHashOf({ ...job, ...change })).not.toBe(h);
    }
  });

  it('finds a current or history asset with the same job hash on any target, carrying its QC; never the target\'s own image or a blocked one', () => {
    const doc = plannedDoc();
    const qc = { score: 0.8, issues: [], checkedAt: 1 };
    doc.pages[1] = { ...doc.pages[1], render: { ...emptyRender(), status: 'ready', asset: { path: 'twin.webp', source: 'generated', at: 1, w: 10, h: 12 }, jobHash: 'J', qc, model: 'm' } };
    doc.pages[2] = { ...doc.pages[2], render: { ...emptyRender(), status: 'ready', asset: { path: 'bad.webp', source: 'generated', at: 1, safety: { quarantined: true, at: 1 } }, jobHash: 'K' } };
    expect(findJobHashAsset(doc, 'J', page1)).toMatchObject({ asset: { path: 'twin.webp', w: 10, h: 12 }, meta: { jobHash: 'J', qc }, model: 'm', from: { kind: 'page', id: 'pg_2' } });
    expect(findJobHashAsset(doc, 'J', { kind: 'page', id: 'pg_2' })).toBeNull();
    expect(findJobHashAsset(doc, 'K', page1)).toBeNull();
    doc.pages[0] = { ...doc.pages[0], render: { ...emptyRender(), history: [{ path: 'hist.webp', source: 'generated', at: 1, jobHash: 'H' }] } };
    expect(findJobHashAsset(doc, 'H', page1)).toMatchObject({ asset: { path: 'hist.webp' } });
    expect(findJobHashAsset(doc, '', page1)).toBeNull();
  });

  it('reaches trashed pages too (restoring deleted art is free)', () => {
    const doc = plannedDoc();
    doc.trash = [{ page: { ...doc.pages[2], id: 'pg_gone', render: { ...emptyRender(), status: 'ready', asset: { path: 'gone.webp', source: 'generated', at: 1 }, jobHash: 'T' } }, fromN: 3, deletedAt: 1 }];
    expect(findJobHashAsset(doc, 'T', page1)?.asset.path).toBe('gone.webp');
  });
});

describe('R7 InflightJobs', () => {
  it('the first registers, a second awaits its asset; the entry clears when settled (once)', async () => {
    const inflight = new InflightJobs();
    expect(inflight.get('h')).toBeUndefined();
    const settle = inflight.register('h');
    const joined = inflight.get('h')!;
    settle({ path: 'x.webp', source: 'generated', at: 1 });
    settle(null);
    await expect(joined).resolves.toMatchObject({ path: 'x.webp' });
    expect(inflight.get('h')).toBeUndefined();
    expect(inflight.size).toBe(0);
  });

  it('a failed job resolves joiners with null so they draw themselves', async () => {
    const inflight = new InflightJobs();
    const settle = inflight.register('h');
    const joined = inflight.get('h')!;
    settle(null);
    await expect(joined).resolves.toBeNull();
  });
});

describe('ledger label', () => {
  it('says what was saved', () => {
    expect(reusedLabel('Page 1', 0.0754)).toBe('Page 1 (reused — saved ≈$0.08)');
    expect(reusedLabel('Cover', 0)).toBe('Cover (reused)');
  });
});
