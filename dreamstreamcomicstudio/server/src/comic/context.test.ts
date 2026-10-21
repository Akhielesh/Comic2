import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyDoc } from '../../../shared/comic/doc.js';
import type { StudioEvent } from '../../../shared/comic/events.js';
import { createStudioContext } from './context.js';
import { KEYS, fakeAssetStore, fakeBilling, fakeDocStore, fakeImages, scriptedLlm } from './orchestrator.fakes.js';
import { SESSION_IDLE_MS, StudioSession } from './session.js';

const req = { user: { id: 'user-1' }, header: () => undefined } as unknown as Request;

const build = (assets = fakeAssetStore()) => {
  const session = new StudioSession({ projectId: 'p1', userId: 'user-1', doc: createEmptyDoc('p1'), store: fakeDocStore() });
  const events: StudioEvent[] = [];
  session.subscribe((e) => events.push(e));
  const ctx = createStudioContext({
    req,
    session,
    deps: { keys: KEYS, llm: scriptedLlm(), images: fakeImages().generate, assets, billing: fakeBilling() },
    qualityDenied: 'Pro needs a paid plan.'
  });
  return { session, events, ctx, assets };
};

describe('createStudioContext', () => {
  it('wires identity, keys, signal and request-scoped flags', () => {
    const { ctx, session } = build();
    expect(ctx).toMatchObject({ userId: 'user-1', projectId: 'p1', keys: KEYS, qualityDenied: 'Pro needs a paid plan.' });
    expect(ctx.signal).toBe(session.abort.signal);
    const turn = new AbortController();
    const other = createStudioContext({ req, session, signalFrom: turn.signal, deps: { keys: {}, llm: scriptedLlm(), images: fakeImages().generate, assets: fakeAssetStore(), billing: fakeBilling() } });
    expect(other.signal).toBe(turn.signal);
    expect(other.qualityDenied).toBeUndefined();
  });

  it('publishUrls signs unique paths and streams them; signing failures never throw', async () => {
    const { ctx, events, assets } = build();
    await ctx.publishUrls(['a.webp', 'a.webp', '', 'b.webp']);
    expect(assets.signed).toEqual([['a.webp', 'b.webp']]);
    expect(events).toEqual([{ type: 'urls', urls: { 'a.webp': 'https://signed.test/a.webp', 'b.webp': 'https://signed.test/b.webp' } }]);
    await ctx.publishUrls([]);
    expect(assets.signed).toHaveLength(1);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    assets.signUrls = async () => {
      throw new Error('storage down');
    };
    await expect(ctx.publishUrls(['c.webp'])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('settled() waits for tracked work, including work tracked while waiting, and ignores failures', async () => {
    const { ctx } = build();
    const order: string[] = [];
    let releaseOuter!: () => void;
    const outer = new Promise<void>((r) => (releaseOuter = r)).then(() => {
      order.push('outer');
      void ctx.track(
        new Promise<void>((r) => setTimeout(r, 5)).then(() => {
          order.push('inner');
        })
      );
    });
    void ctx.track(outer);
    void ctx.track(Promise.reject(new Error('ignored'))).catch(() => undefined);
    const settled = ctx.settled().then(() => order.push('settled'));
    releaseOuter();
    await settled;
    expect(order).toEqual(['outer', 'inner', 'settled']);
  });

  it('tracked work keeps the session from going idle', async () => {
    const { ctx, session } = build();
    const later = Date.now() + SESSION_IDLE_MS + 1;
    let release!: () => void;
    void ctx.track(new Promise<void>((r) => (release = r)));
    session.dispose(); // drop the test subscriber so only the tracked work counts
    expect(session.isIdle(later)).toBe(false);
    release();
    await ctx.settled();
    expect(session.isIdle(later)).toBe(true);
  });
});
