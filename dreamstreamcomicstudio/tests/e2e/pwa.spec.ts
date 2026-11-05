// pwa.spec.ts (mobile.md §9.1/§10.4): the web app manifest is valid and installable, its icons
// resolve with the declared sizes, and index.html links it with an apple-touch-icon and two
// theme-color metas (light + dark). Device-independent: runs once, on desktop-1440.

import { test, expect } from './helpers/harness';

test('manifest, icons and head tags', async ({ device, request }) => {
  test.skip(device.name !== 'desktop-1440', 'device-independent; runs once');
  const res = await request.get('/app.webmanifest');
  expect(res.status(), '/app.webmanifest is served').toBe(200);
  const manifest = JSON.parse(await res.text()) as {
    id?: string;
    start_url?: string;
    display?: string;
    icons?: Array<{ src: string; sizes?: string; purpose?: string; type?: string }>;
  };
  expect(manifest.id, 'manifest id').toBeTruthy();
  expect(manifest.start_url, 'start_url').toBeTruthy();
  expect(manifest.display).toBe('standalone');
  const icons = manifest.icons || [];
  for (const size of ['192x192', '512x512']) expect(icons.some((i) => (i.sizes || '').split(/\s+/).includes(size)), `a ${size} icon`).toBe(true);
  expect(icons.some((i) => /maskable/.test(i.purpose || '')), 'a maskable icon').toBe(true);
  for (const icon of icons) {
    const r = await request.get(new URL(icon.src, 'http://x/').pathname);
    expect(r.status(), `${icon.src} resolves`).toBe(200);
    const body = await r.body();
    if (icon.sizes && /png/i.test(icon.type || icon.src) && body.length > 24) {
      // PNG IHDR: width/height at bytes 16..23.
      const w = body.readUInt32BE(16);
      const h = body.readUInt32BE(20);
      expect(`${w}x${h}`, `${icon.src} has its declared size`).toBe(icon.sizes.split(/\s+/)[0]);
    }
  }
  const html = await (await request.get('/index.html')).text();
  expect(html).toMatch(/<link[^>]+rel="manifest"/);
  expect(html).toMatch(/<link[^>]+rel="apple-touch-icon"/);
  expect((html.match(/<meta[^>]+name="theme-color"/g) || []).length).toBeGreaterThanOrEqual(2);
});
