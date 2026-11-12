// @vitest-environment node
// textures.ts is a re-export shim (master plan §2.6, PE-FX; collisions A-8): the seeds and the motion and atmosphere
// geometry moved to shared/comic/fx unchanged. These pin that the shim hands out the very same functions and that their
// output is byte-identical to the implementation before the move (goldens captured from the pre-shim textures.ts on
// 756b5a70), so the PresetThumb / procedural snapshots never move. Tones and paper stay here until PE-TONES (S3).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as atmosphere from '../../../../shared/comic/fx/atmosphere';
import * as lines from '../../../../shared/comic/fx/lines';
import * as seed from '../../../../shared/comic/fx/seed';
import * as textures from './textures';

const h = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

describe('library/procedural/textures.ts (re-export shim)', () => {
  it('re-exports the moved functions themselves, under their old names', () => {
    expect(textures.seedOf).toBe(seed.seedOf);
    expect(textures.rng).toBe(seed.rng);
    expect(textures.r2).toBe(seed.r2);
    expect(textures.speedLines).toBe(lines.speedLines);
    expect(textures.focusLines).toBe(lines.focusLines);
    expect(textures.bokeh).toBe(atmosphere.bokeh);
    expect(textures.rainPath).toBe(atmosphere.rainPath);
    // The module (the library barrel's `textures` namespace) still carries exactly the exports it had.
    expect(Object.keys(textures).sort()).toEqual(
      ['benDay', 'bokeh', 'crosshatch', 'focusLines', 'halftone', 'luminance', 'mix', 'paperGrain', 'r2', 'rainPath', 'rasterLines', 'risoGrain', 'rng', 'screentone', 'screentoneRadius', 'seamlessDirection', 'seedOf', 'speedLines'].sort()
    );
  });

  it('the moved geometry is byte-identical to the pre-shim implementation (frozen goldens)', () => {
    const { speedLines, focusLines, bokeh, rainPath, seedOf, rng, r2 } = textures;
    expect({
      speedLines: h([speedLines(1, 50, 50), speedLines('noir-ink', 10, 80, { count: 500, w: 160, h: 90, inner: 0.1 }), speedLines(-5, 0, 0, { count: 3 })]),
      focusLines: h([focusLines(1), focusLines('abc', { count: 3, w: 120 }), focusLines(99, { count: 200, h: 40, inner: 2 })]),
      bokeh: h([bokeh(1), bokeh('x', { count: 99, minR: 1, maxR: 30 }), bokeh(7, { w: 10, h: 300 })]),
      rainPath: h([rainPath(1), rainPath('storm', { count: 999, slant: 0.4 }), rainPath(3, { count: 0, len: 2 })]),
      seedOf: h([seedOf(1), seedOf('noir-ink'), seedOf(''), seedOf(-5)]),
      rng: h(
        [1, 7, 0, 123456789].map((s) => {
          const r = rng(s);
          return [r(), r(), r()];
        })
      ),
      r2: h([r2(1.005), r2(NaN), r2(-0.004), r2(12.3456)])
    }).toEqual({
      speedLines: '9417f4bc442777d1',
      focusLines: '46dc101278e8a148',
      bokeh: 'cacf4e4bdba27f74',
      rainPath: 'f04e3ac6293f93d8',
      seedOf: 'fb0f30b7a6c50235',
      rng: '952e0a72a8a93d2a',
      r2: 'a1b0da2782fbd139'
    });
  });

  it('keeps no second copy of the moved code (one implementation, in shared/comic/fx)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'textures.ts'), 'utf8');
    for (const name of ['seedOf', 'rng', 'r2', 'speedLines', 'focusLines', 'bokeh', 'rainPath']) {
      expect(src, name).not.toMatch(new RegExp(`(?:function|const)\\s+${name}\\b`));
    }
  });
});
