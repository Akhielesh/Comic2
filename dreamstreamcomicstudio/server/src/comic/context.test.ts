import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyDoc } from '../../../shared/comic/doc.js';
import type { StudioEvent } from '../../../shared/comic/events.js';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities.js';
import { createStudioContext, signAssetPaths, spendLockedBilling } from './context.js';
import { registryPriceBook, setModelCatalog, type ModelCatalog } from './models/index.js';
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

describe('the request PriceBook (models.md §2.3)', () => {
  it('is built once per request (memoised), never at construction, and a test or route can bring its own', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let reads = 0;
    // The catalog read fails here, so createPriceBook falls back to the registry list (it never throws).
    setModelCatalog({
      priceSources: async () => {
        reads += 1;
        throw new Error('catalog offline');
      }
    } as unknown as ModelCatalog);
    try {
      const { ctx } = build();
      expect(reads).toBe(0); // nothing is fetched until a quote asks
      const [a, b] = await Promise.all([ctx.prices!(), ctx.prices!()]);
      expect(a).toBe(b);
      expect(reads).toBe(1);
      expect(a.unit('nano-banana-2.1', '2K', 'page')).toEqual(registryPriceBook().unit('nano-banana-2.1', '2K', 'page'));
      await build().ctx.prices!(); // another request reads again
      expect(reads).toBe(2);

      const own = registryPriceBook();
      const session = new StudioSession({ projectId: 'p2', userId: 'user-1', doc: createEmptyDoc('p2'), store: fakeDocStore() });
      const injected = createStudioContext({ req, session, deps: { keys: KEYS, llm: scriptedLlm(), images: fakeImages().generate, assets: fakeAssetStore(), billing: fakeBilling(), prices: async () => own } });
      expect(await injected.prices!()).toBe(own);
      expect(reads).toBe(2);
    } finally {
      setModelCatalog(null);
      warn.mockRestore();
    }
  });
});

describe('v5 context: caps, rating, spend lock, private signing', () => {
  it('carries caps and the effective rating when given', () => {
    const session = new StudioSession({ projectId: 'p1', userId: 'user-1', doc: createEmptyDoc('p1'), store: fakeDocStore() });
    const caps = { ...DEFAULT_CAPS, plan: 'paid' as const };
    const ctx = createStudioContext({ req, session, deps: { keys: KEYS, llm: scriptedLlm(), images: fakeImages().generate, assets: fakeAssetStore(), billing: fakeBilling() }, caps, rating: 'PG' });
    expect(ctx.caps).toBe(caps);
    expect(ctx.rating).toBe('PG');
    expect(ctx.spendBlocked).toBeUndefined();
  });

  it('a restricted account cannot reserve image or translation spend; text work still reserves', async () => {
    const billing = fakeBilling();
    const locked = spendLockedBilling(billing, 'Paused.');
    expect(await locked.reserve({ operation: 'comic.image.page', provider: 'openrouter', model: 'm', stage: 'page', imageUnits: 1 })).toEqual({ ok: false, code: 'BILLING_DENIED', message: 'Paused.' });
    expect(await locked.reserve({ operation: 'comic.text.translate', provider: 'openrouter', model: 'm', stage: 'translate', inputTokens: 10 })).toMatchObject({ ok: false });
    expect(billing.reserves).toHaveLength(0);
    expect(await locked.reserve({ operation: 'comic.text.director', provider: 'openrouter', model: 'm', stage: 'chat', inputTokens: 10 })).toMatchObject({ ok: true });
    expect(billing.reserves).toHaveLength(1);

    const session = new StudioSession({ projectId: 'p1', userId: 'user-1', doc: createEmptyDoc('p1'), store: fakeDocStore() });
    const ctx = createStudioContext({ req, session, deps: { keys: KEYS, llm: scriptedLlm(), images: fakeImages().generate, assets: fakeAssetStore(), billing: fakeBilling() }, spendBlocked: 'Paused.' });
    expect(ctx.spendBlocked).toBe('Paused.');
    expect(await ctx.billing.reserve({ operation: 'x', provider: 'gemini', model: 'm', stage: 'cover', imageUnits: 1 })).toMatchObject({ ok: false, message: 'Paused.' });
  });

  it('signs private paths (refs, quarantine) with the 300 s TTL and keeps the lanes independent', async () => {
    const assets = fakeAssetStore();
    const urls = await signAssetPaths(assets, ['u/a/p/b/img/x.webp', 'u/a/p/b/ref/y.webp', 'q/a/b/z.webp', 'u/a/p/b/img/x.webp', '']);
    expect(Object.keys(urls).sort()).toEqual(['q/a/b/z.webp', 'u/a/p/b/img/x.webp', 'u/a/p/b/ref/y.webp']);
    expect(assets.signed).toEqual([['u/a/p/b/img/x.webp'], ['u/a/p/b/ref/y.webp', 'q/a/b/z.webp']]);
    expect(assets.signedTtl).toEqual([undefined, 300]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const original = assets.signUrls.bind(assets);
    assets.signUrls = async (paths, opts) => {
      if (opts?.ttlSec) throw new Error('private bucket down');
      return original(paths, opts);
    };
    expect(await signAssetPaths(assets, ['u/a/p/b/img/x.webp', 'u/a/p/b/ref/y.webp'])).toEqual({ 'u/a/p/b/img/x.webp': 'https://signed.test/u/a/p/b/img/x.webp' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(await signAssetPaths(assets, [])).toEqual({});
  });
});
