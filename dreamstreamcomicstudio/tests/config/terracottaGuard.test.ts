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
 *
 * It also pins the Comic Studio app icons, outside those roots: public/icons/comics-mark.svg paints only
 * ink and paper (`#0a0a0a`, `#ffffff`, `#fafafa`; no terracotta, the old `#c2603f` tile included, and no
 * named, rgb() or hsl() colour), keeps the ComicsMark.tsx geometry and a dark-scheme block that swaps the
 * two, comics-edge/scripts/gen-comics-icons.mjs holds no hued colour, and the four committed PNGs match a
 * fresh render by that script, with an ink tile, a paper page and no hued pixel.
 */
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
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

describe('terracotta guard — the Comic Studio app icons', () => {
  const MARK = 'public/icons/comics-mark.svg';
  const SCRIPT = 'comics-edge/scripts/gen-comics-icons.mjs';
  /** Ink (--ds-ink), white paper, and the dark block's paper; `none` leaves a shape unpainted. Nothing else paints. */
  const MARK_PAINTS = new Set(['#0a0a0a', '#ffffff', '#fafafa', 'none']);
  const PAINT_PROPS = 'fill|stroke|stop-color|flood-color|lighting-color|color';
  const INK = [10, 10, 10, 255];
  const PAPER = [255, 255, 255, 255];
  /** Points on the 48-unit mark: on the tile clear of both pages, and on the front page clear of its lines. */
  const ON_TILE: [number, number] = [41, 6];
  const ON_PAGE: [number, number] = [20, 14];
  /** Each icon the script writes: its size, the share of it the mark fills (gen-comics-icons.mjs), and whether the tile ink fills the corners. */
  const ICONS: Record<string, { size: number; scale: number; fullBleed: boolean }> = {
    'comics-192.png': { size: 192, scale: 1, fullBleed: false },
    'comics-512.png': { size: 512, scale: 1, fullBleed: false },
    'comics-maskable-512.png': { size: 512, scale: 0.8, fullBleed: true },
    'comics-apple-touch-180.png': { size: 180, scale: 1, fullBleed: true }
  };
  const REGENERATE = 'run node comics-edge/scripts/gen-comics-icons.mjs from dreamstreamcomicstudio/';

  const read = (rel: string) => readFileSync(path.join(APP_ROOT, rel), 'utf8');
  /** A hex of any length is neutral when its red, green and blue are one value (the alpha pair aside). */
  const neutralHex = (hex: string) => {
    const digits = hex.slice(1).toLowerCase();
    if (![3, 4, 6, 8].includes(digits.length)) return false;
    const full = digits.length <= 4 ? digits.replace(/./g, (c) => c + c) : digits;
    return full.slice(0, 2) === full.slice(2, 4) && full.slice(2, 4) === full.slice(4, 6);
  };
  /** Every paint in an SVG: presentation attributes, and declarations in <style> and in style="…". */
  const paintsOf = (svg: string) => [
    ...[...svg.matchAll(new RegExp(String.raw`(?<![\w-])(?:${PAINT_PROPS})\s*=\s*(["'])(.*?)\1`, 'gi'))].map((m) => m[2].trim().toLowerCase()),
    ...[...svg.matchAll(new RegExp(String.raw`(?<![\w-])(?:${PAINT_PROPS})\s*:\s*([^;}"'<]+)`, 'gi'))].map((m) => m[1].trim().toLowerCase())
  ];
  /** The mark's paths (back page, front page, page lines) by their `d`, each with its stroke width and opacity. */
  const pathsOf = (source: string, widthAttr: string) =>
    new Map(
      [...source.matchAll(/<path\b[^>]*>/g)].map(([tag]): [string | undefined, string] => [
        /\bd="([^"]+)"/.exec(tag)?.[1],
        `width ${new RegExp(String.raw`\b${widthAttr}="([^"]*)"`).exec(tag)?.[1] ?? '-'} opacity ${/\bopacity="([^"]*)"/.exec(tag)?.[1] ?? '-'}`
      ])
    );
  const decode = (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  type Pixels = Awaited<ReturnType<typeof decode>>;
  const pixel = ({ data, info }: Pixels, x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];

  it('the mark paints in ink and paper only, and its dark-scheme block swaps them (the favicon on dark tab strips)', () => {
    const svg = read(MARK);
    const paints = paintsOf(svg);
    expect(paints.length).toBeGreaterThanOrEqual(8);
    for (const paint of paints) expect(MARK_PAINTS.has(paint), `${MARK}: paint ${paint}`).toBe(true);
    for (const [hex] of svg.matchAll(/#[0-9a-f]+/gi)) expect(MARK_PAINTS.has(hex.toLowerCase()), `${MARK}: ${hex}`).toBe(true);
    expect(svg).not.toMatch(/url\(|currentcolor|<(?:linear|radial)Gradient|<image\b|<filter\b/i);

    // Light drawing: each painted shape has a class; the dark block repaints that class's paint in the other ink.
    const dark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*)\}\s*<\/style>/.exec(svg)?.[1];
    expect(dark, `${MARK}: the dark-scheme block`).toBeDefined();
    const isInk = (hex: string) => parseInt(hex.slice(1, 3), 16) < 0x80;
    const shapes = [...svg.matchAll(/<(?:rect|path)\b[^>]*>/g)].map(([tag]) => tag);
    expect(shapes).toHaveLength(4);
    for (const tag of shapes) {
      const cls = /\bclass="([\w-]+)"/.exec(tag)?.[1];
      expect(cls, `${MARK}: ${tag} has a class the dark block can reach`).toBeDefined();
      for (const [, prop, light] of tag.matchAll(/\b(fill|stroke)="(#[0-9a-f]{6})"/gi)) {
        const swapped = new RegExp(String.raw`\.${cls}\s*\{[^}]*\b${prop}\s*:\s*(#[0-9a-f]{6})`, 'i').exec(dark ?? '')?.[1];
        expect(swapped, `${MARK}: .${cls} ${prop} under the dark scheme`).toBeDefined();
        expect(isInk(swapped ?? light), `${MARK}: .${cls} ${prop} ${light} → ${swapped}`).toBe(!isInk(light));
      }
    }
  });

  it('the mark is the ComicsMark.tsx drawing: same tile, same pages, same strokes', () => {
    const svg = read(MARK);
    const product = read('components/comicshost/ComicsMark.tsx');
    const productPaths = pathsOf(product, 'strokeWidth');
    expect(productPaths.size).toBeGreaterThanOrEqual(3);
    expect(pathsOf(svg, 'stroke-width')).toEqual(productPaths);
    for (const source of [svg, product]) {
      expect(source).toContain('x="2" y="2" width="44" height="44" rx="12"');
      expect(source).toContain('viewBox="0 0 48 48"');
    }
  });

  it('the icon script fills the full-bleed corners with ink and holds no hued colour', async () => {
    const { TILE } = await import('../../comics-edge/scripts/gen-comics-icons.mjs');
    expect(TILE).toBe('#0a0a0a');
    const source = read(SCRIPT);
    for (const [hex] of source.matchAll(/#[0-9a-f]+(?![\w-])/gi)) expect(neutralHex(hex), `${SCRIPT}: ${hex}`).toBe(true);
    expect(source).not.toMatch(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i);
  });

  it('the committed PNGs are what the script draws from the mark today: ink tile, paper page, no hue', async () => {
    const { renderIcons } = await import('../../comics-edge/scripts/gen-comics-icons.mjs');
    const fresh = await renderIcons(readFileSync(path.join(APP_ROOT, MARK)));
    expect(fresh.map(([name]) => name).sort()).toEqual(Object.keys(ICONS).sort());
    for (const [file, buffer] of fresh) {
      const rel = `public/icons/${file}`;
      const { size, scale, fullBleed } = ICONS[file];
      const committed = await decode(readFileSync(path.join(APP_ROOT, rel)));
      const drawn = await decode(buffer);
      expect([committed.info.width, committed.info.height], rel).toEqual([size, size]);

      // Pixel for pixel against a fresh render (a regenerate here is byte-identical; the bound absorbs antialiasing).
      let differing = 0;
      for (let i = 0; i < drawn.data.length; i += 4) {
        if (committed.data[i + 3] === 0 && drawn.data[i + 3] === 0) continue;
        for (let c = 0; c < 4; c += 1) {
          if (Math.abs(committed.data[i + c] - drawn.data[i + c]) > 16) {
            differing += 1;
            break;
          }
        }
      }
      expect(differing, `${rel}: pixels unlike a fresh render of ${MARK} (${REGENERATE})`).toBeLessThanOrEqual(Math.floor(size * size * 0.001));

      // Where the mark sits, and the inks it must show there: a blank, transparent or stale icon fails.
      const inner = Math.round(size * scale);
      const offset = Math.round((size - inner) / 2);
      const at = ([x, y]: [number, number]) => pixel(committed, offset + Math.floor((x / 48) * inner), offset + Math.floor((y / 48) * inner));
      expect(at(ON_TILE), `${rel}: a tile pixel`).toEqual(INK);
      expect(at(ON_PAGE), `${rel}: a page pixel`).toEqual(PAPER);
      if (fullBleed) expect(pixel(committed, 0, 0), `${rel}: the corner`).toEqual(INK);
      else expect(pixel(committed, 0, 0)[3], `${rel}: the corner outside the rounded tile`).toBe(0);

      let tinted = 0;
      for (let i = 0; i < committed.data.length; i += 4) {
        if (committed.data[i + 3] === 0) continue;
        const [r, g, b] = [committed.data[i], committed.data[i + 1], committed.data[i + 2]];
        if (Math.max(r, g, b) - Math.min(r, g, b) > 8) tinted += 1;
      }
      expect(tinted, `${rel}: pixels with a hue (${REGENERATE})`).toBe(0);
    }
  });
});
