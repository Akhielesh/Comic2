// ref_crop (refs.md §3 auto-crop, §9): a free crop makes a NEW private asset, keeps the photo's
// place/label/safety, records the original, and "Reset crop" restores it. Never a model call.
import { describe, expect, it } from 'vitest';
import type { RefAsset } from '../../../../shared/comic/doc.js';
import { newSession, opsOf, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { startAction } from '../jobs.js';
import { ACTION_HANDLERS } from './index.js';

const ref = (n: number, extra: Partial<RefAsset> = {}): RefAsset => ({ path: `u/user-1/p/proj-1/ref/r${n}.webp`, source: 'upload', at: n, w: 2000, h: 1500, ...extra });
const MAYA = { kind: 'character', id: 'c_maya' } as const;

const setup = () => {
  const doc = plannedDoc();
  doc.cast[0].refs = [ref(1, { label: 'front', note: 'red scarf', safety: { assessed: 'G', at: 1 }, dhash: '0f0f0f0f0f0f0f0f' }), ref(2)];
  const ctx = testContext(newSession(doc));
  return ctx;
};

describe('ref_crop', () => {
  it('is registered as a free (non-spend) action', () => {
    expect(ACTION_HANDLERS.ref_crop).toMatchObject({ type: 'ref_crop', spend: false });
  });

  it('auto (attention) crop: a new private asset in the same slot, original kept, $0', async () => {
    const ctx = setup();
    const started = await startAction(ctx, { type: 'ref_crop', owner: MAYA, path: ref(1).path }, { confirmed: true });
    expect(started.outcome).toMatchObject({ status: 'done' });
    expect(started.outcome.message).toMatch(/free, done by software/);
    expect(ctx.assetsFake.crops).toEqual([{ path: ref(1).path, aspect: '1:1' }]);
    const refs = ctx.session.doc.cast[0].refs;
    expect(refs).toHaveLength(2);
    expect(refs[0].path).toMatch(/^u\/user-1\/p\/proj-1\/ref\/crop-\d+\.webp$/);
    expect(refs[0]).toMatchObject({ label: 'front', note: 'red scarf', safety: { assessed: 'G' }, original: { path: ref(1).path }, w: 1024, h: 1024, source: 'upload' });
    expect(refs[0].dhash).toBeUndefined();
    expect(ctx.billingFake.reserves).toHaveLength(0);
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('re-cropping cuts from the original (never compounds) and Reset restores it', async () => {
    const ctx = setup();
    await startAction(ctx, { type: 'ref_crop', owner: MAYA, path: ref(1).path, aspect: '3:4' }, { confirmed: true });
    const first = ctx.session.doc.cast[0].refs[0];
    await startAction(ctx, { type: 'ref_crop', owner: MAYA, path: first.path, box: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }, { confirmed: true });
    expect(ctx.assetsFake.crops.map((c) => c.path)).toEqual([ref(1).path, ref(1).path]);
    const second = ctx.session.doc.cast[0].refs[0];
    expect(second.original?.path).toBe(ref(1).path);
    const reset = await startAction(ctx, { type: 'ref_crop', owner: MAYA, path: second.path, reset: true }, { confirmed: true });
    expect(reset.outcome).toMatchObject({ status: 'done' });
    const back = ctx.session.doc.cast[0].refs[0];
    expect(back.path).toBe(ref(1).path);
    expect(back.original).toBeUndefined();
    expect(back.crop).toBeUndefined();
    expect(back).toMatchObject({ label: 'front', w: 2000, h: 1500 });
  });

  it('is honest about missing photos and bad boxes', async () => {
    const ctx = setup();
    const gone = await startAction(ctx, { type: 'ref_crop', owner: MAYA, path: ref(9).path }, { confirmed: true });
    expect(gone.outcome).toMatchObject({ status: 'blocked', code: 'NOT_FOUND' });
    await expect(startAction(ctx, { type: 'ref_crop', owner: MAYA, path: ref(1).path, box: { x: 0.9, y: 0, w: 0.5, h: 0.5 } }, { confirmed: true })).rejects.toMatchObject({
      status: 400
    });
    const never = await startAction(ctx, { type: 'ref_crop', owner: MAYA, path: ref(2).path, reset: true }, { confirmed: true });
    expect(never.outcome.message).toMatch(/never cropped/);
    // Nothing above changed a ref.
    expect(opsOf(ctx.events).filter((o) => o.op === 'ref_patch')).toEqual([]);
  });

  it('a storage failure leaves the photo as it was and says so', async () => {
    const ctx = setup();
    ctx.assetsFake.missing.add(ref(1).path);
    const out = await startAction(ctx, { type: 'ref_crop', owner: MAYA, path: ref(1).path }, { confirmed: true });
    expect(out.outcome).toMatchObject({ status: 'blocked' });
    expect(out.outcome.message).toMatch(/couldn't crop that photo.*Nothing was changed/);
    expect(ctx.session.doc.cast[0].refs[0].path).toBe(ref(1).path);
  });
});
