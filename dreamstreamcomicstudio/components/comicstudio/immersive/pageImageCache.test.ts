// Page image cache (reader.md §9.1): keyed by storage path (a relink never re-downloads), variant-aware,
// priority order, LRU with retained paths, expired links (400/403), CORS fallback, abort.
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { PageImageCache, pickVariant, useCachedImage, type CacheDeps } from './pageImageCache';
import { loadErrorText } from './ReaderSlot';

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const deps = (over: Partial<CacheDeps> = {}) => {
  const revoked: string[] = [];
  let n = 0;
  const d: CacheDeps & { revoked: string[] } = {
    revoked,
    fetch: vi.fn(async () => new Response(new Blob(['img'], { type: 'image/webp' }), { status: 200 })),
    createObjectURL: () => `blob:${(n += 1)}`,
    revokeObjectURL: (u) => revoked.push(u),
    decode: async () => ({ w: 800, h: 1200 }),
    palette: async () => ({ dominant: { r: 1, g: 2, b: 3 }, accent: { r: 1, g: 2, b: 3 }, lum: 0.5, neutral: false }),
    idle: (fn) => fn(),
    ...over
  };
  return d;
};

describe('PageImageCache', () => {
  it('fetches, decodes and serves an object URL; the palette follows', async () => {
    const d = deps();
    const c = new PageImageCache(d);
    const e = await c.ensure('u/p1.webp', 'https://x/p1?sig=a', 'now');
    expect(e).toMatchObject({ state: 'ready', objectUrl: 'blob:1', w: 800, h: 1200 });
    await flush();
    expect(c.get('u/p1.webp')?.palette?.lum).toBe(0.5);
    expect(d.fetch).toHaveBeenCalledWith('https://x/p1?sig=a', expect.objectContaining({ mode: 'cors', credentials: 'omit', priority: 'high' }));
  });

  it('is keyed by path: a re-signed URL never re-downloads a cached page', async () => {
    const d = deps();
    const c = new PageImageCache(d);
    await c.ensure('u/p1.webp', 'https://x/p1?sig=a', 'now');
    await c.ensure('u/p1.webp', 'https://x/p1?sig=b', 'now');
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it('variants are separate entries', async () => {
    const d = deps();
    const c = new PageImageCache(d);
    await c.ensure('u/p1.webp', 'https://x/p1', 'now');
    await c.ensure('u/p1.1080w.webp', 'https://x/p1-1080', 'now');
    expect(d.fetch).toHaveBeenCalledTimes(2);
    expect(c.get('u/p1.1080w.webp')?.state).toBe('ready');
  });

  it('runs at most 3 downloads at once, current page first', async () => {
    const order: string[] = [];
    const gates: (() => void)[] = [];
    const d = deps({
      fetch: vi.fn(
        (url: string) =>
          new Promise<Response>((resolve) => {
            order.push(url);
            gates.push(() => resolve(new Response(new Blob(['x']), { status: 200 })));
          })
      )
    });
    const c = new PageImageCache(d);
    void c.ensure('a', 'A', 'idle');
    void c.ensure('b', 'B', 'idle');
    void c.ensure('c', 'C', 'idle');
    void c.ensure('d', 'D', 'idle');
    void c.ensure('e', 'E', 'now');
    expect(order).toEqual(['A', 'B', 'C']);
    gates[0]();
    await flush();
    expect(order[3]).toBe('E');
  });

  it('a 400/403 marks the link expired (the host relinks); a new URL retries', async () => {
    const d = deps({ fetch: vi.fn(async () => new Response('', { status: 403 })) });
    const c = new PageImageCache(d);
    expect(await c.ensure('u/p.webp', 'https://x/old', 'now')).toMatchObject({ state: 'error', expired: true });
    expect(await c.ensure('u/p.webp', 'https://x/old', 'now')).toMatchObject({ state: 'error' });
    expect(d.fetch).toHaveBeenCalledTimes(1);
    d.fetch = vi.fn(async () => new Response(new Blob(['x']), { status: 200 }));
    expect(await c.ensure('u/p.webp', 'https://x/new', 'now')).toMatchObject({ state: 'ready' });
  });

  it('CORS / network failure falls back to the plain URL (no palette)', async () => {
    const d = deps({ fetch: vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))) });
    const c = new PageImageCache(d);
    expect(await c.ensure('u/p.webp', 'https://x/p', 'now')).toMatchObject({ state: 'ready', direct: true, objectUrl: 'https://x/p' });
  });

  it('LRU evicts beyond the cap but never a retained path, revoking object URLs', async () => {
    const d = deps();
    const c = new PageImageCache(d, 3);
    c.retain(['p0']);
    for (let i = 0; i < 5; i += 1) await c.ensure(`p${i}`, `U${i}`, 'now');
    expect(c.get('p0')?.state).toBe('ready');
    expect(c.get('p1')).toBeUndefined();
    expect(c.get('p4')?.state).toBe('ready');
    expect(d.revoked.length).toBeGreaterThan(0);
  });

  it('an aborted idle preload is dropped before it starts', async () => {
    const gates: (() => void)[] = [];
    const d = deps({ fetch: vi.fn(() => new Promise<Response>((r) => gates.push(() => r(new Response(new Blob(['x']), { status: 200 }))))) });
    const c = new PageImageCache(d, 10, 1);
    void c.ensure('busy', 'B', 'now');
    const ac = new AbortController();
    const p = c.ensure('later', 'L', 'idle', ac.signal);
    ac.abort();
    gates[0]();
    expect((await p).state).toBe('error');
    expect(c.get('later')).toBeUndefined();
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it('a page that joins a queued preload adopts it: the preload\'s abort no longer drops it', async () => {
    const gates: (() => void)[] = [];
    const d = deps({ fetch: vi.fn(() => new Promise<Response>((r) => gates.push(() => r(new Response(new Blob(['x']), { status: 200 }))))) });
    const c = new PageImageCache(d, 10, 1);
    void c.ensure('busy', 'B', 'now');
    const ac = new AbortController();
    void c.ensure('next', 'N', 'idle', ac.signal);
    const shown = c.ensure('next', 'N', 'next'); // the page mounts (no signal)
    ac.abort(); // the reader moved on: the preload is cancelled
    gates[0]();
    await flush();
    gates[1]?.();
    expect((await shown).state).toBe('ready');
    expect(c.get('next')?.state).toBe('ready');
  });

  it('an abort never cancels a download that already started (a page may be waiting on it)', async () => {
    const gates: (() => void)[] = [];
    const d = deps({ fetch: vi.fn(() => new Promise<Response>((r) => gates.push(() => r(new Response(new Blob(['x']), { status: 200 }))))) });
    const c = new PageImageCache(d);
    const ac = new AbortController();
    const pre = c.ensure('p5', 'U5', 'idle', ac.signal);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect((d.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toHaveProperty('signal');
    const shown = c.ensure('p5', 'U5', 'next');
    ac.abort();
    gates[0]();
    expect((await shown).state).toBe('ready');
    expect((await pre).state).toBe('ready');
  });

  it('never evicts a page that is on screen (acquired), and lets it go once released', async () => {
    const d = deps();
    const c = new PageImageCache(d, 2);
    const release = c.acquire('p0');
    for (let i = 0; i < 4; i += 1) await c.ensure(`p${i}`, `U${i}`, 'now');
    expect(c.get('p0')?.state).toBe('ready');
    expect(c.inUseCount('p0')).toBe(1);
    release();
    release(); // idempotent
    expect(c.inUseCount('p0')).toBe(0);
    await c.ensure('p9', 'U9', 'now');
    expect(c.get('p0')).toBeUndefined();
  });

  it('useCachedImage holds its page and asks again when the entry vanished', async () => {
    const d = deps();
    const c = new PageImageCache(d);
    const { result, unmount } = renderHook(() => useCachedImage('u/p1.webp', 'https://x/p1', 'now', c));
    await waitFor(() => expect(result.current.src).toBe('blob:1'));
    expect(c.inUseCount('u/p1.webp')).toBe(1);
    act(() => c.clear()); // e.g. dropped by an aborted job
    await waitFor(() => expect(result.current.src).toBe('blob:2'));
    expect(d.fetch).toHaveBeenCalledTimes(2);
    unmount();
    expect(c.inUseCount('u/p1.webp')).toBe(0);
  });

  it('a transient failure retries on its own, a bounded number of times; an expired link never auto-retries', async () => {
    let calls = 0;
    const d = deps({ fetch: vi.fn(async () => ((calls += 1) === 1 ? new Response('', { status: 503 }) : new Response(new Blob(['x']), { status: 200 }))) });
    const c = new PageImageCache(d, 10, 3, [0, 0]);
    expect(await c.ensure('u/p.webp', 'https://x/p', 'now')).toMatchObject({ state: 'error', attempts: 1 });
    expect(c.retryIn('u/p.webp')).toBe(0);
    expect(await c.ensure('u/p.webp', 'https://x/p', 'now')).toMatchObject({ state: 'ready', attempts: undefined });

    const down = deps({ fetch: vi.fn(async () => new Response('', { status: 500 })) });
    const c2 = new PageImageCache(down, 10, 3, [0]);
    await c2.ensure('u/q.webp', 'https://x/q', 'now');
    expect(await c2.ensure('u/q.webp', 'https://x/q', 'now')).toMatchObject({ state: 'error', attempts: 2 });
    expect(c2.retryIn('u/q.webp')).toBeNull(); // out of attempts: the page says so instead of "retrying"
    await c2.ensure('u/q.webp', 'https://x/q', 'now');
    expect(down.fetch).toHaveBeenCalledTimes(2);

    const gone = deps({ fetch: vi.fn(async () => new Response('', { status: 403 })) });
    const c3 = new PageImageCache(gone, 10, 3, [0, 0]);
    await c3.ensure('u/r.webp', 'https://x/r', 'now');
    expect(c3.retryIn('u/r.webp')).toBeNull(); // only a fresh link helps (the host relinks)
  });

  it('useCachedImage retries a transient failure after its delay and reports it meanwhile', async () => {
    let calls = 0;
    const d = deps({ fetch: vi.fn(async () => ((calls += 1) === 1 ? new Response('', { status: 502 }) : new Response(new Blob(['x']), { status: 200 }))) });
    const c = new PageImageCache(d, 10, 3, [250]);
    const { result } = renderHook(() => useCachedImage('u/t.webp', 'https://x/t', 'now', c));
    await waitFor(() => expect(result.current).toMatchObject({ state: 'error', retrying: true }), { interval: 5 });
    expect(d.fetch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.src).toBe('blob:1'));
    expect(result.current.retrying).toBe(false);
    expect(d.fetch).toHaveBeenCalledTimes(2);
  });

  it('notifies subscribers', async () => {
    const c = new PageImageCache(deps());
    const fn = vi.fn();
    const off = c.subscribe(fn);
    await c.ensure('a', 'A', 'now');
    expect(fn).toHaveBeenCalled();
    off();
    c.clear();
    expect(c.get('a')).toBeUndefined();
  });
});

describe('pickVariant', () => {
  const asset = { path: 'u/p.webp', source: 'generated' as const, at: 0, w: 2048, h: 3072, variants: [{ path: 'u/p.480w.webp', w: 480, h: 720 }, { path: 'u/p.1080w.webp', w: 1080, h: 1620 }] };
  it('the smallest variant ≥ width × min(dpr, 2), else the original', () => {
    expect(pickVariant(asset, 200, { dpr: 2 })).toEqual({ path: 'u/p.480w.webp', w: 480 });
    expect(pickVariant(asset, 390, { dpr: 3 })).toEqual({ path: 'u/p.1080w.webp', w: 1080 });
    expect(pickVariant(asset, 700, { dpr: 2 })).toEqual({ path: 'u/p.webp' });
  });
  it('Save-Data caps at 1080w; guided zoom takes the original; no variants → original', () => {
    expect(pickVariant(asset, 700, { dpr: 2, saveData: true })).toEqual({ path: 'u/p.1080w.webp', w: 1080 });
    expect(pickVariant(asset, 200, { dpr: 2, original: true })).toEqual({ path: 'u/p.webp' });
    expect(pickVariant({ path: 'u/x.webp', source: 'generated', at: 0 }, 300)).toEqual({ path: 'u/x.webp' });
  });
});

describe('a page that failed to load says only what really happens next', () => {
  it('expired + a host that relinks → fresh link; transient → trying again; out of retries → no promise of a retry now', () => {
    expect(loadErrorText(true, true, false)).toMatch(/fresh one/);
    expect(loadErrorText(true, false, false)).not.toMatch(/fresh|trying again/);
    expect(loadErrorText(false, true, true)).toMatch(/trying again/);
    expect(loadErrorText(false, true, false)).toMatch(/reopen the reader/);
  });
});
