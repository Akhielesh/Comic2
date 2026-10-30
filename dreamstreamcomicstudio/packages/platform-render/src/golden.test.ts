// @vitest-environment jsdom
//
// Goldens (plan §12 W1.7): three DOCX and two PPTX files rendered from fixed fixtures, compared as normalised XML
// (render.testkit.ts `goldenOf`: every part name, the content-bearing XML one tag per line, media by sha256).
//
// They fail on ANY change to what the renderers write. When a change is intended (a renderer change, or the
// W1.2/W1.3 merge wiring BrandKit and overlapCheck in), regenerate them on purpose and review the diff:
//   UPDATE_GOLDENS=1 npx vitest run packages/platform-render/src/golden.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DeckSpec } from '../../platform-core/src/contract/deck.js';
import type { RichDoc } from '../../platform-core/src/contract/richdoc.js';
import { renderDocx } from './docx.js';
import { renderPptx } from './pptx.js';
import { BRAND, FAMILIES, IMAGES, contractFixture, fakeTranscode, goldenOf, renderFixture, renderFixturePath } from './render.testkit.js';

const UPDATE = process.env.UPDATE_GOLDENS === '1';

/** The host's asset lookup for the fixtures' asset ids; anything else is unknown. */
const assets = (id: string): string | null =>
  ({ 'user-0001/assets/cover-v2.png': IMAGES.png, 'user-0001/assets/p2-thumb.webp': IMAGES.webp, 'brand/logo.webp': IMAGES.webp } as { [id: string]: string })[id] ?? null;

const CASES: { name: string; title: string; make: () => Promise<Uint8Array> }[] = [
  {
    name: 'docx-minimal',
    title: 'DOCX: contract richdoc/minimal.json, default brand',
    make: () => renderDocx(contractFixture<RichDoc>('richdoc/minimal.json')),
  },
  {
    name: 'docx-full',
    title: 'DOCX: contract richdoc/full.json (every block type), default brand, letter',
    make: () => renderDocx(contractFixture<RichDoc>('richdoc/full.json'), { resolveAsset: assets }),
  },
  {
    name: 'docx-script',
    title: 'DOCX: render richdoc/script.json (comic script, page and continuous breaks, Telugu), brand.json, A4, WebP transcoded',
    make: () => renderDocx(renderFixture<RichDoc>('richdoc/script.json'), { brand: BRAND, fontFamily: FAMILIES, pageSize: 'a4', resolveAsset: assets, transcode: fakeTranscode }),
  },
  {
    name: 'pptx-full',
    title: 'PPTX: contract deck/full.json (every element kind and layout), default brand, WebP logo transcoded',
    make: () => renderPptx(contractFixture<DeckSpec>('deck/full.json'), { resolveAsset: assets, transcode: fakeTranscode }),
  },
  {
    name: 'pptx-dark-4x3',
    title: 'PPTX: render deck/dark-4x3.json (4:3, dark preset, contain/cover images, bullets, soft breaks, notes), brand.json fonts',
    make: () => renderPptx(renderFixture<DeckSpec>('deck/dark-4x3.json'), { brand: BRAND, fontFamily: FAMILIES }),
  },
];

describe('renderer goldens (normalised XML)', () => {
  for (const c of CASES) {
    it(`${c.name} matches its golden`, async () => {
      const golden = await goldenOf(await c.make(), c.title);
      const file = renderFixturePath(`golden/${c.name}.txt`);
      if (UPDATE) {
        writeFileSync(file, golden);
        return;
      }
      expect(existsSync(file), `${file} is missing: run with UPDATE_GOLDENS=1 once`).toBe(true);
      expect(golden).toBe(readFileSync(file, 'utf8'));
    }, 30_000);
  }

  it('a golden is stable: rendering twice in one process gives the same text', async () => {
    const a = await goldenOf(await CASES[3].make(), 'x');
    const b = await goldenOf(await CASES[3].make(), 'x');
    expect(b).toBe(a);
  }, 30_000);
});
