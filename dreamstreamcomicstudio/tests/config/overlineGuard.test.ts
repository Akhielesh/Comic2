// @vitest-environment node
/**
 * Overline guard (Atlas wave 8, docs/design/atlas-skin.md "Wave 8 port").
 *
 * Atlas consolidated its hand-rolled small uppercase labels (10–12 px, tracking 0.05–0.22em, mixed
 * weights and colours) onto `.atlas-overline`. Comic Studio's counterpart is the OVERLINE recipe in
 * components/chat/studioDesign.ts (11 px, semibold, leading 1rem, 0.12em, uppercase, muted), so every
 * eyebrow in the studio shares one size, weight, tracking and colour and follows the skin.
 *
 * This fails on any NEW hand-rolled eyebrow in components/comicstudio/**: a class list that spells
 * `uppercase` together with `tracking-wider`, `tracking-widest` or an arbitrary `tracking-[0.…]`
 * (on one line, in one `className={…}` expression, or in one template literal), outside the
 * commented allowlist below. It also fails when a studio file imports the pre-Atlas `LABEL`
 * (10 px, 0.05em) instead of OVERLINE. Comments are not class names.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCANNED_DIR = 'components/comicstudio';
const SOURCE_FILE = /\.(tsx?|jsx?|mjs)$/;

/**
 * Small uppercase text that is deliberately NOT an overline, keyed by app-relative path; the value
 * is the exact number of hand-rolled hits the file may contain. Status chips, badges, kbd hints, the
 * wordmark, tab labels and page numbers keep their own styles (as in Atlas wave 8).
 */
const ALLOWLIST: Record<string, { count: number; reason: string }> = {
  'components/comicstudio/breakdown/BreakdownCard.tsx': {
    count: 1,
    // The "Cover" word inside a cover TILE that has no art yet: an aria-hidden miniature of the cover
    // page drawn at tile scale (9 px over a 12 px title in a ~100 px thumbnail), part of the page
    // thumbnail like a page number, not a label in the chrome.
    reason: 'aria-hidden stand-in for the cover inside a page thumbnail, drawn at tile scale'
  }
};

/** `uppercase` as a class (any variant prefix). */
const UPPERCASE = /(?<![\w-])(?:[\w\-[\]&:()>.*]+:)?uppercase(?![\w-])/g;
/** The wide trackings eyebrows are hand-rolled with (any variant prefix). */
const WIDE_TRACKING = /(?<![\w-])(?:[\w\-[\]&:()>.*]+:)?tracking-(?:wider|widest|\[0?\.[^\]\s]*\])(?![\w-])/;

/** Comments blanked out (lengths and line numbers kept), as the Atlas guards do. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[\s;{}(),])\/\/.*$/gm, (match, lead: string) => lead + ' '.repeat(match.length - lead.length));
}

/** The index just past the brace that closes the one opened at `open`. */
function closingBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return i + 1;
  }
  return src.length;
}

/** The spans one class list can live in: each line, each `className={…}` expression, each template literal. */
function classSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let at = 0;
  for (const line of src.split('\n')) {
    spans.push([at, at + line.length]);
    at += line.length + 1;
  }
  for (const m of src.matchAll(/className=\{/g)) {
    const open = m.index! + m[0].length - 1;
    spans.push([open, closingBrace(src, open)]);
  }
  for (const m of src.matchAll(/`(?:[^`\\]|\\.)*`/g)) spans.push([m.index!, m.index! + m[0].length]);
  return spans;
}

/** String and template literals: a class name lives in one (JSX text such as "no uppercase" does not). */
const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

/** Hand-rolled eyebrows: each `uppercase` class (inside a literal) that shares a span with a wide tracking. */
export function findHandRolledOverlines(source: string): Array<{ line: number; snippet: string }> {
  const src = stripComments(source);
  const spans = classSpans(src).filter(([a, b]) => WIDE_TRACKING.test(src.slice(a, b)));
  const literals = [...src.matchAll(LITERAL)].map((m) => [m.index!, m.index! + m[0].length] as const);
  const hits: Array<{ line: number; snippet: string }> = [];
  for (const m of src.matchAll(UPPERCASE)) {
    const i = m.index!;
    if (!literals.some(([a, b]) => i > a && i < b)) continue;
    if (!spans.some(([a, b]) => i >= a && i < b)) continue;
    const lineStart = src.lastIndexOf('\n', i) + 1;
    const lineEnd = src.indexOf('\n', i);
    hits.push({ line: src.slice(0, i).split('\n').length, snippet: src.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim().slice(0, 160) });
  }
  return hits;
}

/** A studio file importing the pre-Atlas LABEL recipe from studioDesign. */
const IMPORTS_LEGACY_LABEL = /import\s*\{[^}]*\bLABEL\b[^}]*\}\s*from\s*['"][^'"]*chat\/studioDesign['"]/;

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listSourceFiles(full));
    else if (SOURCE_FILE.test(entry)) files.push(full);
  }
  return files;
}
const relative = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

describe('overline guard (components/comicstudio/**)', () => {
  it('recognises hand-rolled eyebrows and leaves the recipe, lettering and other uppercase alone', () => {
    const flagged = [
      '<p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Recent</p>',
      '<h4 className="text-[12px] uppercase tracking-widest">Titles</h4>',
      '<span className="text-[10px] font-medium uppercase tracking-[0.18em]">New</span>',
      "const ROW_LABEL = 'block w-[4.25rem] shrink-0 text-[11px] uppercase tracking-[.12em]';",
      "<div className={cx('mb-1.5 text-[11px]',\n  'font-semibold uppercase',\n  'tracking-wider text-[var(--ds-muted)]')}>x</div>",
      'const L = `text-[11px] ${x}\n  sm:uppercase tracking-wider`;'
    ];
    for (const src of flagged) expect(findHandRolledOverlines(src), src).toHaveLength(1);

    const allowed = [
      '<p className={OVERLINE}>Recent</p>',
      "<p className={cx('mb-1', OVERLINE)}>Recent</p>",
      // Script speaker names and wireframe shot labels: uppercase with the normal-wide tracking.
      '<span className="font-semibold uppercase tracking-wide">ANNA:</span>',
      // Lettering case is content (a CSS value, not a class).
      "const CASE = { upper: 'uppercase', lower: 'lowercase' };",
      '<p className="first-letter:uppercase tracking-tight">x</p>',
      '<p className="text-[11px] tracking-wider">no uppercase</p>'
    ];
    for (const src of allowed) expect(findHandRolledOverlines(src), src).toEqual([]);

    // Comments that explain the rule are not class names.
    expect(findHandRolledOverlines('// never `uppercase tracking-wider`: use OVERLINE\nconst a = 1;')).toEqual([]);
    expect(findHandRolledOverlines('{/* not uppercase tracking-wider */}')).toEqual([]);
    expect(IMPORTS_LEGACY_LABEL.test("import { HEADING, LABEL } from '../../chat/studioDesign';")).toBe(true);
    expect(IMPORTS_LEGACY_LABEL.test("import { HEADING, OVERLINE } from '../../chat/studioDesign';")).toBe(false);
    // A file's own local LABEL constant is not the studioDesign one.
    expect(IMPORTS_LEGACY_LABEL.test("const LABEL = 'text-[11.5px]';\nimport { cx } from './ui';")).toBe(false);
  });

  it('finds no hand-rolled small uppercase eyebrow outside the allowlist (use OVERLINE from studioDesign)', () => {
    const offenders: string[] = [];
    const counts = new Map<string, number>();
    const files = listSourceFiles(path.join(ROOT, SCANNED_DIR));
    expect(files.length).toBeGreaterThan(200);
    for (const file of files) {
      const rel = relative(file);
      const hits = findHandRolledOverlines(readFileSync(file, 'utf8'));
      if (hits.length === 0) continue;
      counts.set(rel, hits.length);
      if (ALLOWLIST[rel]?.count === hits.length) continue;
      for (const hit of hits) offenders.push(`${rel}:${hit.line}  ${hit.snippet}`);
    }
    expect(offenders, 'An eyebrow label is OVERLINE (components/chat/studioDesign.ts), keeping the element, its margins and its copy.').toEqual([]);
    // An allowlist entry that no longer matches anything is stale: remove it.
    for (const [file, entry] of Object.entries(ALLOWLIST)) {
      expect(counts.get(file), `${file} is allowlisted for ${entry.count} hand-rolled uppercase labels (${entry.reason})`).toBe(entry.count);
    }
  });

  it('no studio file imports the pre-Atlas LABEL recipe (10 px, 0.05em); eyebrows read OVERLINE', () => {
    const legacy = listSourceFiles(path.join(ROOT, SCANNED_DIR))
      .filter((f) => IMPORTS_LEGACY_LABEL.test(stripComments(readFileSync(f, 'utf8'))))
      .map(relative);
    expect(legacy).toEqual([]);
  });
});
