// PE-COMPOSE regression lock: a page without Pro or Ship 2 data renders and exports BYTE-IDENTICALLY.
//
// The golden (__fixtures__/legacyGolden.json) was recorded on the renderers before PE-COMPOSE (756b5a70): for every
// QA fixture (and its rtl edition) and the sample doc, each page's
//   - board DOM (ComicPageView as the board and the editor mount it) and reader DOM (paper, aria-hidden lettering),
//   - PNG / PDF raster: every call the canvas exporter makes (renderPageToBlob, the path the ZIP and the PDF share),
// and each book's print document (buildPrintHtml), hashed. Nothing PE-COMPOSE adds (frames, overlays, effects,
// stickers, blends, borders) may change a byte of any of them: such pages take exactly the old path.
//
// React's useId values depend on how many components mounted before (a process-wide counter), so ids are numbered by
// first appearance inside each page's markup before hashing; every other byte counts.
//
// Re-record (only on an intentional change of the legacy drawing): COMPOSE_GOLDEN_WRITE=1 npx vitest run <this file>.
// The S2b integration re-recorded it on the merged tree just before PE-COMPOSE (22084f2c), whose legacy DOM equals dev
// 99b870c4's: dev's S2a changes had moved the board and reader DOM of the 756b5a70 recording (raster and print did
// not move), and S2a added the chat-14 fixture.
//
// The print document's @font-face URLs are where Vite resolves each @fontsource file, which depends on where
// node_modules physically lives (a symlinked shared tree resolves through "/@fs/<its path>/node_modules/…", a real
// node_modules under the root as "/node_modules/…"), so they are hashed with that prefix made canonical: only the face,
// file and rules count. The S2b integration made this change at PE-FONTS (M9) and re-recorded the print hashes on the
// merged tree just before PE-FONTS; with the prefix canonical, PE-FONTS leaves every fixture's print document unchanged.

import React from 'react';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { hashString } from '../../../shared/comic/hash';
import { estimateMeasure } from '../../../shared/comic/lettering/layout';
import { ComicPageView } from '../board/ComicPageView';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { fakeContext, fakeLayers, fakePath, type FakeCtx } from '../export/__fixtures__/fakeCanvas';
import { buildPrintHtml, collectPrintSheets } from '../export/printView';
import { renderPageToBlob } from '../export/rasterize';
import { localizedFor } from '../export/sequence';
import { makeQaDoc, parseQaImagePath, QA_FIXTURES } from '../testing/qaFixtures';

const GOLDEN = join(__dirname, '__fixtures__', 'legacyGolden.json');
const WRITE = process.env.COMPOSE_GOLDEN_WRITE === '1';

/** Every doc the golden covers, by a stable name. */
export const legacyGoldenDocs = (): [string, ComicDoc][] => {
  const out: [string, ComicDoc][] = [];
  for (const name of QA_FIXTURES) {
    out.push([name, makeQaDoc(name)]);
    out.push([`${name}|rtl`, makeQaDoc(name, { rtl: true })]);
  }
  out.push(['sample', makeSampleDoc()]);
  return out;
};

/** useId-derived tokens (":r1f:", "lsr1f…") renumbered by first appearance, so only structure and values count. */
const stableIds = (html: string): string => {
  const seen = new Map<string, string>();
  return html.replace(/:r[0-9a-z]+:|\bls[a-z]?r[0-9a-z]+/g, (token) => {
    let id = seen.get(token);
    if (!id) {
      id = `ID${seen.size}`;
      seen.set(token, id);
    }
    return id;
  });
};

const domHash = (doc: ComicDoc, pageIndex: number, reader: boolean): string => {
  const page = doc.pages[pageIndex];
  const url = fakeUrlFor(page.render.asset);
  const { container } = render(
    reader ? (
      <ComicPageView doc={doc} page={page} imageUrl={url} loading="eager" develop={false} letteringAriaHidden paper style={{ width: '100%', height: '100%' }} />
    ) : (
      <ComicPageView doc={doc} page={page} imageUrl={url} />
    )
  );
  const html = stableIds(container.innerHTML);
  cleanup();
  return hashString(html);
};

/** A font file URL with its install-location prefix made canonical (see the header): "<origin>/node_modules/@fontsource/…". */
const stableFontUrls = (html: string): string =>
  html.replace(/url\("([a-z]+:\/\/[^/"]+)\/[^"]*?node_modules\/@fontsource\//g, 'url("$1/node_modules/@fontsource/');

/** Canvas contexts the exporter creates, in order (main page canvas and offscreen layers). */
let made: FakeCtx[] = [];
/** The art "loads" at its recorded pixel size (the QA path names it too: qa/<seed>-<w>x<h>.png). */
const sizes = new Map<string, { w: number; h: number }>();

const rasterHash = async (doc: ComicDoc, pageIndex: number): Promise<string | undefined> => {
  const page = doc.pages[pageIndex];
  const url = fakeUrlFor(page.render.asset);
  if (!url) return undefined;
  const asset = page.render.asset!;
  const qa = parseQaImagePath(asset.path);
  sizes.set(url, { w: asset.w ?? qa?.w ?? 1000, h: asset.h ?? qa?.h ?? 1500 });
  made = [];
  const layers = fakeLayers();
  await renderPageToBlob(doc, page, url, { measure: estimateMeasure, makePath: fakePath, createLayer: layers.createLayer, mime: 'image/jpeg', quality: 0.9 });
  return hashString(JSON.stringify({ main: made.map((f) => f.calls), layers: layers.made.map((f) => f.calls) }));
};

type PageHashes = { board: string; reader?: string; raster?: string };

const computeAll = async (): Promise<{ pages: Record<string, PageHashes>; print: Record<string, string> }> => {
  const pages: Record<string, PageHashes> = {};
  const print: Record<string, string> = {};
  for (const [name, doc] of legacyGoldenDocs()) {
    for (let i = 0; i < doc.pages.length; i += 1) {
      const entry: PageHashes = { board: domHash(doc, i, false) };
      if (!name.endsWith('|rtl')) entry.reader = domHash(doc, i, true);
      const raster = await rasterHash(doc, i);
      if (raster) entry.raster = raster;
      pages[`${name}|${doc.pages[i].id}`] = entry;
    }
    const book = localizedFor(doc);
    const { sheets, skipped } = collectPrintSheets(book, fakeUrlFor);
    print[name] = hashString(stableFontUrls(buildPrintHtml(book, sheets, { skipped, measure: estimateMeasure, origin: 'https://studio.test', urlFor: fakeUrlFor })));
  }
  return { pages, print };
};

describe('legacy pages render and export byte-identically (PE-COMPOSE golden over every QA fixture)', () => {
  beforeAll(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const f = fakeContext(this.width, this.height);
      made.push(f);
      return f.ctx as never;
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
      cb(new Blob([`${this.width}x${this.height}`], { type: type || 'image/png' }));
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => new Response(String(url), { status: 200, headers: { 'content-type': 'image/png' } }))
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (blob: Blob) => {
        const url = await blob.text();
        const size = sizes.get(url.replace(/[?&]cs_export=1$/, ''));
        if (!size) throw new Error(`golden: no recorded size for ${url}`);
        return { width: size.w, height: size.h, label: 'art', close: () => undefined };
      })
    );
  });
  afterAll(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('board and reader DOM, canvas raster calls and the print document equal the renderers before PE-COMPOSE', async () => {
    const now = await computeAll();
    // Only an explicit re-record writes: a missing golden is a failure, never a fresh self-fulfilling one.
    if (WRITE) {
      writeFileSync(
        GOLDEN,
        `${JSON.stringify(
          {
            note: 'The renderers before PE-COMPOSE (756b5a70): hashString of ComicPageView innerHTML (board props; reader props: paper, letteringAriaHidden, eager, develop off; useId tokens renumbered by first appearance), of JSON.stringify of every canvas call renderPageToBlob makes (JPEG, estimateMeasure, fakeCanvas), per page, and of buildPrintHtml per book. Every QA fixture and its rtl edition, and the sample doc.',
            ...now
          },
          null,
          1
        )}\n`
      );
    }
    expect(existsSync(GOLDEN), 'legacyGolden.json missing — re-record on the base renderers').toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { pages: Record<string, PageHashes>; print: Record<string, string> };
    expect(Object.keys(now.pages).sort()).toEqual(Object.keys(golden.pages).sort());
    const diff = Object.keys(now.pages).filter((k) => JSON.stringify(now.pages[k]) !== JSON.stringify(golden.pages[k]));
    expect(diff).toEqual([]);
    expect(now.print).toEqual(golden.print);
    // A golden that covers nothing proves nothing: every fixture but 'empty' has drawn pages with lettering.
    expect(Object.values(now.pages).filter((p) => p.raster).length).toBeGreaterThan(100);
  }, 240_000);
});
