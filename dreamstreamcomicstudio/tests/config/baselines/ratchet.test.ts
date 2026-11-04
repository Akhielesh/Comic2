// @vitest-environment node
/**
 * The ratchet machinery every design-system guard shares (tests/config/classLists.ts; README.md in this
 * folder): which files the app-wide scan reads, how a count compares with its baseline, what
 * `UPDATE_BASELINES` may and may not write, and that every checked-in baseline is clean and consistent.
 * File-system cases run in a fresh OS temp folder, never in the repository.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_ROOT,
  BASELINE_DIR,
  compareToBaseline,
  type Counts,
  globToRegExp,
  listScannedFiles,
  matchesGlob,
  PINNED_DIR,
  RECIPE_FILES,
  ratchet,
  ratchetMode,
  readBaseline,
  SCANNED_ROOTS,
  serialiseBaseline,
  shrinkBaseline,
  totalsOf
} from '../classLists';

const TEST = 'tests/config/exampleGuard.test.ts';
const temps: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ds0-ratchet-'));
  temps.push(dir);
  return dir;
};
const touch = (root: string, rel: string, body = 'export {};\n') => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), body);
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The guards, their tests and what each ratchet may not list. */
const GUARDS: Record<string, { test: string; never: string[] }> = {
  legacyKit: { test: 'tests/config/legacyKitGuard.test.ts', never: [] },
  terracotta: { test: 'tests/config/terracottaGuard.test.ts', never: [] },
  localCx: { test: 'tests/config/localCxGuard.test.ts', never: [] },
  zLadder: { test: 'tests/config/zLadderGuard.test.ts', never: [...RECIPE_FILES] },
  statusInk: { test: 'tests/config/statusInkGuard.test.ts', never: [PINNED_DIR] },
  overline: { test: 'tests/config/overlineGuard.test.ts', never: [PINNED_DIR] },
  dialogTitle: { test: 'tests/config/dialogTitle.test.ts', never: [PINNED_DIR] }
};
/** Deleted by DS-0 (master plan §0.1): no baseline may list them. */
const DELETED = ['Header', 'SettingsModal', 'KeyManager', 'ModelSelector', 'DraggablePanel', 'ResizablePanel', 'FluxKeyInput', 'OpenRouterKeyInput'].map(
  (n) => `components/${n}.tsx`
);

describe('the app-wide scan', () => {
  it('globs: `**/` spans directories, `*` stays in one segment', () => {
    expect(globToRegExp('live/**').test('live/views/a.tsx')).toBe(true);
    expect(globToRegExp('live/**').test('components/live.tsx')).toBe(false);
    expect(matchesGlob('components/chat/a.test.tsx', ['**/*.test.*'])).toBe(true);
    expect(matchesGlob('a.spec.ts', ['**/*.spec.*'])).toBe(true);
    expect(matchesGlob('components/contest.tsx', ['**/*.test.*'])).toBe(false);
    expect(matchesGlob('components/ds/Button.tsx', RECIPE_FILES)).toBe(true);
    expect(matchesGlob('components/ds/forms/Field.tsx', RECIPE_FILES)).toBe(true);
    expect(matchesGlob('components/dsx/Button.tsx', RECIPE_FILES)).toBe(false);
    expect(matchesGlob('components/chat/studioDesign.ts', RECIPE_FILES)).toBe(true);
    expect(matchesGlob('components/chat/studioDesign.test.ts', RECIPE_FILES)).toBe(false);
    expect(matchesGlob('components/comicstudio/board/ui.tsx', [PINNED_DIR])).toBe(true);
  });

  it('reads source files under the roots and skips tests, specs, test-only folders, live/**, hidden and node_modules', () => {
    const root = tempDir();
    for (const rel of [
      'App.tsx',
      'components/a.tsx',
      'components/b.ts',
      'components/deep/c.jsx',
      'qa/scene.tsx',
      'components/a.test.tsx',
      'components/b.spec.ts',
      'components/__tests__/d.tsx',
      'components/__mocks__/e.ts',
      'components/__fixtures__/f.ts',
      'components/style.css',
      'components/node_modules/g.ts',
      'components/.cache/h.ts',
      'live/views/i.tsx',
      'services/j.ts'
    ]) {
      touch(root, rel);
    }
    expect(listScannedFiles({ root })).toEqual(['App.tsx', 'components/a.tsx', 'components/b.ts', 'components/deep/c.jsx', 'qa/scene.tsx']);
    // live/** stays out even if a root reaches it; extra globs narrow a guard further.
    expect(listScannedFiles({ root, roots: [...SCANNED_ROOTS, 'live'] })).not.toContain('live/views/i.tsx');
    expect(listScannedFiles({ root, exclude: ['components/deep/**'] })).toEqual(['App.tsx', 'components/a.tsx', 'components/b.ts', 'qa/scene.tsx']);
  });

  it('on the real tree: components/**, App.tsx and qa/**, no tests, nothing from live/**', () => {
    const files = listScannedFiles();
    expect(files.length).toBeGreaterThan(400);
    expect(files).toContain('App.tsx');
    expect(files).toContain('qa/ComicQaApp.tsx');
    expect(files).toContain('components/chat/studioDesign.ts');
    expect(files.filter((f) => /\.(?:test|spec)\./.test(f))).toEqual([]);
    expect(files.filter((f) => !/^(?:components\/|qa\/|App\.tsx$)/.test(f))).toEqual([]);
    for (const rel of DELETED) expect(existsSync(path.join(APP_ROOT, rel)), rel).toBe(false);
  });
});

describe('the ratchet', () => {
  const baseline: Counts = { 'App.tsx': { 'border-black': 3, 'font-display': 1 }, 'components/A.tsx': { 'shadow-comic': 2 } };

  it('equal counts pass', () => {
    expect(compareToBaseline(structuredClone(baseline), baseline, TEST)).toEqual({ over: [], under: [] });
  });

  it('above fails: one more use, a new token in a listed file, and any use in an unlisted file', () => {
    const actual: Counts = {
      'App.tsx': { 'border-black': 4, 'font-display': 1, 'brand-yellow': 1 },
      'components/A.tsx': { 'shadow-comic': 2 },
      'components/New.tsx': { 'font-comic': 2 }
    };
    expect(compareToBaseline(actual, baseline, TEST)).toEqual({
      over: [
        'App.tsx  border-black: 4, baseline 3 — 1 new use',
        'App.tsx  brand-yellow: 1, baseline 0 — a file or token the baseline does not list must count 0',
        'components/New.tsx  font-comic: 2, baseline 0 — a file or token the baseline does not list must count 0'
      ],
      under: []
    });
  });

  it('below fails until the entry is lowered: a smaller count, a token gone, a file deleted', () => {
    const actual: Counts = { 'App.tsx': { 'border-black': 1 } };
    const { over, under } = compareToBaseline(actual, baseline, TEST);
    expect(over).toEqual([]);
    const fix = `(UPDATE_BASELINES=1 npx vitest run ${TEST}) so the gain is kept`;
    expect(under).toEqual([
      `App.tsx  border-black: 1, baseline 3 — the count fell: lower the baseline to 1 ${fix}`,
      `App.tsx  font-display: 0, baseline 1 — the count fell: lower the baseline to 0 ${fix}`,
      `components/A.tsx  shadow-comic: 0, baseline 2 — the count fell: lower the baseline to 0 ${fix}`
    ]);
  });

  it('a swap inside one file (one token down, another up) fails both ways', () => {
    const { over, under } = compareToBaseline({ ...baseline, 'App.tsx': { 'border-black': 2, 'font-display': 2 } }, baseline, TEST);
    expect(over).toEqual(['App.tsx  font-display: 2, baseline 1 — 1 new use']);
    expect(under).toHaveLength(1);
  });

  it('shrinking lowers and drops zeros, and never raises or adds an entry', () => {
    const actual: Counts = {
      'App.tsx': { 'border-black': 1, 'font-display': 5, 'brand-red': 2 },
      'components/New.tsx': { 'font-comic': 1 }
    };
    expect(shrinkBaseline(actual, baseline)).toEqual({ 'App.tsx': { 'border-black': 1, 'font-display': 1 } });
  });

  it('UPDATE_BASELINES: unset, 0 or false checks; reset rewrites; anything else only shrinks', () => {
    expect(ratchetMode(undefined)).toBe('check');
    expect(ratchetMode('')).toBe('check');
    expect(ratchetMode('0')).toBe('check');
    expect(ratchetMode('false')).toBe('check');
    expect(ratchetMode('1')).toBe('shrink');
    expect(ratchetMode('shrink')).toBe('shrink');
    expect(ratchetMode('RESET')).toBe('reset');
  });
});

describe('the baseline files', () => {
  it('one line per file, keys sorted, totals derived; reads back to the same counts', () => {
    const counts: Counts = { 'qa/b.tsx': { 'z-50': 2, 'z-10': 1 }, 'App.tsx': { 'z-[70]': 1 }, 'components/empty.tsx': { 'z-0': 0 } };
    const json = serialiseBaseline('example', TEST, counts);
    expect(json).toContain('  "totals": { "z-10": 1, "z-50": 2, "z-[70]": 1 },\n');
    expect(json).toContain('    "App.tsx": { "z-[70]": 1 },\n    "qa/b.tsx": { "z-10": 1, "z-50": 2 }\n');
    expect(json).not.toContain('empty.tsx');
    const dir = tempDir();
    writeFileSync(path.join(dir, 'example.json'), json);
    expect(readBaseline('example', dir)).toEqual({
      baseline: { 'App.tsx': { 'z-[70]': 1 }, 'qa/b.tsx': { 'z-10': 1, 'z-50': 2 } },
      problems: [],
      exists: true
    });
    expect(totalsOf({ a: { x: 1 }, b: { x: 2, y: 1 } })).toEqual({ x: 3, y: 1 });
  });

  it('a missing, malformed or inconsistent file is a problem, never a silent pass', () => {
    const dir = tempDir();
    const counts: Counts = { 'App.tsx': { 'z-50': 1 } };
    expect(ratchet('example', TEST, counts, { mode: 'check', dir }).problems).toEqual([
      `no baseline tests/config/baselines/example.json: generate it from the tree with UPDATE_BASELINES=reset npx vitest run ${TEST}`
    ]);
    writeFileSync(path.join(dir, 'example.json'), '{ not json');
    expect(readBaseline('example', dir).problems[0]).toMatch(/^example\.json is not valid JSON/);
    const good = JSON.parse(serialiseBaseline('example', TEST, counts));
    writeFileSync(path.join(dir, 'example.json'), JSON.stringify({ ...good, totals: { 'z-50': 9 } }));
    expect(readBaseline('example', dir).problems).toEqual([`example.json: "totals" does not match "files" (regenerate it: UPDATE_BASELINES=1 npx vitest run ${TEST})`]);
    writeFileSync(path.join(dir, 'example.json'), JSON.stringify({ ...good, files: { 'App.tsx': { 'z-50': 0 } }, totals: {} }));
    expect(readBaseline('example', dir).problems).toEqual(['example.json: App.tsx z-50 is 0 (entries are positive integers; drop a zero)']);
    writeFileSync(path.join(dir, 'example.json'), JSON.stringify({ ...good, guard: 'other' }));
    expect(readBaseline('example', dir).problems).toEqual(['example.json names guard "other"']);
  });

  it('UPDATE_BASELINES=reset writes the tree; =1 then only lowers, and a new use still fails', () => {
    const dir = tempDir();
    const first: Counts = { 'App.tsx': { 'z-50': 2 }, 'qa/a.tsx': { 'z-10': 1 } };
    expect(ratchet('example', TEST, first, { mode: 'reset', dir })).toEqual({ over: [], under: [], problems: [], written: true });
    // Check mode never writes.
    const before = readFileSync(path.join(dir, 'example.json'), 'utf8');
    const later: Counts = { 'App.tsx': { 'z-50': 1, 'z-[90]': 1 }, 'components/New.tsx': { 'z-40': 1 } };
    const checked = ratchet('example', TEST, later, { mode: 'check', dir });
    expect(checked.written).toBe(false);
    expect(checked.over).toHaveLength(2);
    expect(checked.under).toHaveLength(2);
    expect(readFileSync(path.join(dir, 'example.json'), 'utf8')).toBe(before);
    // Shrink: the falls are written down, the rises still fail.
    const shrunk = ratchet('example', TEST, later, { mode: 'shrink', dir });
    expect(shrunk.written).toBe(true);
    expect(shrunk.under).toEqual([]);
    expect(shrunk.over).toEqual([
      'App.tsx  z-[90]: 1, baseline 0 — a file or token the baseline does not list must count 0',
      'components/New.tsx  z-40: 1, baseline 0 — a file or token the baseline does not list must count 0'
    ]);
    expect(readBaseline('example', dir).baseline).toEqual({ 'App.tsx': { 'z-50': 1 } });
    // Shrink never creates a missing file.
    const empty = tempDir();
    expect(ratchet('example', TEST, first, { mode: 'shrink', dir: empty }).written).toBe(false);
    expect(existsSync(path.join(empty, 'example.json'))).toBe(false);
  });

  it('every checked-in baseline is clean, names its guard and test, and lists only scanned files that exist', () => {
    const scanned = new Set(listScannedFiles());
    const onDisk = readdirSync(BASELINE_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    expect(onDisk.sort()).toEqual(Object.keys(GUARDS).sort());
    for (const [guard, { test, never }] of Object.entries(GUARDS)) {
      const { baseline, problems, exists } = readBaseline(guard);
      expect(exists, guard).toBe(true);
      expect(problems, guard).toEqual([]);
      const file = JSON.parse(readFileSync(path.join(BASELINE_DIR, `${guard}.json`), 'utf8')) as { test: string };
      expect(file.test, guard).toBe(test);
      expect(existsSync(path.join(APP_ROOT, test)), test).toBe(true);
      // Generated files only: the checked-in text is exactly what the generator writes.
      expect(readFileSync(path.join(BASELINE_DIR, `${guard}.json`), 'utf8'), `${guard}.json is hand-edited: regenerate it`).toBe(serialiseBaseline(guard, test, baseline));
      for (const rel of Object.keys(baseline)) {
        expect(scanned.has(rel), `${guard}.json lists ${rel}, which is not a scanned file`).toBe(true);
        expect(matchesGlob(rel, never), `${guard}.json lists ${rel}, which this guard does not ratchet`).toBe(false);
        expect(DELETED, `${guard}.json lists a deleted file`).not.toContain(rel);
      }
    }
  });
});
