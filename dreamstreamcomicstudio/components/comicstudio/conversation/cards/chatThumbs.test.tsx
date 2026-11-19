// PF-2 (perf F2): opening a chat shaped like production comic f8312c86 — 9 drawn pages, the cover and 4 character
// sheets reachable from its cards — must fetch ≤ 0.6 MB of images, every tile asking for the 480w variant.
// Before PF-2 every tile and avatar loaded the full original: 14 objects averaging ≈ 330 KB, ≈ 4.6 MB
// (perf.md F2, measured on production storage 2026-11-05). The byte table below uses those measured sizes
// (originals 215–468 KB; 480w variants ≈ 34 KB), and the jsdom DOM stands in for what the browser fetches:
// one request per <img> — its srcset candidate when it has one, else its src. The CDP version of this budget
// runs on the QA harness (tests/e2e/studio.chat.images.spec.ts; the `studio.` prefix is what DEVICE_SPECS runs).
// That spec opens the harness's heist-12p chat (10 images), not this 14-object shape: an f8312c86-shaped QA
// fixture belongs to the harness owner (PF-2 wave note). Until it lands, this file holds the 14-object half.
// Since quick2 Q-PROG a finished run in the chat is one line ("9 pages and the cover drawn · View") that mounts no
// picture, so the finished chat loads only the cast card's sheets; a run still drawing shows one strip of small
// thumbnails, which must be the same 480w variants.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { variantFor, type AssetRef, type Card, type ComicDoc, type Page } from '../../../../shared/comic/doc';
import { CardRenderer } from './CardRenderer';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from '../testing/fixtures';

const AT = 1_762_300_000_000;
const KB = 1000;
/** Bytes per stored object (path → size), filled as the fixture is built. */
const BYTES = new Map<string, number>();

/** A stored render as the server keeps it: the original plus 480w / 1080w WebP downscales narrower than it. */
const stored = (name: string, w: number, h: number, originalKb: number, thumbKb: number): AssetRef => {
  const path = `u/owner/p/f8312c86/${name}.png`;
  BYTES.set(path, originalKb * KB);
  const variants = [480, 1080]
    .filter((vw) => vw < w)
    .map((vw) => {
      const v = { path: `u/owner/p/f8312c86/${name}_w${vw}.webp`, w: vw, h: Math.round((h * vw) / w) };
      BYTES.set(v.path, (vw === 480 ? thumbKb : 90) * KB);
      return v;
    });
  return { path, w, h, source: 'generated', at: AT, variants };
};

const PAGE_SIZES: Array<[number, number, number, number]> = [
  // w, h, original KB, 480w KB
  [1647, 2082, 468, 38],
  [1536, 2048, 412, 36],
  [1536, 2048, 390, 35],
  [1408, 1792, 350, 34],
  [1408, 1792, 330, 34],
  [1344, 1600, 300, 33],
  [1344, 1600, 280, 33],
  [1270, 1307, 250, 31],
  [1270, 1307, 215, 30]
];

const f8312c86 = (): ComicDoc => {
  const base = makeSampleDoc();
  const template = base.pages[0];
  const pages: Page[] = PAGE_SIZES.map(([w, h, kb, tkb], i) => ({
    ...template,
    id: `pg_${i + 1}`,
    n: i + 1,
    render: { status: 'ready', history: [], asset: stored(`page-${i + 1}`, w, h, kb, tkb), updatedAt: AT }
  }));
  const names = ['Maya', 'Arjun', 'Vendor', 'Crow'];
  const cast = names.map((name, i) => ({
    ...base.cast[0],
    id: `c_${name.toLowerCase()}`,
    name,
    tier: i === 0 ? ('lead' as const) : ('support' as const),
    sheet: { status: 'ready' as const, history: [], asset: stored(`sheet-${name.toLowerCase()}`, 1536, 1024, 320, 33), updatedAt: AT }
  }));
  return {
    ...base,
    style: { ...base.style, status: 'locked', options: [] },
    cast,
    pages,
    cover: { ...base.cover, render: { status: 'ready', history: [], asset: stored('cover', 1536, 2048, 330, 34), updatedAt: AT } }
  };
};

/** The cards of the chat that reach those images. */
const chatCards = (doc: ComicDoc): Card[] => [
  { type: 'cast', id: 'cast1', characterIds: doc.cast.map((c) => c.id) },
  { type: 'renders', id: 'r_sheets', label: 'Character sheets', targets: doc.cast.map((c) => ({ kind: 'sheet' as const, id: c.id })) },
  { type: 'renders', id: 'r_pages', label: 'Pages and cover', targets: [...doc.pages.map((p) => ({ kind: 'page' as const, id: p.id })), { kind: 'cover' as const }] },
  { type: 'recap', id: 'recap1' }
];

/** The production signer's rule (useStudio.urlFor): a width picks the smallest stored variant ≥ width × min(dpr, 2). */
const signedUrl = (path: string) => `https://cdn.test/${path}`;
const urlFor = (asset?: AssetRef | string | null, opts?: { width?: number }) => {
  if (!asset) return undefined;
  if (typeof asset === 'string') return signedUrl(asset);
  return signedUrl(opts?.width ? variantFor(asset, opts.width, window.devicePixelRatio || 1).path : asset.path);
};
const pathOf = (url: string) => url.replace('https://cdn.test/', '');

/** What the browser would fetch for each <img>: its (single) srcset candidate, else its src. */
const fetched = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('img')].map((img) => {
    const srcset = img.getAttribute('srcset');
    return pathOf(srcset ? srcset.trim().split(/\s+/)[0] : img.getAttribute('src') || '');
  });

/** The same chat while the run is still drawing its last image (the cover): the pages strip is on screen. */
const midRun = (): ComicDoc => {
  const doc = f8312c86();
  return { ...doc, cover: { ...doc.cover, render: { ...doc.cover.render, status: 'rendering', updatedAt: AT } } };
};

const openChat = (doc: ComicDoc = f8312c86()) => {
  const studio = makeFakeStudio({ doc, urlFor });
  return render(
    <div role="log">
      {chatCards(doc).map((card) => (
        <CardRenderer key={card.id} card={card} studio={studio} />
      ))}
    </div>
  );
};

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

describe.each([1, 2, 3])('the f8312c86-shaped chat at device pixel ratio %i', (dpr) => {
  beforeEach(() => {
    Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
  });

  const allSmall = (container: HTMLElement) => {
    const paths = fetched(container);
    expect(paths.filter((p) => !/_w480\.webp$/.test(p))).toEqual([]);
    expect(container.querySelectorAll('[data-heavy-img]')).toHaveLength(0);
    for (const img of container.querySelectorAll('img')) {
      expect(img).toHaveAttribute('loading', 'lazy');
      expect(img).toHaveAttribute('decoding', 'async');
    }
    return paths;
  };
  const bytesOf = (paths: string[]) => paths.reduce((sum, p) => sum + (BYTES.get(p) ?? Number.POSITIVE_INFINITY), 0);

  it('every tile and avatar requests the 480w variant, lazily, never an original', () => {
    // Finished: the runs are one line each (no picture); the cast card shows its 4 sheets (tiles and avatars).
    const done = openChat();
    expect(done.container.querySelectorAll('[data-renders-done]')).toHaveLength(2);
    expect(allSmall(done.container).length).toBeGreaterThanOrEqual(4);
    done.unmount();
    // Mid-run: the pages strip fills in with the 9 drawn pages, the cover still drawing.
    const live = openChat(midRun());
    expect(allSmall(live.container).length).toBeGreaterThanOrEqual(13);
  });

  it('loads ≤ 0.6 MB of images (was ≈ 4.6 MB of originals)', () => {
    const done = openChat();
    const doneUnique = [...new Set(fetched(done.container))];
    expect(doneUnique).toHaveLength(4);
    expect(bytesOf(doneUnique)).toBeLessThanOrEqual(0.6 * 1000 * KB);
    done.unmount();

    const live = openChat(midRun());
    const unique = [...new Set(fetched(live.container))];
    expect(unique).toHaveLength(13); // 9 pages + 4 sheets; the cover is still drawing
    expect(bytesOf(unique)).toBeLessThanOrEqual(0.6 * 1000 * KB);
    const originals = [...BYTES.entries()].filter(([p]) => p.endsWith('.png')).reduce((s, [, b]) => s + b, 0);
    expect(originals).toBeGreaterThan(4.5 * 1000 * KB); // the fixture really is the heavy production shape
  });
});
