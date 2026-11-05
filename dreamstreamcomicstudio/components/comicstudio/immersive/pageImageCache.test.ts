// Page image cache (reader.md §9.1): keyed by storage path (a relink never re-downloads), variant-aware,
// priority order, LRU with retained paths, expired links (400/403), CORS fallback, abort.
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  byteBudgetFor,
  CACHE_BYTE_BUDGET,
  holdUntilDecoded,
  PageImageCache,
  pickVariant,
  standInVariant,
  useCachedImage,
  type CacheDeps
} from './pageImageCache';
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
    // The retry fires after its 250 ms delay plus the load scheduler; on a busy CI runner that can pass the
    // default 1 s, so wait with headroom (the assertion is that it retries, not how fast).
    await waitFor(() => expect(result.current.src).toBe('blob:1'), { timeout: 4000 });
    expect(result.current.retrying).toBe(false);
    expect(d.fetch).toHaveBeenCalledTimes(2);
  });

  it('useCachedImage still retries when its timer fires a little early by the wall clock (a busy event loop)', async () => {
    let calls = 0;
    const d = deps({ fetch: vi.fn(async () => ((calls += 1) === 1 ? new Response('', { status: 502 }) : new Response(new Blob(['x']), { status: 200 }))) });
    const c = new PageImageCache(d, 10, 3, [250]);
    const realNow = Date.now.bind(Date);
    let lag = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - lag);
    try {
      const { result } = renderHook(() => useCachedImage('u/e.webp', 'https://x/e', 'now', c));
      await waitFor(() => expect(result.current).toMatchObject({ state: 'error', retrying: true }), { interval: 5 });
      // Node schedules timers from the loop's cached time: under load the retry timer fires while the wall clock
      // still reads before failedAt + delay. The hook waits out the remainder instead of giving up.
      lag = 100;
      await waitFor(() => expect(result.current.src).toBe('blob:1'), { timeout: 4000 });
      expect(d.fetch).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
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

// ── RD-5 engine (reader.md §8, V1 C7/C8): blob-byte budget, isDecoded, stand-ins, the turn gate ─────────
const MB = 1024 * 1024;
/** Deps whose fetched files are `mb` megabytes each (a response whose blob reports that size). */
const sizedDeps = (mb: (url: string) => number) =>
  deps({ fetch: vi.fn(async (url: string) => ({ ok: true, status: 200, blob: async () => ({ size: Math.round(mb(url) * MB), type: 'image/webp' }) }) as unknown as Response) });

describe('PageImageCache · byte budget (blob bytes, not a count)', () => {
  it('evicts least-recently-used entries by blob bytes at 48 MB, revoking their URLs; the count alone would keep them', async () => {
    const d = sizedDeps(() => 10);
    const c = new PageImageCache(d, 48, 3, undefined, CACHE_BYTE_BUDGET.phone);
    for (let i = 0; i < 6; i += 1) await c.ensure(`p${i}`, `U${i}`, 'now');
    // 6 × 10 MB > 48 MB: the two oldest go, although 6 entries are far under the 48-entry cap.
    expect(c.get('p0')).toBeUndefined();
    expect(c.get('p1')).toBeUndefined();
    expect(c.get('p5')?.state).toBe('ready');
    expect(c.totalBytes()).toBeLessThanOrEqual(48 * MB);
    expect(c.get('p5')?.bytes).toBe(10 * MB);
    expect(d.revoked.length).toBe(2);
  });

  it('never evicts an entry a mounted page is showing (in use) or the reader retains, even over budget', async () => {
    const d = sizedDeps(() => 30);
    const c = new PageImageCache(d, 48, 3, undefined, CACHE_BYTE_BUDGET.phone);
    const release = c.acquire('shown');
    c.retain(['kept']);
    await c.ensure('shown', 'S', 'now');
    await c.ensure('kept', 'K', 'now');
    await c.ensure('other', 'O', 'now');
    expect(c.get('shown')?.state).toBe('ready');
    expect(c.get('kept')?.state).toBe('ready');
    expect(c.get('other')?.state).toBe('ready'); // the newest stays too: nothing else can go, so it is over budget for now
    await c.ensure('later', 'L', 'now');
    expect(c.get('other')).toBeUndefined();
    release();
    c.retain([]);
    await c.ensure('last', 'Z', 'now');
    expect(c.totalBytes()).toBeLessThanOrEqual(48 * MB);
  });

  it('a lower budget evicts at once, least recently used first', async () => {
    const d = sizedDeps((u) => (u.startsWith('S') ? 0.03 : 20));
    const c = new PageImageCache(d);
    expect(c.byteBudget()).toBe(CACHE_BYTE_BUDGET.desktop);
    for (let i = 0; i < 4; i += 1) {
      await c.ensure(`p${i}`, `U${i}`, 'now');
      await c.ensure(`s${i}`, `S${i}`, 'now');
    }
    expect(c.totalBytes()).toBeGreaterThan(48 * MB);
    c.setByteBudget(CACHE_BYTE_BUDGET.lowMemory);
    expect(c.totalBytes()).toBeLessThanOrEqual(24 * MB);
    for (let i = 0; i < 3; i += 1) expect(c.get(`p${i}`), `page ${i}`).toBeUndefined();
    expect(c.get('p3')?.state).toBe('ready');
    expect(c.get('s3')?.state).toBe('ready');
  });

  it('the budget follows the device: 24 MB at ≤ 2 GB, 48 MB on phones or ≤ 4 GB, else 96 MB', () => {
    expect(byteBudgetFor({ deviceMemory: 2 })).toBe(24 * MB);
    expect(byteBudgetFor({ coarse: true })).toBe(48 * MB);
    expect(byteBudgetFor({ deviceMemory: 4 })).toBe(48 * MB);
    expect(byteBudgetFor({ coarse: true, deviceMemory: 1 })).toBe(24 * MB);
    expect(byteBudgetFor({ deviceMemory: 8 })).toBe(96 * MB);
    expect(byteBudgetFor({})).toBe(96 * MB);
  });
});

describe('PageImageCache · isDecoded', () => {
  it('is true only once a path is decoded and ready (synchronous)', async () => {
    let open!: () => void;
    const d = deps({ fetch: vi.fn(() => new Promise<Response>((r) => (open = () => r(new Response(new Blob(['x']), { status: 200 }))))) });
    const c = new PageImageCache(d);
    expect(c.isDecoded('p')).toBe(false);
    const p = c.ensure('p', 'U', 'now');
    expect(c.isDecoded('p')).toBe(false);
    open();
    await p;
    expect(c.isDecoded('p')).toBe(true);
    expect(c.isDecoded(undefined)).toBe(false);
  });
});

describe('stand-ins', () => {
  const asset = { path: 'u/p.png', source: 'generated' as const, at: 0, w: 1696, h: 2528, variants: [{ path: 'u/p_w480.webp', w: 480, h: 715 }, { path: 'u/p_w1080.webp', w: 1080, h: 1610 }] };
  it('a page’s stand-in is its ~480 px variant; none without one (old pages) or when the image is no wider', () => {
    expect(standInVariant(asset)).toEqual({ path: 'u/p_w480.webp', w: 480 });
    expect(standInVariant({ ...asset, variants: [{ path: 'u/p_w1080.webp', w: 1080, h: 1610 }] })).toBeUndefined();
    expect(standInVariant({ path: 'u/old.png', source: 'generated', at: 0 })).toBeUndefined();
    expect(standInVariant({ ...asset, w: 480 })).toBeUndefined();
  });
});

describe('holdUntilDecoded (the turn gate)', () => {
  const fakeCache = () => {
    const ready = new Set<string>();
    const subs = new Set<() => void>();
    return {
      ready,
      isDecoded: (p: string | undefined) => !!p && ready.has(p),
      subscribe: (fn: () => void) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      decode(p: string) {
        ready.add(p);
        for (const fn of [...subs]) fn();
      },
      subs
    };
  };

  it('goes at once when every page is decoded (by its source or its original)', () => {
    const c = fakeCache();
    c.ready.add('orig-a');
    const go = vi.fn();
    holdUntilDecoded(c, [['var-a', 'orig-a']], 300, go);
    expect(go).toHaveBeenCalledWith(false);
  });

  it('holds an undecoded turn until its pages decode, never longer than the limit, and goes once', () => {
    vi.useFakeTimers();
    try {
      const c = fakeCache();
      const go = vi.fn();
      holdUntilDecoded(c, [['a'], ['b']], 300, go);
      expect(go).not.toHaveBeenCalled();
      c.decode('a');
      expect(go).not.toHaveBeenCalled();
      c.decode('b');
      expect(go).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      expect(go).toHaveBeenCalledTimes(1);
      expect(c.subs.size).toBe(0);

      const late = vi.fn();
      holdUntilDecoded(c, [['never']], 300, late);
      vi.advanceTimersByTime(299);
      expect(late).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(late).toHaveBeenCalledWith(true);
      expect(c.subs.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a replaced turn cancels its hold (no late start)', () => {
    vi.useFakeTimers();
    try {
      const c = fakeCache();
      const go = vi.fn();
      const cancel = holdUntilDecoded(c, [['x']], 300, go);
      cancel();
      c.decode('x');
      vi.advanceTimersByTime(500);
      expect(go).not.toHaveBeenCalled();
      expect(c.subs.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
