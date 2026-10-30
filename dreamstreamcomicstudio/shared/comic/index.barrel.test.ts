// The shared/comic barrel (index.ts) re-exports Ship 2's parts.ts and panelize/space.ts, and no export name is owned by
// two of its modules. The compile is the first proof: `npm run typecheck` checks this file and index.ts, and a name
// exported by two `export *` modules is a TS2308 error there. The runtime checks below prove the values reach the
// barrel unchanged and that no two barrel modules share a runtime export name (an ambiguous `export *` name is
// silently dropped from an ES module namespace).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as comic from './index';
import * as parts from './parts';
import * as space from './panelize/space';
import * as continuity from './continuity';
import * as directions from './directions';
import * as anchors from './anchors';
import * as editor from './editor/index';

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

// Ship 2 follow-ups (B4/B9 wave notes): continuity.ts, directions.ts and anchors.ts join the barrel as `export *`, and the
// editor engine joins it as one namespace (`comic.editor`). The compile (TS2308 on a type or value name owned by two
// `export *` modules) is the first proof; the checks below are the runtime half.
describe('shared/comic barrel — B4 modules and the B9 editor namespace', () => {
  it('lists continuity, directions and anchors, and the editor as a namespace', () => {
    expect(barrelModules()).toEqual(expect.arrayContaining(['./continuity', './directions', './anchors']));
    expect(readFileSync(join(here, 'index.ts'), 'utf8')).toMatch(/^export \* as editor from '\.\/editor\/index\.js';$/m);
  });

  it('re-exports every runtime export of continuity.ts, directions.ts and anchors.ts, identical', () => {
    const barrel = comic as unknown as Record<string, unknown>;
    for (const mod of [continuity, directions, anchors] as Record<string, unknown>[]) {
      const names = Object.keys(mod);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(barrel[name], name).toBe(mod[name]);
    }
    // The names the B4 FIX note lists as new, by hand (an ambiguous `export *` would silently drop one of them).
    expect(comic.povViewerOf).toBe(directions.povViewerOf);
    expect(comic.drawnCastIds).toBe(directions.drawnCastIds);
    expect(comic.offPanelSpeakerIds).toBe(directions.offPanelSpeakerIds);
    expect(comic.ANCHOR_PLAN_KINDS).toBe(anchors.ANCHOR_PLAN_KINDS);
    expect(comic.plansWithAnchors).toBe(anchors.plansWithAnchors);
    expect(comic.CONTINUITY_STALE_TEXT).toBe(anchors.CONTINUITY_STALE_TEXT);
    expect(comic.resolveContinuity).toBe(continuity.resolveContinuity);
    expect(comic.planAnchors).toBe(anchors.planAnchors);
  });

  it('exposes the editor engine as comic.editor: every runtime export, the same binding', () => {
    const ns = comic.editor as unknown as Record<string, unknown>;
    const names = Object.keys(editor);
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) expect(ns[name], name).toBe((editor as Record<string, unknown>)[name]);
    expect(Object.keys(ns).sort()).toEqual([...names].sort());
    expect(comic.editor.applyTemplateEdit).toBe(editor.applyTemplateEdit);
    expect(comic.editor.PAGE_TEMPLATES).toBe(editor.PAGE_TEMPLATES);
    // A namespace, not a flat re-export: the editor's own helpers do not appear as top-level barrel names.
    const flat = comic as unknown as Record<string, unknown>;
    expect('applyTemplateEdit' in flat).toBe(false);
    expect('PAGE_TEMPLATES' in flat).toBe(false);
  });

  it('no barrel module exports a runtime name "editor" (the namespace would shadow it)', async () => {
    for (const path of barrelModules()) {
      const mod = (await import(/* @vite-ignore */ `${path}.ts`)) as Record<string, unknown>;
      expect(Object.keys(mod), path).not.toContain('editor');
    }
  });

  it('re-exports their types unchanged', () => {
    expectTypeOf<comic.AnchorKinds>().toEqualTypeOf<anchors.AnchorKinds>();
    expectTypeOf<comic.AnchorPlan>().toEqualTypeOf<anchors.AnchorPlan>();
    expectTypeOf<comic.DrawnPanel>().toEqualTypeOf<directions.DrawnPanel>();
    expectTypeOf<comic.ContinuityState>().toEqualTypeOf<continuity.ContinuityState>();
    expectTypeOf<comic.editor.EditResult>().toEqualTypeOf<editor.EditResult>();
    expectTypeOf<typeof comic.planAnchors>().toEqualTypeOf<typeof anchors.planAnchors>();
  });
});

// prompts.ts (server) keeps its own povViewerOf, drawnCastIds and offPanelSpeakerIds until B5 re-exports the shared
// ones. Two `export *` of different bindings with one name drop the name from the re-exporting module, silently. This
// walks every `export * from` chain in the app (shared, server, client) and proves no module re-exports both.
describe('export * chains', () => {
  const appRoot = resolve(here, '..', '..');
  const roots = ['shared', 'server/src', 'components', 'qa', 'lib', 'hooks', 'contexts', 'services'].map((r) => join(appRoot, r)).filter(existsSync);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) files.push(p);
    }
  };
  for (const r of roots) walk(r);
  const resolveSpec = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null;
    const base = resolve(dirname(from), spec).replace(/\.js$/, '');
    for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) if (existsSync(c)) return c;
    return null;
  };
  /** module → the modules it flattens into its own exports (`export * from`, not `export * as`). */
  const edges = new Map<string, string[]>();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const targets = [...src.matchAll(/^export \* from '([^']+)';/gm)].map((m) => resolveSpec(f, m[1])).filter((x): x is string => !!x);
    if (targets.length) edges.set(f, targets);
  }
  const closure = (f: string, seen = new Set<string>()): Set<string> => {
    for (const t of edges.get(f) ?? []) if (!seen.has(t)) { seen.add(t); closure(t, seen); }
    return seen;
  };
  const rel = (p: string) => relative(appRoot, p);

  it('finds the barrel chain (the scan works)', () => {
    expect([...closure(join(here, 'index.ts'))].map(rel)).toEqual(expect.arrayContaining(['shared/comic/directions.ts', 'shared/comic/anchors.ts', 'shared/comic/continuity.ts']));
  });

  it('no module flattens both shared/comic/directions.ts and server/src/comic/prompts.ts', () => {
    const shared = join(appRoot, 'shared/comic/directions.ts');
    const prompts = join(appRoot, 'server/src/comic/prompts.ts');
    const both = [...edges.keys()].filter((f) => {
      const c = closure(f);
      return (c.has(shared) || f === shared) && (c.has(prompts) || f === prompts);
    });
    expect(both.map(rel)).toEqual([]);
  });
});
