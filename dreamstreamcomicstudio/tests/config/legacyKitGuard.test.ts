// @vitest-environment node
/**
 * Legacy kit guard (DS-0, master plan §1.4; docs/design/atlas-skin.md).
 *
 * The pre-Atlas comic kit — `border-black` (the 2 px black rule), `shadow-comic` / `shadow-comic-hover`
 * (the hard offset shadow), `font-comic` (Comic Neue), the `brand-*` colours (yellow, blue, red, black)
 * and Tailwind's `font-display` (Bangers) — ignores the skin, the theme and the tokens: it is the same
 * black-on-yellow in light, dark and Atlas. New chrome reads the `--ds-*` tokens through the studioDesign
 * recipes and the `components/ds` primitives instead; lettering and comic art keep their faces through
 * the lettering fonts (`shared/comic/lettering/fonts.ts`), never these utilities, and DS-10 deletes the
 * utilities from tailwind.config.cjs once nothing uses them.
 *
 * Scope: every source file under `components/**`, `App.tsx` and `qa/**` (tests, specs and `live/**` are
 * not scanned; tests/config/classLists.ts SCANNED_ROOTS / EXCLUDED). Only literals count — class strings,
 * attribute values, templates — so a comment or a sentence that names a token is never a use. The app
 * still carries the kit in about 250 files, so this RATCHETS against tests/config/baselines/legacyKit.json:
 * a file or token not listed must count 0, a count above its entry fails, and a count below fails until
 * the entry is lowered (`UPDATE_BASELINES=1 npx vitest run tests/config/legacyKitGuard.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  type Allowlist,
  type Counts,
  compareToBaseline,
  countTokens,
  findInLiterals,
  listScannedFiles,
  ratchet,
  readBaseline,
  scanTree,
  VARIANT,
  withoutOpacity,
  withoutVariant
} from './classLists';

const GUARD = 'legacyKit';
const TEST_FILE = 'tests/config/legacyKitGuard.test.ts';

const OPACITY = String.raw`(?:\/(?:\d+|\[[^\]\s]+\]))?`;
/**
 * A legacy kit utility, any variant prefix and opacity: `border-black` (and a side, `border-t-black`),
 * `shadow-comic` and its `-hover` / size forms, `font-comic`, any utility on a brand colour
 * (`bg-brand-yellow`, `text-brand-blue/80`, `ring-brand-red`, `from-brand-black`), and the Tailwind class
 * `font-display` (not the CSS descriptor `font-display: swap`, not `--ds-font-display`).
 */
export const LEGACY_KIT = new RegExp(
  String.raw`(?<![\w-])${VARIANT}(?:border-(?:[xytrbl]-)?black${OPACITY}|shadow-comic(?:-[a-z]+)?|font-comic|[a-z]+(?:-[a-z]+)*-brand-(?:yellow|blue|red|black)${OPACITY}|font-display(?!\s*:))(?![\w-])`,
  'g'
);

/** The ratchet token for a matched utility: border-black, shadow-comic, font-comic, font-display or brand-<colour>. */
export function legacyToken(match: string): string {
  const cls = withoutOpacity(withoutVariant(match));
  if (/^border-(?:[xytrbl]-)?black$/.test(cls)) return 'border-black';
  if (cls.startsWith('shadow-comic')) return 'shadow-comic';
  const brand = /-(brand-(?:yellow|blue|red|black))$/.exec(cls);
  return brand ? brand[1] : cls;
}

export const findLegacyKit = (source: string) => findInLiterals(source, LEGACY_KIT, legacyToken);

/**
 * Content exemptions, keyed by app-relative path; each pins the exact uses it permits (token and trimmed
 * source line) with a one-line reason. None today: comic lettering and art take their faces and colours
 * from the lettering fonts and the reader tokens, never these utilities, so every use is chrome to
 * migrate (and DS-10 deletes the utilities themselves).
 */
const ALLOWLIST: Allowlist = {};

const PLANTED = 'components/__planted__/Fixture.tsx';
const plant = (classes: string) => `export const Fixture = () => <div className="p-2 ${classes}">x</div>;\n`;

describe('legacy kit guard — the detector', () => {
  it('recognises each legacy token, with any variant prefix and opacity, and names its ratchet token', () => {
    const flagged: Array<[string, string]> = [
      ['border-black', 'border-black'],
      ['hover:border-black', 'border-black'],
      ['border-black/20', 'border-black'],
      ['border-t-black', 'border-black'],
      ['shadow-comic', 'shadow-comic'],
      ['hover:shadow-comic-hover', 'shadow-comic'],
      ['focus:shadow-comic', 'shadow-comic'],
      ['font-comic', 'font-comic'],
      ['font-display', 'font-display'],
      ['md:font-display', 'font-display'],
      ['bg-brand-yellow', 'brand-yellow'],
      ['text-brand-blue/80', 'brand-blue'],
      ['hover:bg-brand-yellow/[0.3]', 'brand-yellow'],
      ['ring-brand-red', 'brand-red'],
      ['from-brand-black', 'brand-black'],
      ['[&_svg]:fill-brand-yellow', 'brand-yellow'],
      ['group-hover/card:border-brand-blue', 'brand-blue']
    ];
    for (const [cls, token] of flagged) {
      expect(findLegacyKit(plant(cls)).map((h) => h.token), cls).toEqual([token]);
    }
    // One class list can carry several; each is one use.
    expect(findLegacyKit(plant('border-2 border-black shadow-comic font-display bg-brand-yellow')).map((h) => h.token)).toEqual([
      'border-black',
      'shadow-comic',
      'font-display',
      'brand-yellow'
    ]);
    // Templates and multi-line literals count, on the line the token is written.
    const hits = findLegacyKit('const A = `px-2\n  ${on ? "bg-brand-blue" : ""}\n  shadow-comic`;\n');
    expect(hits.map((h) => [h.line, h.token])).toEqual([
      [2, 'brand-blue'],
      [3, 'shadow-comic']
    ]);
  });

  it('leaves the tokens, recipes, look-alikes, comments, visible text and imports alone', () => {
    const allowed = [
      'border-[var(--ds-hairline)] text-black bg-black border-white',
      'shadow-[shadow:var(--ds-shadow-soft)] shadow-lg',
      'font-[family-name:var(--ds-font-display)] font-semibold',
      'border-blackish shadow-comical font-comics',
      'brand-new rebrand-yellow brand-yellow',
      'text-[var(--ds-ink)]'
    ];
    for (const cls of allowed) expect(findLegacyKit(plant(cls)), cls).toEqual([]);
    expect(findLegacyKit("const css = '@font-face { font-family: X; font-display: swap; }';")).toEqual([]);
    expect(findLegacyKit("const css = '@font-face{font-display:block}';")).toEqual([]);
    expect(findLegacyKit('// never `border-2 border-black shadow-comic` in new chrome\nconst a = 1;')).toEqual([]);
    expect(findLegacyKit('const A = () => <div>{/* not font-comic */}<p>Use border-black and font-display</p></div>;')).toEqual([]);
    expect(findLegacyKit("import x from './font-comic';\nconst y = import('./shadow-comic');")).toEqual([]);
  });
});

describe('legacy kit guard — the ratchet', () => {
  const { baseline } = readBaseline(GUARD);

  it('a legacy token planted in any scanned file fails, naming the file, the token and the count', () => {
    for (const cls of ['border-black', 'shadow-comic', 'font-comic', 'bg-brand-yellow', 'font-display']) {
      const actual: Counts = { ...baseline, [PLANTED]: countTokens(findLegacyKit(plant(cls))) };
      const { over, under } = compareToBaseline(actual, baseline, TEST_FILE);
      expect(over, cls).toEqual([`${PLANTED}  ${legacyToken(cls)}: 1, baseline 0 — a file or token the baseline does not list must count 0`]);
      expect(under, cls).toEqual([]);
    }
  });

  it('one use more than a file’s baseline fails; one use fewer fails until the baseline is lowered', () => {
    const [rel, tokens] = Object.entries(baseline)[0];
    const [token, n] = Object.entries(tokens)[0];
    const bumped: Counts = { ...baseline, [rel]: { ...tokens, [token]: n + 1 } };
    expect(compareToBaseline(bumped, baseline, TEST_FILE)).toEqual({ over: [`${rel}  ${token}: ${n + 1}, baseline ${n} — 1 new use`], under: [] });
    const lowered: Counts = { ...baseline, [rel]: { ...tokens, [token]: n - 1 } };
    const { over, under } = compareToBaseline(lowered, baseline, TEST_FILE);
    expect(over).toEqual([]);
    expect(under).toEqual([
      `${rel}  ${token}: ${n - 1}, baseline ${n} — the count fell: lower the baseline to ${n - 1} (UPDATE_BASELINES=1 npx vitest run ${TEST_FILE}) so the gain is kept`
    ]);
  });

  it('components/**, App.tsx and qa/** match tests/config/baselines/legacyKit.json exactly', () => {
    const files = listScannedFiles();
    expect(files.length).toBeGreaterThan(400);
    expect(files).toContain('App.tsx');
    const { counts, stale } = scanTree(files, (_rel, source) => findLegacyKit(source), ALLOWLIST);
    expect(stale).toEqual([]);
    const { over, under, problems } = ratchet(GUARD, TEST_FILE, counts);
    expect(problems).toEqual([]);
    expect(
      over,
      'A new legacy-kit use: build new chrome from the --ds-* tokens, the studioDesign recipes and components/ds (no border-black, shadow-comic, font-comic, brand-* or font-display).'
    ).toEqual([]);
    expect(under, 'The legacy kit shrank: lower the baseline so it cannot creep back.').toEqual([]);
  });
});
