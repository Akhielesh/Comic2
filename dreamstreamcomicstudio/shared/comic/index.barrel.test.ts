// The shared/comic barrel (index.ts) re-exports Ship 2's parts.ts and panelize/space.ts, and no export name is owned by
// two of its modules. The compile is the first proof: `npm run typecheck` checks this file and index.ts, and a name
// exported by two `export *` modules is a TS2308 error there. The runtime checks below prove the values reach the
// barrel unchanged and that no two barrel modules share a runtime export name (an ambiguous `export *` name is
// silently dropped from an ES module namespace).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as comic from './index';
import * as parts from './parts';
import * as space from './panelize/space';

const here = dirname(fileURLToPath(import.meta.url));
/** Every module index.ts re-exports, in order (`export * from './x.js'` → './x'). */
const barrelModules = (): string[] =>
  [...readFileSync(join(here, 'index.ts'), 'utf8').matchAll(/^export \* from '(\.\/[^']+)\.js';$/gm)].map((m) => m[1]);

describe('shared/comic barrel', () => {
  it('lists parts and panelize/space', () => {
    expect(barrelModules()).toEqual(expect.arrayContaining(['./parts', './panelize/space']));
  });

  it('re-exports every runtime export of parts.ts and panelize/space.ts, identical', () => {
    const barrel = comic as unknown as Record<string, unknown>;
    for (const mod of [parts, space] as Record<string, unknown>[]) {
      const names = Object.keys(mod);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(barrel[name], name).toBe(mod[name]);
    }
    expect(comic.partsOf).toBe(parts.partsOf);
    expect(comic.frameAffine).toBe(space.frameAffine);
    expect(comic.pageSourcePaths).toBeTypeOf('function'); // doc.ts helpers the K2a notes rely on stay reachable
    expect(comic.dropPanelSourcePaths).toBeTypeOf('function');
    expect(comic.mapPanelSourcePaths).toBeTypeOf('function');
  });

  it('re-exports their types unchanged', () => {
    expectTypeOf<comic.FrameAffine>().toEqualTypeOf<space.FrameAffine>();
    expectTypeOf<comic.ImageRegion>().toEqualTypeOf<space.ImageRegion>();
    expectTypeOf<comic.PointMap>().toEqualTypeOf<space.PointMap>();
    expectTypeOf<comic.ComposePageShape>().toEqualTypeOf<space.ComposePageShape>();
    expectTypeOf<typeof comic.partsOf>().toEqualTypeOf<typeof parts.partsOf>();
  });

  it('no runtime export name is owned by two barrel modules', async () => {
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    for (const path of barrelModules()) {
      const mod = (await import(/* @vite-ignore */ `${path}.ts`)) as Record<string, unknown>;
      for (const name of Object.keys(mod)) {
        const first = owner.get(name);
        // The same binding re-exported by two modules is not a clash (ES modules resolve it to one value).
        if (first && first !== path) {
          const firstMod = (await import(/* @vite-ignore */ `${first}.ts`)) as Record<string, unknown>;
          if (firstMod[name] !== mod[name]) clashes.push(`${name}: ${first} and ${path}`);
        } else owner.set(name, path);
      }
    }
    expect(clashes).toEqual([]);
  });
});
