// @vitest-environment node
//
// The motion engine is Pro code (master plan §2.8: "Pro chunk ... presets ... lazy, never in the reader's first load").
// History names animations ("changed the animation on page 2", "Zoom punch"), and History ships with the reader, so a
// label must never pull the preset tables, the curves or the easing in with it. Two guards, the motion twin of PE-0's
// fx rule (History imports fx/names.ts, never the registry):
//   - a bundle of a label taken through the barrel, and of History's describe.ts as it stands, holds no byte of the
//     engine modules (esbuild with tree shaking, as the production build shakes: the engine's tables are marked pure);
//   - the source scan: words.ts and types.ts are leaves, and History and the editor scene import the motion folder
//     only for what those leaves export, never an engine module.
// tests/config/platformChunks.test.ts reads the real production build (wave note: its ComicReaderView and main chunks
// must hold no preset curve code either).

import { build } from 'esbuild';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const comic = join(here, '..');
const ENGINE = ['beats', 'easing', 'presets', 'sample', 'reduced', 'budget'];
/** Strings only the engine's curves hold (Penner's bounce constant, the seeded hash's multiplier as minified). */
const ENGINE_MARKERS = ['7.5625', '2654435761'];

/** Bytes each engine module puts into a tree-shaken bundle of `contents` (resolved from `dir`). */
const engineBytes = async (contents: string, dir: string): Promise<{ bytes: Record<string, number>; code: string }> => {
  const result = await build({
    stdin: { contents, resolveDir: dir, loader: 'ts' },
    bundle: true,
    minify: true,
    treeShaking: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    metafile: true,
    logLevel: 'silent'
  });
  const output = Object.values(result.metafile!.outputs)[0];
  const bytes: Record<string, number> = {};
  for (const [file, info] of Object.entries(output.inputs)) {
    const m = file.replace(/\\/g, '/').match(/shared\/comic\/motion\/([a-z]+)\.ts$/);
    if (m && ENGINE.includes(m[1])) bytes[m[1]] = (bytes[m[1]] ?? 0) + info.bytesInOutput;
  }
  return { bytes, code: result.outputFiles![0].text };
};

const noEngine = (bytes: Record<string, number>) => Object.fromEntries(ENGINE.map((m) => [m, bytes[m] ?? 0]));
const zero = Object.fromEntries(ENGINE.map((m) => [m, 0]));

/** Code only: comments may name what the code never imports. */
const codeOf = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const importsOf = (src: string): { clause: string; spec: string }[] =>
  [...codeOf(src).matchAll(/^\s*(?:import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)].map((m) => ({ clause: m[1], spec: m[2] }));
const exportedNames = (file: string): Set<string> =>
  new Set([...codeOf(readFileSync(join(here, file), 'utf8')).matchAll(/export\s+(?:declare\s+)?(?:const|let|function|type|interface|enum|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));

const sourcesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__fixtures__' ? [] : sourcesUnder(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });

describe('the motion engine never ships with a label', () => {
  it('a label taken through the barrel bundles no byte of the engine', async () => {
    const { bytes, code } = await engineBytes(`export { motionPresetWord } from './index.ts';`, here);
    expect(noEngine(bytes)).toEqual(zero);
    for (const marker of ENGINE_MARKERS) expect(code.includes(marker), marker).toBe(false);
    // The control: taking an engine function does bundle the engine, so the measure is real.
    const control = await engineBytes(`export { sampleAt } from './index.ts';`, here);
    expect(control.bytes.presets).toBeGreaterThan(1000);
    expect(control.bytes.sample).toBeGreaterThan(1000);
    expect(ENGINE_MARKERS.every((m) => control.code.includes(m))).toBe(true);
  });

  it('History (describe.ts, as it imports today) bundles no byte of the engine', async () => {
    const { bytes, code } = await engineBytes(`export * from './history/describe.ts';`, comic);
    expect(noEngine(bytes)).toEqual(zero);
    for (const marker of ENGINE_MARKERS) expect(code.includes(marker), marker).toBe(false);
  });

  it('words.ts and types.ts are leaves: types.ts imports nothing, words.ts only types', () => {
    expect(importsOf(readFileSync(join(here, 'types.ts'), 'utf8'))).toEqual([]);
    const words = importsOf(readFileSync(join(here, 'words.ts'), 'utf8'));
    expect(words.length).toBeGreaterThan(0);
    for (const { clause, spec } of words) {
      expect(clause, spec).toMatch(/^type\s/);
      expect(spec).toBe('./types.js');
    }
  });

  it('History and the editor scene import the motion folder only for what words.ts and types.ts export', () => {
    const leaf = new Set([...exportedNames('words.ts'), ...exportedNames('types.ts')]);
    expect(leaf.has('motionPresetWord')).toBe(true);
    expect(leaf.has('MotionTarget')).toBe(true);
    const files = [...sourcesUnder(join(comic, 'history')), join(comic, 'editor', 'scene.ts')];
    expect(files.length).toBeGreaterThan(5);
    let motionImports = 0;
    for (const file of files) {
      const name = relative(comic, file);
      for (const { clause, spec } of importsOf(readFileSync(file, 'utf8'))) {
        const m = spec.match(/(?:^|\/)motion\/([a-z]+)(?:\.js)?$/);
        if (!m) continue;
        motionImports += 1;
        expect(ENGINE, `${name} imports ${spec}`).not.toContain(m[1]);
        if (m[1] !== 'index') continue;
        // Through the barrel, only leaf names (types and labels): the rest of the barrel is shaken out.
        const names = (clause.match(/\{([\s\S]*)\}/)?.[1] ?? '')
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
          .filter((n) => !n.startsWith('type '))
          .map((n) => n.split(/\s+as\s+/)[0].trim());
        expect(clause.startsWith('type ') || /\{/.test(clause), `${name}: ${clause}`).toBe(true);
        for (const n of names) expect(leaf.has(n), `${name} takes ${n} from the motion barrel`).toBe(true);
      }
    }
    expect(motionImports).toBeGreaterThan(0);
  });
});
