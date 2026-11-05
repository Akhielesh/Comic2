// @vitest-environment node
/**
 * Z-ladder guard (DS-0, master plan §1.1 "New tokens" and §1.4).
 *
 * Stacking is one ladder of tokens — `--ds-z-{stage,chrome,header,editor,reader,scrim,sheet,popover,
 * toast,tooltip}` (0–30 / 40 / 40 / 70 / 80 / 85 / 86 / 90 / 95 / 100, the documented 70/80/85/86 of
 * mobile/sheets/BottomSheet.tsx kept) — read through the `Z` recipe in components/chat/studioDesign.ts
 * and the components/ds primitives. A hand-written `z-50` or `z-[9999]` is a private rung: it decides
 * on its own what covers what, and it is how a menu ends up under a sheet or a toast under a scrim.
 *
 * Fails on a Tailwind z-index class — `z-NN` (`z-10`, `-z-10`) or `z-[…]` (`z-[70]`,
 * `z-[var(--x)]`), any variant prefix or `!` — in a literal of any scanned file (components/**,
 * App.tsx, qa/**), except the recipe files that legitimately spell the ladder (components/ds/** and
 * components/chat/studioDesign.ts; tests/config/classLists.ts RECIPE_FILES). `z-auto` is not a rung. It
 * RATCHETS against tests/config/baselines/zLadder.json
 * (`UPDATE_BASELINES=1 npx vitest run tests/config/zLadderGuard.test.ts` once a file reads `Z.*`).
 */
import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type Allowlist,
  type Counts,
  APP_ROOT,
  compareToBaseline,
  countTokens,
  findInLiterals,
  listScannedFiles,
  ratchet,
  readBaseline,
  REAL_TREE_TIMEOUT,
  RECIPE_FILES,
  scanTree,
  tempTree,
  VARIANT,
  withoutVariant
} from './classLists';

const GUARD = 'zLadder';
const TEST_FILE = 'tests/config/zLadderGuard.test.ts';

/** A Tailwind z-index class: `z-NN`, `-z-NN` or `z-[…]`, any variant prefix and `!`. */
export const Z_CLASS = new RegExp(String.raw`(?<![\w-])${VARIANT}-?z-(?:\d+|\[[^\]\s]+\])(?![\w-])`, 'g');

/** `md:!z-[70]` → `z-[70]`; `-z-10` keeps its sign. */
export const zToken = (match: string) => withoutVariant(match);

/** Every raw z-index class in a source's literals; a scan passes the file's path so a `.ts` file parses as TypeScript. */
export const findZClasses = (source: string, fileName?: string) => findInLiterals(source, Z_CLASS, zToken, fileName);

/** Content exemptions (token and trimmed line, one-line reason). None: a z-index is never content. */
const ALLOWLIST: Allowlist = {};

/** The files the guard reads: every scanned file except the recipe files (RECIPE_FILES). */
export const zLadderFiles = (root = APP_ROOT) => listScannedFiles({ root, exclude: RECIPE_FILES });

/**
 * The guard's scan of an app tree, each file read in its own language. The real-tree test runs exactly
 * this, and the recipe test runs it on a temp tree, so dropping the recipe exclusion fails there.
 */
export function zLadderScan(root = APP_ROOT) {
  const files = zLadderFiles(root);
  return { files, ...scanTree(files, (rel, source) => findZClasses(source, rel), ALLOWLIST, root) };
}

const PLANTED = 'components/__planted__/Fixture.tsx';
const plant = (classes: string) => `export const Fixture = () => <div className="fixed inset-0 ${classes}">x</div>;\n`;

describe('z-ladder guard — the detector', () => {
  it('recognises numeric and arbitrary z-index classes, with any variant, sign or important flag', () => {
    const flagged: Array<[string, string]> = [
      ['z-50', 'z-50'],
      ['z-0', 'z-0'],
      ['-z-10', '-z-10'],
      ['md:z-40', 'z-40'],
      ['hover:!z-30', 'z-30'],
      ['z-[70]', 'z-[70]'],
      ['z-[9999]', 'z-[9999]'],
      ['sm:z-[85]', 'z-[85]'],
      ['z-[var(--ds-z-sheet)]', 'z-[var(--ds-z-sheet)]'],
      ['group-hover/tile:z-20', 'z-20']
    ];
    for (const [cls, token] of flagged) expect(findZClasses(plant(cls)).map((h) => h.token), cls).toEqual([token]);
    expect(findZClasses("const SHEET = cx(open ? 'z-[86]' : 'z-[85]', 'fixed');").map((h) => h.token)).toEqual(['z-[86]', 'z-[85]']);
  });

  it('leaves z-auto, look-alikes, inline styles, comments and visible text alone', () => {
    const allowed = ['z-auto', 'size-10 lazy-10 translate-z-0 xyz-10', 'zoom-50 z-index', 'gap-z-4'];
    for (const cls of allowed) expect(findZClasses(plant(cls)), cls).toEqual([]);
    expect(findZClasses('<div style={{ zIndex: 50 }} />')).toEqual([]);
    expect(findZClasses('// was z-[70], now Z.editor\nconst a = 1;')).toEqual([]);
    expect(findZClasses('<p>{/* z-50 */}Layer z-50 sits on top</p>')).toEqual([]);
  });

  it('reads a .ts file as TypeScript: a generic arrow does not hide the literals after it', () => {
    const src = "const f = <T>(x: T) => x;\nexport const A = 'fixed z-[9999] md:z-50';\n";
    expect(findZClasses(src, 'components/x.ts').map((h) => [h.line, h.token])).toEqual([
      [2, 'z-[9999]'],
      [2, 'z-50']
    ]);
  });

  it('skips the recipe files only: components/ds/** and components/chat/studioDesign.ts', () => {
    // A temp tree (never the repo) where the recipe files spell the ladder and ordinary files do not;
    // Other.ts also proves the scan reads a .ts file in full (a generic helper comes first).
    const root = tempTree({
      'components/ds/Layer.tsx': "export const LAYER = 'fixed z-[var(--ds-z-sheet)]';\n",
      'components/ds/overlay/Sheet.tsx': "export const SHEET = 'z-[var(--ds-z-sheet)]';\n",
      'components/chat/studioDesign.ts': "export const Z = { sheet: 'z-[var(--ds-z-sheet)]' } as const;\n",
      'components/x.tsx': 'export const X = () => <div className="fixed z-50" />;\n',
      'components/chat/Other.ts': "const pick = <T>(v: T) => v;\nexport const O = 'z-[var(--ds-z-sheet)]';\n"
    });
    try {
      const { files, counts } = zLadderScan(root);
      expect(files).toEqual(['components/chat/Other.ts', 'components/x.tsx']);
      expect(counts).toEqual({ 'components/chat/Other.ts': { 'z-[var(--ds-z-sheet)]': 1 }, 'components/x.tsx': { 'z-50': 1 } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // On the real tree the recipe module exists, is scanned by the other guards and skipped here.
    expect(listScannedFiles()).toContain('components/chat/studioDesign.ts');
    expect(zLadderFiles()).not.toContain('components/chat/studioDesign.ts');
    expect(zLadderFiles()).toContain('components/chat/ChatConversation.tsx');
  });
});

describe('z-ladder guard — the ratchet', () => {
  const { baseline } = readBaseline(GUARD);

  it('a raw z-index planted in any scanned file fails, naming the file, the class and the count', () => {
    for (const cls of ['z-50', 'z-[9999]']) {
      const actual: Counts = { ...baseline, [PLANTED]: countTokens(findZClasses(plant(cls))) };
      expect(compareToBaseline(actual, baseline, TEST_FILE), cls).toEqual({
        over: [`${PLANTED}  ${cls}: 1, baseline 0 — a file or token the baseline does not list must count 0`],
        under: []
      });
    }
  });

  it('a new rung in a baselined file fails even when the file’s total stays the same', () => {
    const [rel, tokens] = Object.entries(baseline)[0];
    const [token, n] = Object.entries(tokens)[0];
    expect(tokens['z-[4242]']).toBeUndefined();
    const swapped: Counts = { ...baseline, [rel]: { ...tokens, [token]: n - 1, 'z-[4242]': 1 } };
    const { over, under } = compareToBaseline(swapped, baseline, TEST_FILE);
    expect(over).toEqual([`${rel}  z-[4242]: 1, baseline 0 — a file or token the baseline does not list must count 0`]);
    expect(under).toEqual([`${rel}  ${token}: ${n - 1}, baseline ${n} — the count fell: lower the baseline to ${n - 1} (UPDATE_BASELINES=1 npx vitest run ${TEST_FILE}) so the gain is kept`]);
  });

  it('components/**, App.tsx and qa/** (minus the recipe files) match tests/config/baselines/zLadder.json exactly', { timeout: REAL_TREE_TIMEOUT }, () => {
    const { files, counts, stale } = zLadderScan();
    expect(files.length).toBeGreaterThan(400);
    expect(stale).toEqual([]);
    const { over, under, problems } = ratchet(GUARD, TEST_FILE, counts);
    expect(problems).toEqual([]);
    expect(over, 'A new raw z-index: stack with the Z recipe (components/chat/studioDesign.ts, --ds-z-*) or a components/ds primitive.').toEqual([]);
    expect(under, 'Raw z-indexes were removed: lower the baseline so they cannot come back.').toEqual([]);
  });
});
