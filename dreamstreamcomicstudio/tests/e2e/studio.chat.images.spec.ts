// studio.chat.images.spec.ts (PF-2, perf F2; pixel-8 only): opening a studio chat must not pull full-size
// originals into 40–200 px tiles. The heist-12p chat reaches 7 drawn pages, the cover, a character sheet and a
// style board through its renders, style, cast, breakdown and recap cards (≈ the production f8312c86 shape);
// the harness serves each as a ≈ 190 KB original plus 480w / 1080w variants. Chrome DevTools Protocol counts
// the bytes every image in the conversation log really transferred, after the log is scrolled end to end so
// every lazy tile had its chance to load: ≤ 0.6 MB, every decoded image ≤ 480 px wide, no `data-heavy-img`.
// (Before PF-2 the renders card alone pulled ≈ 1.7 MB of originals here; in production ≈ 4.6 MB.)

import { test, expect } from './helpers/harness';

const BUDGET_BYTES = 0.6 * 1000 * 1000;

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
    const bytesOf = (u: string) => Math.max(cdpBytes.get(u) ?? 0, bodyBytes.get(u) ?? 0);
    const total = urls.reduce((sum, u) => sum + bytesOf(u), 0);
    test.info().annotations.push({
      type: 'chat-images',
      description: `${urls.length} images · ${Math.round(total / 1000)} KB · ${urls.map((u) => `${u.split('/').pop()} ${Math.round(bytesOf(u) / 1000)} KB`).join(', ')}`
    });

    // Something must have loaded, or "small and few" would pass on an empty (or broken) log.
    expect(urls.length, 'the chat shows decoded art').toBeGreaterThanOrEqual(8);
    expect(urls.filter((u) => bytesOf(u) === 0), 'every image was measured').toEqual([]);
    expect(art.filter((i) => i.heavy).map((i) => i.src), 'no full-size original in the chat').toEqual([]);
    expect(loaded.filter((i) => i.w > 480).map((i) => `${i.w}w ${i.src.split('/').pop()}`), 'every tile decodes a ≤ 480 px variant').toEqual([]);
    expect(art.filter((i) => !i.lazy).map((i) => i.src.split('/').pop()), 'chat art is lazy-loaded').toEqual([]);
    expect(total, `image bytes for the chat (${Math.round(total / 1000)} KB)`).toBeLessThanOrEqual(BUDGET_BYTES);
  });
});
