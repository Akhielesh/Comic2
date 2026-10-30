// @vitest-environment node
/**
 * Overline guard (Atlas wave 8, docs/design/atlas-skin.md "Wave 8 port").
 *
 * Atlas consolidated its hand-rolled small uppercase labels (10–12 px, tracking 0.05–0.22em, mixed
 * weights and colours) onto `.atlas-overline`. Comic Studio's counterpart is the OVERLINE recipe in
 * components/chat/studioDesign.ts (11 px, semibold, leading 1rem, 0.12em, uppercase, muted), so every
 * eyebrow in the studio shares one size, weight, tracking and colour and follows the skin.
 *
 * This fails on any NEW hand-rolled eyebrow in components/comicstudio/**: an `uppercase` class whose
 * class list also spells a wide tracking (`tracking-wide|wider|widest`, any positive arbitrary
 * `tracking-[…]`), or a plain `uppercase` at an eyebrow size (9–12.5 px, `text-xs`) with no tracking
 * class at all, outside the commented allowlist below. A class list is one literal, one template, one
 * `cx(…)` / `clsx(…)` call with its conditionals, or one JSX `{…}` expression, however many lines it
 * spans and wherever it lives (an attribute, a constant): the files are read with TypeScript's parser
 * (tests/config/classLists.ts), so comments, JSX text and code are never mistaken for class names.
 * It also fails when a studio file imports the pre-Atlas `LABEL` (10 px, 0.05em) instead of OVERLINE.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findHandRolledOverlines, matchPinned } from './classLists';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCANNED_DIR = 'components/comicstudio';
const SOURCE_FILE = /\.(tsx?|jsx?|mjs)$/;

/**
 * Small uppercase text that is deliberately NOT an overline, keyed by app-relative path. Each entry
 * pins the exact source lines (trimmed) it permits, not a count: a new hand-rolled eyebrow in an
 * allowlisted file fails even when it replaces an allowed one. Status chips, badges, kbd hints, the
 * wordmark, tab labels and page numbers keep their own styles (as in Atlas wave 8).
 */
const ALLOWLIST: Record<string, { lines: string[]; reason: string }> = {
  'components/comicstudio/breakdown/BreakdownCard.tsx': {
    lines: ['<span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Cover</span>'],
    // The "Cover" word inside a cover TILE that has no art yet: an aria-hidden miniature of the cover
    // page drawn at tile scale (9 px over a 12 px title in a ~100 px thumbnail), part of the page
    // thumbnail like a page number, not a label in the chrome.
    reason: 'aria-hidden stand-in for the cover inside a page thumbnail, drawn at tile scale'
  },
  'components/comicstudio/board/PageScript.tsx': {
    lines: ['<span className="font-semibold uppercase tracking-wide text-[var(--ds-muted)]">{lineSpeakerLabel(doc, l)}:</span>{\' \'}'],
    // The speaker's name opening a line of the script ("ANNA: …"), in the line's own 12 px: script
    // CONTENT set the way a comic script is typed, not a label above a group of controls.
    reason: "script speaker names, part of the script's content in the line's own size"
  },
  'components/comicstudio/timeline/CompareView.tsx': {
    lines: ['<tr className="text-left text-[11px] uppercase tracking-wider text-[var(--ds-muted)]">'],
    // The compare table's column names are the version numbers being compared ("V3", "V5"): table
    // headers that are numbers, which Atlas wave 8 also kept off .atlas-overline (its spreadsheet
    // column letters); Atlas's own tables have no eyebrow headers.
    reason: 'column headers that are version numbers, as Atlas kept spreadsheet column letters off the overline'
  },
  'components/comicstudio/board/ComicPageView.tsx': {
    lines: [
      '<span className="truncate text-[0.85em] font-medium uppercase tracking-wide text-[var(--ds-muted)]">{SHOT_LABEL[panel.shot] || panel.shot}</span>'
    ],
    // The shot type ("CLOSE-UP") written inside a wireframe panel, scaled with the page thumbnail
    // (em-sized): content of the drawn wireframe, like the panel number beside it.
    reason: 'wireframe shot labels drawn inside the page thumbnail at its scale'
  }
};

/** A studio file importing the pre-Atlas LABEL recipe from studioDesign. */
const IMPORTS_LEGACY_LABEL = /import\s*\{[^}]*\bLABEL\b[^}]*\}\s*from\s*['"][^'"]*chat\/studioDesign['"]/;
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(),])\/\/.*$/gm, '$1');

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

/** The hits in one file the allowlist does not permit (`rel:line  snippet`), and its stale pinned lines. */
export function overlineOffenders(rel: string, source: string): { offenders: string[]; stale: string[] } {
  const hits = findHandRolledOverlines(source);
  const { extra, missing } = matchPinned(
    hits.map((h) => h.snippet),
    ALLOWLIST[rel]?.lines
  );
  const offenders: string[] = [];
  for (const snippet of extra) {
    const hit = hits.find((h) => h.snippet === snippet && !offenders.includes(`${rel}:${h.line}  ${snippet}`))!;
    offenders.push(`${rel}:${hit.line}  ${snippet}`);
  }
  return { offenders, stale: missing };
}

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

    // What the regex guard missed (review of wave 8): the normal-wide tracking two converted labels used
    // before the port, a class list in a multi-line cx(…) constant outside className={…}, a multi-line
    // double-quoted JSX attribute, a pixel tracking, and small uppercase with no tracking at all.
    const missedBefore = [
      '<dt className="truncate text-[10.5px] uppercase tracking-wide text-[var(--ds-muted)]">{k}</dt>',
      '<span className="min-w-0 truncate text-[11.5px] font-semibold uppercase tracking-wide text-[var(--ds-muted)]">x</span>',
      "const EYEBROW = cx(\n  'text-[11px] font-semibold',\n  'uppercase',\n  'tracking-wider text-[var(--ds-muted)]'\n);",
      '<p\n  className="text-[11px] font-semibold\n    uppercase tracking-wider"\n>x</p>',
      '<span className="text-[11px] uppercase tracking-[1px]">x</span>',
      '<span className="text-[10.5px] font-semibold uppercase text-[var(--ds-muted)]">x</span>',
      "<span className={cx('text-xs', busy ? 'uppercase' : 'normal-case')}>x</span>"
    ];
    for (const src of missedBefore) expect(findHandRolledOverlines(src), src).toHaveLength(1);

    const allowed = [
      '<p className={OVERLINE}>Recent</p>',
      "<p className={cx('mb-1', OVERLINE)}>Recent</p>",
      // Tracking that is not wide, and a sentence's first capital.
      '<span className="text-[11px] font-semibold uppercase tracking-normal">ANNA:</span>',
      '<p className="text-[11px] first-letter:uppercase">sentence</p>',
      // Uppercase at a reading size (a wordmark, a title) is not an eyebrow.
      '<span className="text-[15px] font-semibold uppercase">Studio</span>',
      // Two class lists: the tracking belongs to another element.
      '<p className="text-[13px] uppercase">a</p><p className="tracking-wider">b</p>',
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

  it('an allowlist entry permits its pinned lines only: a new eyebrow cannot take an allowed one\'s place', () => {
    const rel = 'components/comicstudio/breakdown/BreakdownCard.tsx';
    const source = readFileSync(path.join(ROOT, rel), 'utf8');
    expect(overlineOffenders(rel, source)).toEqual({ offenders: [], stale: [] });
    // The "Cover" word moves onto OVERLINE and, in the same edit, a hand-rolled eyebrow appears: still
    // one hit in the file (a count-based allowlist passed this), now an offender plus a stale entry.
    const allowed = ALLOWLIST[rel].lines[0];
    const swapped = `${source.replace(allowed, '<span className={OVERLINE}>Cover</span>')}\nconst PAGES_EYEBROW = 'text-[11px] font-semibold uppercase tracking-wider';\n`;
    expect(findHandRolledOverlines(swapped)).toHaveLength(1);
    const { offenders, stale } = overlineOffenders(rel, swapped);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain('PAGES_EYEBROW');
    expect(stale).toEqual([allowed]);
  });

  it('finds no hand-rolled small uppercase eyebrow outside the allowlist (use OVERLINE from studioDesign)', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    const files = listSourceFiles(path.join(ROOT, SCANNED_DIR));
    expect(files.length).toBeGreaterThan(200);
    for (const file of files) {
      const rel = relative(file);
      seen.add(rel);
      const result = overlineOffenders(rel, readFileSync(file, 'utf8'));
      offenders.push(...result.offenders);
      // An allowlisted line that no longer matches anything is stale: remove it (or re-pin it).
      expect(result.stale, `${rel}: allowlisted lines no longer hand-rolled (${ALLOWLIST[rel]?.reason})`).toEqual([]);
    }
    expect(offenders, 'An eyebrow label is OVERLINE (components/chat/studioDesign.ts), keeping the element, its margins and its copy.').toEqual([]);
    for (const file of Object.keys(ALLOWLIST)) expect(seen.has(file), `${file} is allowlisted but no longer exists`).toBe(true);
  });

  it('no studio file imports the pre-Atlas LABEL recipe (10 px, 0.05em); eyebrows read OVERLINE', () => {
    const legacy = listSourceFiles(path.join(ROOT, SCANNED_DIR))
      .filter((f) => IMPORTS_LEGACY_LABEL.test(stripComments(readFileSync(f, 'utf8'))))
      .map(relative);
    expect(legacy).toEqual([]);
  });
});
