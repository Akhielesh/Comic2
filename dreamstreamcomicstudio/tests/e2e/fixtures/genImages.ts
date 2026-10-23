// Fixture images for the QA harness (P1-QA; mobile.md §10.2), generated with sharp — no network,
// no real art, no user data.
//
// The QA controller references images by name: `qa/<seed>-<w>x<h>.png` (originals at the golden
// 1856×2304-class sizes plus the server's 480w and 1080w variants). The page asks for
// `/qa-assets/<seed>-<w>x<h>.png`; the harness route (helpers/harness.ts) answers from this module:
// a deterministic gradient with panel borders and the name printed small, cached on disk so every
// worker and every run serves identical bytes. Global setup checks the QA build exists and warms the
// cache with the golden set (an original and both variants), which also proves sharp works here.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const MAX_SIDE = 4096;
export const QA_IMAGE_RE = /\/qa-assets\/([a-z0-9][a-z0-9_-]{0,60})-(\d{2,5})x(\d{2,5})\.png$/i;

export const fixtureCacheDir = (): string =>
  path.join(process.env.QA_ARTIFACTS_RESOLVED || path.resolve(process.cwd(), 'node_modules/.cache/comic-qa'), 'fixtures');

const hueOf = (seed: string): number => {
  let h = 7;
  for (const ch of seed.replace(/-v\d+$/, '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string);

/** The SVG behind a fixture image: gradient paper, a 4-panel grid with ink borders, a small label. */
export const qaImageSvg = (seed: string, w: number, h: number): string => {
  const hue = hueOf(seed);
  const m = Math.max(4, Math.round(Math.min(w, h) * 0.025));
  const stroke = Math.max(2, Math.round(w * 0.004));
  const rowH = (h - m * 4) / 3;
  const half = (w - m * 3) / 2;
  const panels = [
    [m, m, w - 2 * m, rowH],
    [m, m * 2 + rowH, half, rowH],
    [m * 2 + half, m * 2 + rowH, half, rowH],
    [m, m * 3 + rowH * 2, w - 2 * m, rowH]
  ]
    .map(([x, y, pw, ph], i) => `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${pw.toFixed(1)}" height="${ph.toFixed(1)}" fill="url(#g${i})" stroke="#141414" stroke-width="${stroke}"/>`)
    .join('');
  const grads = [0, 1, 2, 3]
    .map((i) => `<linearGradient id="g${i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${(hue + i * 40) % 360},55%,78%)"/><stop offset="1" stop-color="hsl(${(hue + i * 40 + 30) % 360},50%,58%)"/></linearGradient>`)
    .join('');
  const label = escapeXml(`${seed} ${w}x${h}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${grads}</defs><rect width="${w}" height="${h}" fill="#fbf6ec"/>${panels}<text x="${w / 2}" y="${(h - m * 0.35).toFixed(1)}" font-family="DejaVu Sans, sans-serif" font-size="${Math.max(9, Math.round(m * 0.8))}" text-anchor="middle" fill="#333">${label}</text></svg>`;
};

/** Render one fixture image to PNG bytes (deterministic for a given seed and size). */
export const renderQaImage = async (seed: string, w: number, h: number): Promise<Buffer> => {
  if (!(w >= 16 && h >= 16 && w <= MAX_SIDE && h <= MAX_SIDE)) throw new Error(`qa image size out of range: ${w}x${h}`);
  return sharp(Buffer.from(qaImageSvg(seed, w, h)), { density: 72 }).png({ compressionLevel: 6, palette: false }).toBuffer();
};

const memo = new Map<string, Promise<Buffer>>();

/** Bytes for `/qa-assets/<file>` (null when the name is not a fixture image). Disk-cached across workers. */
export const qaImageBytes = (urlOrFile: string): Promise<Buffer> | null => {
  const m = QA_IMAGE_RE.exec(urlOrFile.startsWith('/qa-assets/') || urlOrFile.includes('/qa-assets/') ? urlOrFile : `/qa-assets/${urlOrFile}`);
  if (!m) return null;
  const [, seed, ws, hs] = m;
  const w = Number(ws);
  const h = Number(hs);
  if (!(w >= 16 && h >= 16 && w <= MAX_SIDE && h <= MAX_SIDE)) return null;
  const file = `${seed}-${w}x${h}.png`;
  let p = memo.get(file);
  if (!p) {
    p = (async () => {
      const dir = fixtureCacheDir();
      const cached = path.join(dir, file);
      try {
        return await fs.promises.readFile(cached);
      } catch {
        /* not cached yet */
      }
      const bytes = await renderQaImage(seed, w, h);
      await fs.promises.mkdir(dir, { recursive: true });
      const tmp = `${cached}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmp, bytes);
      await fs.promises.rename(tmp, cached).catch(() => fs.promises.rm(tmp, { force: true }));
      return bytes;
    })();
    memo.set(file, p);
  }
  return p;
};

/** The golden set: the 1856×2304 original and the server's 480w / 1080w variants. */
export const GOLDEN_IMAGES: Array<[string, number, number]> = [
  ['golden', 1856, 2304],
  ['golden', 480, 596],
  ['golden', 1080, 1341]
];

/** Playwright global setup: the QA build must exist; warm the fixture cache. */
export default async function globalSetup(): Promise<void> {
  if (!process.env.QA_BASE_URL) {
    const app = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
    const out = path.resolve(app, process.env.QA_OUT_DIR || 'dist-qa');
    if (!fs.existsSync(path.join(out, 'qa', 'comic-qa.html'))) {
      throw new Error(`The QA build is missing (${path.join(out, 'qa', 'comic-qa.html')}). Run \`npm run qa:build\` (QA_BUILD=1 vite build --outDir dist-qa) first, or use \`node scripts/layout-smoke.mjs\`.`);
    }
  }
  await fs.promises.mkdir(fixtureCacheDir(), { recursive: true });
  for (const [seed, w, h] of GOLDEN_IMAGES) {
    const bytes = await qaImageBytes(`${seed}-${w}x${h}.png`);
    const meta = await sharp(bytes!).metadata();
    if (meta.width !== w || meta.height !== h) throw new Error(`fixture image ${seed} rendered at ${meta.width}x${meta.height}, expected ${w}x${h}`);
  }
}
