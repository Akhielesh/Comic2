// @vitest-environment node
/**
 * Terracotta guard (DS-0, master plan §1.4; docs/design/atlas-skin.md "The transitional accent shim").
 *
 * The calm-studio accent was the literal `#D97757` (hover `#c2643f`), written straight into utilities
 * (`bg-[#D97757]/10`, `text-[#D97757]`, `focus-visible:ring-[#D97757]/45`), inline styles and SVG
 * paint. A literal ignores the skin and the theme: under Atlas it is only repainted by the generated
 * accent shim at the end of index.css, which DS-10 deletes. New code reads the accent tokens instead —
 * `--ds-accent`, `--ds-accent-hover`, `--ds-accent-soft`, `--ds-on-accent`, `--ds-ring` — through the
 * studioDesign recipes (ACCENT_SOFT_BG, PRIMARY_BTN, FOCUS_RING, …) and the components/ds primitives.
 *
 * Fails on `#D97757` / `#c2643f` in any case, with or without an alpha pair (`#D97757cc`), in a literal
 * of any scanned file (components/**, App.tsx, qa/**; tests/config/classLists.ts SCANNED_ROOTS), outside
 * the content allowlist below. It RATCHETS against tests/config/baselines/terracotta.json: a file not
 * listed must count 0, above its entry fails, below fails until lowered
 * (`UPDATE_BASELINES=1 npx vitest run tests/config/terracottaGuard.test.ts`).
 */
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
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
  scanTree,
  tempTree
} from './classLists';

const GUARD = 'terracotta';
const TEST_FILE = 'tests/config/terracottaGuard.test.ts';

/** The two terracotta hexes, any case, with an optional alpha pair; never a longer hex that starts the same. */
export const TERRACOTTA = /#(?:d97757|c2643f)(?:[0-9a-f]{2})?(?![0-9a-f])/gi;

/** `#D97757cc` → `#d97757`. */
export const terracottaToken = (match: string) => match.slice(0, 7).toLowerCase();

/** Every terracotta literal in a source; a scan passes the file's path so a `.ts` file parses as TypeScript. */
export const findTerracotta = (source: string, fileName?: string) => findInLiterals(source, TERRACOTTA, terracottaToken, fileName);

/**
 * Content exemptions, keyed by app-relative path; each pins the exact uses it permits (token and trimmed
 * source line), never a count, with a one-line reason.
 */
const ALLOWLIST: Allowlist = {
  'components/models/ProviderIcon.tsx': {
    uses: [{ token: '#d97757', line: '<svg {...svgProps(className)} viewBox="0 0 24 24" fill="#D97757" fillRule="evenodd">' }],
    reason: "a third-party provider's logo drawn in its own brand colour (content, not our accent)"
  }
};

/** The guard's scan of an app tree (the real-tree test runs exactly this), each file read in its own language. */
export function terracottaScan(root = APP_ROOT) {
  const files = listScannedFiles({ root });
  return { files, ...scanTree(files, (rel, source) => findTerracotta(source, rel), ALLOWLIST, root) };
}

const PLANTED = 'components/__planted__/Fixture.tsx';

describe('terracotta guard — the detector', () => {
  it('recognises both hexes in any case and form: utilities, styles, SVG paint, alpha pairs', () => {
    const flagged: Array<[string, string[]]> = [
      ['<p className="text-[#D97757]">x</p>', ['#d97757']],
      ['<p className="bg-[#d97757]/10 hover:bg-[#C2643F]">x</p>', ['#d97757', '#c2643f']],
      ['<p className="focus-visible:ring-[#D97757]/45">x</p>', ['#d97757']],
      ["<p style={{ color: '#D97757', borderColor: '#D97757cc' }}>x</p>", ['#d97757', '#d97757']],
      ['<path stroke="#c2643f" />', ['#c2643f']],
      ["const ACCENT = '#D97757';", ['#d97757']],
      ['const A = `linear-gradient(135deg, #E8916F 0%, #D97757 55%)`;', ['#d97757']]
    ];
    for (const [src, tokens] of flagged) expect(findTerracotta(src).map((h) => h.token), src).toEqual(tokens);
  });

  it('leaves the tokens, other hexes, comments and visible text alone', () => {
    const allowed = [
      '<p className="bg-[var(--ds-accent)] text-[var(--ds-on-accent)] hover:bg-[var(--ds-accent-hover)]">x</p>',
      "const NEAR = ['#D97758', '#d977570', '#c2643e', '#D9775'];",
      '// was bg-[#D97757]/10, now ACCENT_SOFT_BG\nconst a = 1;',
      '<p>{/* #c2643f */}Our accent used to be #D97757.</p>'
    ];
    for (const src of allowed) expect(findTerracotta(src), src).toEqual([]);
  });

  it('reads a .ts file as TypeScript: a generic arrow does not hide the literals after it', () => {
    const src = "const f = <T>(x: T) => x;\nexport const A = 'text-[#D97757] hover:bg-[#c2643f]';\n";
    expect(findTerracotta(src, 'components/x.ts').map((h) => [h.line, h.token])).toEqual([
      [2, '#d97757'],
      [2, '#c2643f']
    ]);
  });

  it('a terracotta literal appended to a real .ts API module with generic helpers is found (the review repro)', () => {
    for (const rel of ['components/comicstudio/models/modelsApi.ts', 'components/comicstudio/studioApi.ts']) {
      const source = `${readFileSync(path.join(APP_ROOT, rel), 'utf8')}\nexport const PLANTED_ACCENT = 'text-[#D97757] z-50';\n`;
      expect(findTerracotta(source, rel).map((h) => h.text), rel).toContain("export const PLANTED_ACCENT = 'text-[#D97757] z-50';");
    }
  });
});

describe('terracotta guard — the ratchet', () => {
  const { baseline } = readBaseline(GUARD);

  it('a terracotta literal planted in any scanned file fails, naming the file, the token and the count', () => {
    for (const src of ['<p className="text-[#D97757]">x</p>', "<p style={{ color: '#c2643f' }}>x</p>"]) {
      const hits = findTerracotta(src);
      const actual: Counts = { ...baseline, [PLANTED]: countTokens(hits) };
      const { over, under } = compareToBaseline(actual, baseline, TEST_FILE);
      expect(over, src).toEqual([`${PLANTED}  ${hits[0].token}: 1, baseline 0 — a file or token the baseline does not list must count 0`]);
      expect(under, src).toEqual([]);
    }
  });

  it('above a file’s baseline fails; below it fails until the baseline is lowered', () => {
    const [rel, tokens] = Object.entries(baseline)[0];
    const [token, n] = Object.entries(tokens)[0];
    expect(compareToBaseline({ ...baseline, [rel]: { ...tokens, [token]: n + 2 } }, baseline, TEST_FILE).over).toEqual([
      `${rel}  ${token}: ${n + 2}, baseline ${n} — 2 new uses`
    ]);
    const { over, under } = compareToBaseline({ ...baseline, [rel]: { ...tokens, [token]: 0 } }, baseline, TEST_FILE);
    expect(over).toEqual([]);
    expect(under).toEqual([
      `${rel}  ${token}: 0, baseline ${n} — the count fell: lower the baseline to 0 (UPDATE_BASELINES=1 npx vitest run ${TEST_FILE}) so the gain is kept`
    ]);
  });

  it('an allowlist entry permits its pinned use only: a second literal in the same file counts', () => {
    const rel = 'components/models/ProviderIcon.tsx';
    const source = readFileSync(path.join(APP_ROOT, rel), 'utf8');
    expect(source).toContain(ALLOWLIST[rel].uses[0].line);
    expect(scanTree([rel], () => findTerracotta(source, rel), ALLOWLIST)).toMatchObject({ counts: {}, stale: [] });
    // A second literal beside the pinned mark is a use; dropping the mark leaves a stale pin.
    const extra = `${source}\nexport const EXTRA = '#D97757';\n`;
    expect(scanTree([rel], () => findTerracotta(extra, rel), ALLOWLIST)).toMatchObject({ counts: { [rel]: { '#d97757': 1 } }, stale: [] });
    const swapped = source.replace('fill="#D97757"', 'fill="currentColor"');
    expect(scanTree([rel], () => findTerracotta(swapped, rel), ALLOWLIST).stale).toEqual([
      `${rel}: allowlisted use no longer present: #d97757  @  ${ALLOWLIST[rel].uses[0].line} (${ALLOWLIST[rel].reason})`
    ]);
  });

  it('the scan reads a .ts file in full: a literal after a generic helper counts', () => {
    const root = tempTree({ 'components/api.ts': `const list = <T>(v: unknown): T[] => [] as T[];\nexport const A = 'text-[#D97757]';\n`, 'qa/Scene.tsx': '<p className="bg-[#c2643f]">x</p>' });
    try {
      expect(terracottaScan(root).counts).toEqual({ 'components/api.ts': { '#d97757': 1 }, 'qa/Scene.tsx': { '#c2643f': 1 } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('components/**, App.tsx and qa/** match tests/config/baselines/terracotta.json exactly', { timeout: REAL_TREE_TIMEOUT }, () => {
    const { files, counts, stale } = terracottaScan();
    expect(files.length).toBeGreaterThan(400);
    expect(stale).toEqual([]);
    const { over, under, problems } = ratchet(GUARD, TEST_FILE, counts);
    expect(problems).toEqual([]);
    expect(
      over,
      'A new terracotta literal: read the accent tokens through the studioDesign recipes (ACCENT_SOFT_BG, PRIMARY_BTN, FOCUS_RING, TONE_*) or components/ds.'
    ).toEqual([]);
    expect(under, 'Terracotta literals were removed: lower the baseline so they cannot come back.').toEqual([]);
  });
});
