// @vitest-environment node
// What a page job may send (A6 wave note 2): one implementation for the studio's runner (jobs.ts) and the Model Lab's
// Pro pages A/B (lab.ts). The lab adds one stricter rule on top (uploads with no safety verdict are withheld).
import { describe, expect, it } from 'vitest';
import type { AssetRef, ComicDoc } from '../../../shared/comic/doc.js';
import { deriveLock, lockOf, lockedSpecId } from '../../../shared/comic/modelLock.js';
import { quoteLockOf } from '../../../shared/comic/plan.js';
import { blockedPaths, nearestReadyBefore, withoutAssets } from '../../../shared/comic/sendable.js';
import * as jobs from './jobs.js';
import { labWithheldPaths } from './models/lab.js';
import { plannedDoc } from './orchestrator.fakes.js';

const at = 1_700_000_000_000;
const quarantined = (path: string): AssetRef => ({ path, source: 'upload', at, safety: { quarantined: true, at } });
const unchecked = (path: string): AssetRef => ({ path, source: 'upload', at });
const passed = (path: string): AssetRef => ({ path, source: 'upload', at, safety: { assessed: 'PG', at } });

/** Pages 1–3 drawn on Nano Banana 2.1 (page 2's image blocked), one blocked style ref, one unchecked and one checked
 *  cast ref. */
const gatedDoc = (): ComicDoc => {
  const doc = plannedDoc();
  const pages = doc.pages.slice(0, 3);
  pages.forEach((p, i) => {
    p.render = { ...p.render, status: 'ready', model: 'nano-banana-2.1', asset: { path: `pg_${i + 1}.webp`, source: 'generated', model: 'nano-banana-2.1', at: at + i, w: 1024, h: 1536 } };
  });
  pages[1].render.asset = { ...pages[1].render.asset!, safety: { assessed: 'X', at } };
  doc.style = { ...doc.style, refs: [quarantined('style_bad.webp'), passed('style_ok.webp')] };
  doc.cast[0] = { ...doc.cast[0], refs: [unchecked('cast_new.webp'), passed('cast_ok.webp')] };
  return doc;
};

describe('sendable: what a page job may send to an image model', () => {
  it('blockedPaths: blocked and quarantined images only (an unchecked upload is the runner’s lazy check, not blocked)', () => {
    expect([...blockedPaths(gatedDoc())].sort()).toEqual(['pg_2.webp', 'style_bad.webp']);
  });

  it('withoutAssets drops the paths everywhere they are attached; a gone page image reads as not drawn', () => {
    const doc = gatedDoc();
    const out = withoutAssets(doc, new Set(['style_bad.webp', 'cast_new.webp', 'pg_2.webp']));
    expect(out.style.refs.map((r) => r.path)).toEqual(['style_ok.webp']);
    expect(out.cast[0].refs.map((r) => r.path)).toEqual(['cast_ok.webp']);
    expect(out.pages[1].render).toMatchObject({ status: 'none', asset: undefined });
    expect(out.pages[0].render.asset?.path).toBe('pg_1.webp');
    // The stored doc is never changed, and an empty set is the doc itself.
    expect(doc.style.refs).toHaveLength(2);
    expect(withoutAssets(doc, new Set())).toBe(doc);
  });

  it('nearestReadyBefore skips a blocked page: page 3 continues from page 1', () => {
    const doc = gatedDoc();
    expect(nearestReadyBefore(doc, doc.pages[2])?.id).toBe(doc.pages[0].id);
    expect(nearestReadyBefore(doc, doc.pages[0])).toBeUndefined();
  });

  it('the Model Lab withholds what the runner blocks, plus uploads with no safety verdict yet', () => {
    const doc = gatedDoc();
    const lab = labWithheldPaths(doc);
    for (const p of blockedPaths(doc)) expect(lab.has(p)).toBe(true);
    expect([...lab].sort()).toEqual(['cast_new.webp', 'pg_2.webp', 'style_bad.webp']);
  });

  it('one lock rule: the runner re-exports the shared lockOf and lockedSpecId, and the quotes price on the same lock', () => {
    expect(jobs.lockOf).toBe(lockOf);
    expect(jobs.lockedSpecId).toBe(lockedSpecId);
    const doc = gatedDoc();
    expect(lockOf(doc)).toMatchObject({ modelId: 'nano-banana-2.1', origin: 'migrated' });
    expect(lockOf(doc)).toEqual(deriveLock(doc));
    expect(quoteLockOf(doc)).toEqual(lockOf(doc));
    // The persisted lock wins over the legacy derivation.
    const persisted = { modelId: 'nano-banana-pro', lockedAt: at, origin: 'user_change' as const };
    expect(lockOf({ ...doc, imageModel: persisted })).toBe(persisted);
    expect(lockedSpecId('no-such-model')).toBe('no-such-model');
  });
});
