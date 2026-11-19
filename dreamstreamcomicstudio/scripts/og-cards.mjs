#!/usr/bin/env node
// The comics host's link-preview pictures (Open Graph / Twitter cards), made reproducibly:
// each card is a small HTML page in the Atlas ink look, rendered by the local Chromium and saved
// as a 1200×630 PNG into public/icons/:
//
//   comics-og.png           the home card (comics.dreamstreamstudio.ai/ and every page without its own)
//   comics-library-og.png   the Library card (/?view=gallery, where /library redirects)
//
//   node scripts/og-cards.mjs [--out <dir>] [--only home,library]
//
// The art is the product's own sample comic (public/assets/comic-sample: "The Paper Boat" cover and
// "The Last Tram" pages, the same files the landing's sample reader shows), never a user's comic.
// Type is the Atlas chrome pair (IBM Plex Sans, Space Grotesk, public/fonts, OFL) and the mark is
// components/comicshost/ComicsMark.tsx drawn in ink. Fonts and pictures are inlined as data URLs,
// so the page needs no server and no network; everything else is blocked.
//
// Each PNG is palette-quantised to stay under MAX_BYTES (link-preview services fetch it on a cold
// cache). The script prints each file's short content hash: put it in comics-edge/src/brand.ts
// OG_IMAGE_REV (the edge test fails until it matches), so the preview URL changes with the picture.
//
// Chromium: QA_CHROMIUM_PATH, else Playwright's own (never downloads). Node >= 20.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const W = 1200;
export const H = 630;
/** Ceiling for each card file (bytes). */
export const MAX_BYTES = 200 * 1024;

/** Atlas ink (index.css [data-ds-skin="atlas"], light): the only colours the chrome may use. */
export const INK = {
  paper: '#ffffff',
  well: '#f4f4f4',
  ink: '#0a0a0a',
  muted: '#5c5c5c',
  hairline: 'rgba(0,0,0,0.10)'
};

const SAMPLE = 'public/assets/comic-sample';
export const CARDS = {
  home: {
    file: 'comics-og.png',
    overline: 'DreamStream',
    title: 'Comic Studio',
    lead: 'Make your story a comic.',
    body: 'Plan every page with an AI director, keep your cast consistent, letter each balloon, then read and share.',
    footer: 'comics.dreamstreamstudio.ai',
    layout: 'stack',
    art: [`${SAMPLE}/paper-boat-cover.webp`, `${SAMPLE}/last-tram-page-1-1200.webp`]
  },
  library: {
    file: 'comics-library-og.png',
    overline: 'Comic Studio',
    title: 'Library',
    lead: 'Comics made with Comic Studio.',
    body: 'Read them in your browser, on any screen.',
    footer: 'comics.dreamstreamstudio.ai/library',
    layout: 'shelf',
    // The Library's own "Studio samples" row (components/PublicGallery.tsx SAMPLES): image, title, line.
    shelf: [
      { art: `${SAMPLE}/paper-boat-cover.webp`, title: 'The Paper Boat', meta: 'An everyday adventure · 2 pages', position: 'center' },
      { art: `${SAMPLE}/last-tram-page-1-1200.webp`, title: 'The Last Tram', meta: 'A city story · 2 pages', position: '18% 50%' }
    ]
  }
};

const FONTS = [
  ['IBM Plex Sans', 400, 'ibm-plex-sans-latin-400-normal.woff2'],
  ['IBM Plex Sans', 500, 'ibm-plex-sans-latin-500-normal.woff2'],
  ['Space Grotesk', 600, 'space-grotesk-latin-600-normal.woff2'],
  ['Space Grotesk', 700, 'space-grotesk-latin-700-normal.woff2']
];

const dataUrl = (rel, type) => `data:${type};base64,${fs.readFileSync(path.join(APP, rel)).toString('base64')}`;

/** ComicsMark (viewBox 48) in ink on paper: the ink tile, the turning page cut out in paper. */
export const markSvg = (size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true">` +
  `<rect x="2" y="2" width="44" height="44" rx="12" fill="${INK.ink}"/>` +
  `<path d="M15 13h18l4 4v20H15z" fill="none" stroke="${INK.paper}" stroke-width="2" stroke-linejoin="round" opacity=".55"/>` +
  `<path d="M11 10h17l6 6v19H11z" fill="${INK.paper}"/>` +
  `<path d="M27 10v7h7M15 20h15v11H15zM15 25h15M22 25v6" fill="none" stroke="${INK.ink}" stroke-width="1.8" stroke-linejoin="round"/>` +
  `</svg>`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The art column: "stack" = a cover in front of two open pages; "shelf" = a row of comics. */
const artHtml = (card, img) => {
  if (card.layout === 'stack') {
    const [cover, page] = card.art.map((a) => img(a));
    return `<div class="art stack">
      <img class="page" src="${page}" alt="">
      <img class="cover" src="${cover}" alt="">
    </div>`;
  }
  return `<div class="art shelf">${card.shelf
    .map(
      (item) => `<figure class="item"><img src="${img(item.art)}" alt="" style="object-position:${item.position}">
      <figcaption><strong>${esc(item.title)}</strong><span>${esc(item.meta)}</span></figcaption></figure>`
    )
    .join('')}</div>`;
};

/** The card's whole HTML document (self-contained: data URLs only). */
export const cardHtml = (card, { inline = true } = {}) => {
  const img = (rel) => (inline ? dataUrl(rel, 'image/webp') : `/${rel.replace(/^public\//, '')}`);
  const faces = FONTS.map(
    ([family, weight, file]) =>
      `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:block;src:url(${inline ? dataUrl(`public/fonts/${file}`, 'font/woff2') : `/fonts/${file}`}) format('woff2')}`
  ).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(card.title)}</title><style>
${faces}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:${INK.paper}}
body{font-family:'IBM Plex Sans',sans-serif;color:${INK.ink};-webkit-font-smoothing:antialiased;position:relative}
.text{position:absolute;left:72px;top:64px;bottom:56px;width:500px;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:14px}
.overline{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:20px;letter-spacing:.08em;text-transform:uppercase;color:${INK.muted}}
h1{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:84px;line-height:1;letter-spacing:-.025em;margin-top:44px}
.lead{font-weight:500;font-size:32px;line-height:1.25;margin-top:22px}
.body{font-weight:400;font-size:22px;line-height:1.45;color:${INK.muted};margin-top:16px;max-width:460px}
.footer{margin-top:auto;font-weight:500;font-size:20px;color:${INK.muted};display:flex;align-items:center;gap:10px}
.footer::before{content:'';display:block;width:28px;height:2px;background:${INK.ink}}
.art{position:absolute;top:0;right:0;bottom:0;left:600px;background:${INK.well};border-left:1px solid ${INK.hairline}}
.art img{position:absolute;display:block;object-fit:cover;border-radius:12px;border:1px solid ${INK.hairline};
  box-shadow:0 20px 25px -5px rgb(0 0 0 / .14),0 8px 10px -6px rgb(0 0 0 / .12)}
.stack .page{width:420px;height:336px;left:40px;top:64px}
.stack .cover{width:280px;height:420px;right:40px;top:150px}
.shelf{display:flex;gap:24px;align-items:center;justify-content:center}
.shelf .item{width:248px;background:${INK.paper};border:1px solid ${INK.hairline};border-radius:12px;overflow:hidden;
  box-shadow:0 10px 15px -3px rgb(0 0 0 / .1),0 4px 6px -4px rgb(0 0 0 / .1)}
.shelf .item img{position:static;width:248px;height:340px;border:0;border-radius:0;box-shadow:none;border-bottom:1px solid ${INK.hairline}}
.shelf figcaption{padding:14px 16px 16px;display:flex;flex-direction:column;gap:4px}
.shelf figcaption strong{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:21px;line-height:1.2}
.shelf figcaption span{font-size:14px;color:${INK.muted};white-space:nowrap}
</style></head><body>
<div class="text">
  <div class="brand">${markSvg(56)}<span class="overline">${esc(card.overline)}</span></div>
  <h1>${esc(card.title)}</h1>
  <p class="lead">${esc(card.lead)}</p>
  <p class="body">${esc(card.body)}</p>
  <p class="footer">${esc(card.footer)}</p>
</div>
${artHtml(card, img)}
</body></html>`;
};

/** Short content hash of a card file (comics-edge/src/brand.ts OG_IMAGE_REV). */
export const shortHash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);

const chromiumPath = () => {
  if (process.env.QA_CHROMIUM_PATH) return process.env.QA_CHROMIUM_PATH;
  const fallback = '/opt/pw-browsers/chromium';
  return fs.existsSync(fallback) ? fallback : undefined;
};

/** Smallest palette PNG under MAX_BYTES (more colours first; the art keeps its gradients). */
async function compress(sharp, png) {
  let last = png;
  for (const colors of [256, 192, 160, 128]) {
    last = await sharp(png).png({ palette: true, colors, dither: 0.9, effort: 10, compressionLevel: 9 }).toBuffer();
    if (last.byteLength <= MAX_BYTES) return last;
  }
  return last;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const out = path.resolve(APP, opt('--out', 'public/icons'));
  const only = opt('--only', Object.keys(CARDS).join(',')).split(',');
  for (const id of only) if (!CARDS[id]) throw new Error(`unknown card "${id}" (known: ${Object.keys(CARDS).join(', ')})`);

  const { default: sharp } = await import('sharp');
  const pw = await import('playwright').catch(() => import('@playwright/test'));
  const executablePath = chromiumPath();
  const browser = await pw.chromium.launch(executablePath ? { executablePath } : {});
  try {
    const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'light' });
    // Nothing leaves the page: every resource is a data URL.
    await context.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    fs.mkdirSync(out, { recursive: true });
    for (const id of only) {
      const card = CARDS[id];
      await page.setContent(cardHtml(card), { waitUntil: 'load' });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((i) => i.decode()));
      });
      const missing = await page.evaluate(() => [...document.fonts].filter((f) => f.status !== 'loaded').map((f) => `${f.family} ${f.weight}`));
      const used = await page.evaluate(() => ['IBM Plex Sans', 'Space Grotesk'].filter((f) => !document.fonts.check(`16px "${f}"`)));
      if (used.length) throw new Error(`fonts not ready: ${used.join(', ')}`);
      const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
      const png = await compress(sharp, shot);
      const meta = await sharp(png).metadata();
      if (meta.width !== W || meta.height !== H) throw new Error(`${card.file}: ${meta.width}x${meta.height}, expected ${W}x${H}`);
      if (png.byteLength > MAX_BYTES) throw new Error(`${card.file}: ${png.byteLength} bytes, over ${MAX_BYTES}`);
      fs.writeFileSync(path.join(out, card.file), png);
      const unused = missing.length ? ` (unused faces: ${missing.join(', ')})` : '';
      console.log(`${path.relative(APP, path.join(out, card.file))}  ${W}x${H}  ${png.byteLength} bytes  OG_IMAGE_REV.${id} = '${shortHash(png)}'${unused}`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
