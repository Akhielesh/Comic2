// studio.chat.images.spec.ts (PF-2, perf F2; pixel-8 only): opening a studio chat must not pull full-size
// originals into 40–200 px tiles. The heist-12p chat reaches 7 drawn pages, the cover, a character sheet and a
// style board through its renders, style, cast, breakdown and recap cards (≈ the production f8312c86 shape);
// the harness serves each as a ≈ 190 KB original plus 480w / 1080w variants. Chrome DevTools Protocol counts
// the bytes every image in the conversation log really transferred, after the log is scrolled end to end so
// every lazy tile had its chance to load: ≤ 0.6 MB, every decoded image ≤ 480 px wide, no `data-heavy-img`.
// (Before PF-2 the renders card alone pulled ≈ 1.7 MB of originals here; in production ≈ 4.6 MB.)
// Memory (perf F2 "decoded memory"): the decoded pixels of every image in the log (w × h × 4 bytes, what the
// browser holds per bitmap) stay ≤ 24 MB — 14 tiles at 480w are ≈ 16 MB, the same 14 originals 90–190 MB. When the
// page is cross-origin isolated, performance.measureUserAgentSpecificMemory() is recorded beside it (annotation).
// The fixture is heist-12p (10 images), not the 14-object f8312c86 shape: that one is the jsdom half
// (cards/chatThumbs.test.tsx) until the harness gains an f8312c86-shaped fixture (PF-2 wave note).

import { test, expect } from './helpers/harness';

const BUDGET_BYTES = 0.6 * 1000 * 1000;
/** Decoded RGBA bytes of every image in the chat log. */
const DECODED_BUDGET_BYTES = 24 * 1000 * 1000;

test.describe('chat images on a mid-range phone', () => {
  test.beforeEach(({ device }) => {
    test.skip(device.name !== 'pixel-8', 'pixel-8 profile only');
  });

  test('opening the chat loads ≤ 0.6 MB of images, every tile a 480w variant (CDP)', async ({ qa, page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    const urlOf = new Map<string, string>();
    const cdpBytes = new Map<string, number>();
    cdp.on('Network.requestWillBeSent', (e) => urlOf.set(e.requestId, e.request.url));
    cdp.on('Network.loadingFinished', (e) => {
      const url = urlOf.get(e.requestId);
      if (url && url.includes('/qa-assets/')) cdpBytes.set(url, (cdpBytes.get(url) ?? 0) + e.encodedDataLength);
    });
    // Routed (harness-fulfilled) responses may report a zero transfer size: the body length is the floor.
    const bodyBytes = new Map<string, number>();
    page.on('requestfinished', async (req) => {
      if (!req.url().includes('/qa-assets/')) return;
      const sizes = await req.sizes().catch(() => null);
      if (sizes) bodyBytes.set(req.url(), Math.max(bodyBytes.get(req.url()) ?? 0, sizes.responseBodySize));
    });

    await qa.open({ surface: 'studio', fixture: 'heist-12p' }, { settle: 800 });
    await qa.toChat();
    const log = page.locator('[role="log"]').first();
    await expect(log, 'the conversation log').toBeVisible();

    // Scroll whatever scrolls the log from top to bottom, so lazy tiles anywhere in it load.
    await log.evaluate(async (el) => {
      const scroller = (() => {
        for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) if (n.scrollHeight > n.clientHeight + 4) return n;
        return null;
      })();
      if (!scroller) return;
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      scroller.scrollTop = 0;
      await wait(250);
      for (let top = 0; top <= scroller.scrollHeight; top += Math.max(200, scroller.clientHeight * 0.8)) {
        scroller.scrollTop = top;
        await wait(160);
      }
      scroller.scrollTop = scroller.scrollHeight;
    });
    await qa.settle(1200);

    const imgs = await log.evaluate((el) =>
      Array.from(el.querySelectorAll('img')).map((img) => ({
        src: img.currentSrc || img.src,
        w: img.naturalWidth,
        complete: img.complete,
        heavy: img.hasAttribute('data-heavy-img'),
        lazy: img.getAttribute('loading') === 'lazy'
      }))
    );
    const art = imgs.filter((i) => i.src.includes('/qa-assets/'));
    const loaded = art.filter((i) => i.complete && i.w > 0);
    const urls = [...new Set(loaded.map((i) => i.src))];
    // Snapshot now: the size probe below fetches each URL once more.
    const measured = new Map(urls.map((u) => [u, Math.max(cdpBytes.get(u) ?? 0, bodyBytes.get(u) ?? 0)] as const));
    const bytesOf = (u: string) => measured.get(u) ?? 0;
    const total = urls.reduce((sum, u) => sum + bytesOf(u), 0);
    // The files' real pixel sizes. An <img> picked from a `w`-descriptor srcset reports a density-corrected
    // naturalWidth (CSS px: a 480w file in a 206 px slot reads 206), so each URL is probed once more without a
    // srcset — after the byte count above, from the cache. One bitmap per distinct URL, however many <img> show it.
    const files = await page.evaluate(
      async (list) =>
        Promise.all(
          list.map(async (src) => {
            const probe = new Image();
            probe.src = src;
            await probe.decode().catch(() => undefined);
            return { src, w: probe.naturalWidth, h: probe.naturalHeight };
          })
        ),
      urls
    );
    const decoded = files.reduce((sum, f) => sum + f.w * f.h * 4, 0);
    const agentMemory = await page
      .evaluate(async () => {
        const perf = performance as Performance & { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> };
        if (!self.crossOriginIsolated || typeof perf.measureUserAgentSpecificMemory !== 'function') return null;
        const timeout = new Promise<null>((r) => setTimeout(() => r(null), 5000));
        const m = await Promise.race([perf.measureUserAgentSpecificMemory(), timeout]);
        return m ? m.bytes : null;
      })
      .catch(() => null);
    test.info().annotations.push({
      type: 'chat-images',
      description: `${urls.length} images · ${Math.round(total / 1000)} KB · ${urls.map((u) => `${u.split('/').pop()} ${Math.round(bytesOf(u) / 1000)} KB`).join(', ')}`
    });
    test.info().annotations.push({
      type: 'chat-image-memory',
      description: `decoded ${(decoded / 1e6).toFixed(1)} MB for ${files.length} bitmaps (${files.map((f) => `${f.w}×${f.h}`).join(', ')}) · measureUserAgentSpecificMemory ${agentMemory === null ? 'unavailable (page not cross-origin isolated)' : `${(agentMemory / 1e6).toFixed(1)} MB`}`
    });

    // Something must have loaded, or "small and few" would pass on an empty (or broken) log.
    expect(urls.length, 'the chat shows decoded art').toBeGreaterThanOrEqual(8);
    expect(urls.filter((u) => bytesOf(u) === 0), 'every image was measured').toEqual([]);
    expect(art.filter((i) => i.heavy).map((i) => i.src), 'no full-size original in the chat').toEqual([]);
    expect(files.filter((f) => !(f.w > 0 && f.h > 0)).map((f) => f.src), 'every file was sized').toEqual([]);
    expect(files.filter((f) => f.w > 480).map((f) => `${f.w}w ${f.src.split('/').pop()}`), 'every tile decodes a ≤ 480 px variant').toEqual([]);
    expect(art.filter((i) => !i.lazy).map((i) => i.src.split('/').pop()), 'chat art is lazy-loaded').toEqual([]);
    expect(total, `image bytes for the chat (${Math.round(total / 1000)} KB)`).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(decoded, `decoded image memory for the chat (${(decoded / 1e6).toFixed(1)} MB)`).toBeLessThanOrEqual(DECODED_BUDGET_BYTES);
  });
});
