// @vitest-environment node
// Golden: every layout sentence the code and the fixtures produce reads exactly as it did before the blueprint
// geometry learned the inset clause (B9 FIX amendment; pageGeometry.parseLayout / estimatePanelBoxes). Only sentences
// that carry the clause B9's layoutText writes ("with a small inset panel in its lower right corner (panel 2)") may
// read differently — that is the change.
//
// The corpus: the page templates (both reading directions), synthesizeLayout over every size sequence of 1–5 panels
// (and a fixed stride of the 6-panel ones) for every kind and direction, layoutTextOf over the estimated boxes of each
// synthesized page of up to 4 panels (the sentence B9 derives from frames), and every layout-like string literal in
// the app's source and JSON fixtures (the fixture docs, the golden scenarios, the tests). For each sentence the golden
// pins a hash of what the layout readers make of it: parseLayout, layoutPanelCount, estimatePanelBoxes (three kinds ×
// two directions, the inferred direction, and one panel too many), effectiveLayout, harmonizePanelSizes,
// layoutConflicts, framesFromLayoutText and layoutTextFits. The generated sentences are kept in 256 buckets (by
// sentence hash) so the file stays small, and a failing bucket lists its sentences; the literal ones are kept one by
// one (a literal added later is not in the golden and is skipped). The golden was written by the code before the inset
// change (LAYOUT_GOLDEN_WRITE=1 rewrites it — never do that to make this test pass).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComicKind, Page, Panel, PanelSize } from '../../../shared/comic/doc.js';
import { framesFromLayoutText, layoutTextFits, layoutTextOf } from '../../../shared/comic/editor/layoutText.js';
import { PAGE_TEMPLATES, templateLayout } from '../../../shared/comic/editor/templates.js';
import { hashString, stableStringify } from '../../../shared/comic/hash.js';
import * as geo from '../../../shared/comic/pageGeometry.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..', '..', '..');
const GOLDEN_PATH = join(here, '__fixtures__', 'layoutSentences.golden.json');

const SIZES: PanelSize[] = ['small', 'medium', 'large', 'wide', 'tall', 'splash'];
const KINDS: ComicKind[] = ['comic', 'manga', 'webtoon', 'strip', 'storybook'];
const DIRS = ['ltr', 'rtl'] as const;
/** The inset clause exactly as layoutText writes it (shared/comic/editor/layoutText.ts INSET_RE). */
const INSET_CLAUSE_RE = /with an? small inset panel in (?:its|the) (?:upper|lower) (?:left|right) corner(?: of panel \d+)? \(panel \d+\)/i;

const panelsOf = (sizes: PanelSize[]): Panel[] =>
  sizes.map((size, i) => ({ id: `p${i}`, n: i + 1, size, shot: 'medium', action: '', castIds: [], lines: [] }));
const pageOf = (layout: string, panels: Panel[]): Pick<Page, 'panels' | 'layout'> => ({ layout, panels });

function* sequences(n: number): Generator<PanelSize[]> {
  const idx = new Array(n).fill(0);
  for (;;) {
    yield idx.map((i) => SIZES[i]);
    let k = n - 1;
    while (k >= 0 && idx[k] === SIZES.length - 1) idx[k--] = 0;
    if (k < 0) return;
    idx[k] += 1;
  }
}

/** String literals in the app that read as a layout sentence (the fixture docs, the golden scenarios, the tests). */
const literalSentences = (): string[] => {
  const out = new Set<string>();
  const roots = ['shared', 'server/src', 'components', 'qa', 'tests'].map((r) => join(appRoot, r)).filter(existsSync);
  const lit = /(['"`])((?:Rows?\s*\d|One full-page|A single full-page|Full-page splash|Stacked vertically|Panels stacked vertically)(?:(?!\1)[^\\\n]|\\.)*)\1/g;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|json)$/.test(name) && p !== GOLDEN_PATH) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(lit)) if (!m[2].includes('${')) out.add(m[2].replace(/\\(['"`\\])/g, '$1'));
      }
    }
  };
  for (const r of roots) walk(r);
  return [...out];
};

/** Every layout sentence the code produces (templates, synthesized, derived) and the fixtures' literal ones. */
const layoutCorpus = (): { generated: string[]; literals: string[] } => {
  const out = new Set<string>();
  for (const t of PAGE_TEMPLATES) {
    out.add(t.sentence);
    out.add(templateLayout(t, { rtl: true }).sentence);
  }
  const synthesized = new Set<string>();
  for (let n = 1; n <= 6; n++) {
    let k = 0;
    for (const sizes of sequences(n)) {
      if (n === 6 && k++ % 7) continue;
      const panels = panelsOf(sizes);
      for (const kind of KINDS) for (const readingDirection of DIRS) synthesized.add(geo.synthesizeLayout(panels, { kind, readingDirection }));
    }
  }
  for (const s of synthesized) {
    out.add(s);
    // The sentence B9 derives from frames: layoutTextOf over the estimated boxes of each synthesized page.
    const n = geo.layoutPanelCount(geo.parseLayout(s));
    if (!n || n > 4) continue;
    const panels = panelsOf(new Array(n).fill('medium'));
    const kind: ComicKind = /stacked vertically/i.test(s) ? 'webtoon' : 'comic';
    for (const readingDirection of DIRS) {
      const boxes = geo.estimatePanelBoxes(pageOf(s, panels), { kind, readingDirection });
      out.add(layoutTextOf(boxes, { rtl: readingDirection === 'rtl', kind }));
    }
  }
  out.delete('');
  const literals = literalSentences().filter((s) => s && !out.has(s));
  return { generated: [...out].sort(), literals: literals.sort() };
};

/** What the layout readers make of a sentence, hashed. */
const readingOf = (s: string): string => {
  const parsed = geo.parseLayout(s);
  const count = geo.layoutPanelCount(parsed);
  const out: Record<string, unknown> = { parsed, count };
  const n = Math.max(1, Math.min(count || 3, 12));
  const panels = panelsOf(new Array(n).fill('medium'));
  const mixed = panelsOf(Array.from({ length: n }, (_, i) => SIZES[i % SIZES.length]));
  out.auto = geo.estimatePanelBoxes(pageOf(s, panels));
  for (const kind of ['comic', 'webtoon', 'strip'] as const) {
    for (const readingDirection of DIRS) {
      out[`boxes:${kind}:${readingDirection}`] = geo.estimatePanelBoxes(pageOf(s, panels), { kind, readingDirection });
      out[`effective:${kind}:${readingDirection}`] = geo.effectiveLayout(pageOf(s, mixed), { kind, readingDirection });
    }
  }
  // One panel more than the sentence describes: the estimate falls back (synthesized, then a grid).
  out.more = geo.estimatePanelBoxes(pageOf(s, panelsOf(new Array(n + 1).fill('medium'))), { kind: 'comic', readingDirection: 'ltr' });
  if (parsed) {
    out.harmonized = DIRS.map((d) => geo.harmonizePanelSizes(mixed, parsed, d === 'rtl').map((p) => p.size));
    out.conflicts = geo.layoutConflicts(parsed, mixed);
  }
  out.frames = DIRS.map((d) => framesFromLayoutText(s, n, { rtl: d === 'rtl' }));
  out.fits = layoutTextFits(s, n);
  return hashString(stableStringify(out));
};

interface Golden {
  /** The commit whose code wrote it. */
  base: string;
  /** Generated sentences without the inset clause. */
  count: number;
  /** Bucket (first two hex digits of hashString(sentence)) → hashString of its sorted "sentenceHash:readingHash" lines. */
  buckets: Record<string, string>;
  /** Literal sentences (fixtures, tests) without the inset clause: hashString(sentence) → reading. */
  literals: Record<string, string>;
  /** Generated sentences with the inset clause (allowed to read differently): hashString(sentence) → old reading. */
  insets: Record<string, string>;
}

const bucketsOf = (sentences: string[], reading: (s: string) => string): Record<string, string> => {
  const lines = new Map<string, string[]>();
  for (const s of sentences) {
    const h = hashString(s);
    const b = h.slice(0, 2);
    if (!lines.has(b)) lines.set(b, []);
    lines.get(b)!.push(`${h}:${reading(s)}`);
  }
  return Object.fromEntries([...lines.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([b, l]) => [b, hashString(l.sort().join('\n'))]));
};

describe('golden: every layout sentence reads as before the inset clause', () => {
  const { generated, literals } = layoutCorpus();
  const plain = generated.filter((s) => !INSET_CLAUSE_RE.test(s));
  const insets = generated.filter((s) => INSET_CLAUSE_RE.test(s));
  const plainLiterals = literals.filter((s) => !INSET_CLAUSE_RE.test(s));

  it('the corpus is broad (templates, synthesized, derived and fixture sentences)', () => {
    expect(generated.length).toBeGreaterThan(4000);
    expect(plainLiterals.length).toBeGreaterThan(20);
    expect(generated).toEqual(expect.arrayContaining([PAGE_TEMPLATES[0].sentence, 'Row 1: two equal panels side by side (panels 1–2). Row 2: two equal panels side by side (panels 3–4).']));
    expect(plainLiterals).toEqual(expect.arrayContaining(['Row 1: one wide panel. Row 2: two equal panels.']));
    expect(insets.length).toBeGreaterThan(0);
  });

  if (process.env.LAYOUT_GOLDEN_WRITE === '1') {
    it('writes the golden (LAYOUT_GOLDEN_WRITE=1)', () => {
      const golden: Golden = {
        base: process.env.LAYOUT_GOLDEN_BASE || 'unknown',
        count: plain.length,
        buckets: bucketsOf(plain, readingOf),
        literals: Object.fromEntries(plainLiterals.map((s) => [hashString(s), readingOf(s)])),
        insets: Object.fromEntries(insets.map((s) => [hashString(s), readingOf(s)]))
      };
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(golden, null, 1)}\n`);
    }, 120_000);
    return;
  }

  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;

  it('every generated sentence without the inset clause reads exactly as the golden', () => {
    // A new generated sentence (a new template, a synthesizer change) also changes its bucket: re-run this file with
    // LAYOUT_GOLDEN_WRITE=1 at the commit BEFORE the change that adds it, never at the change itself.
    expect(plain.length).toBe(golden.count);
    const now = bucketsOf(plain, readingOf);
    const bad = Object.keys({ ...golden.buckets, ...now }).filter((b) => golden.buckets[b] !== now[b]);
    const suspects = plain.filter((s) => bad.includes(hashString(s).slice(0, 2)));
    expect(bad.length ? suspects.slice(0, 40) : []).toEqual([]);
  }, 120_000);

  it('every literal sentence (fixtures, tests) without the inset clause reads exactly as the golden', () => {
    const known = plainLiterals.filter((s) => golden.literals[hashString(s)]);
    expect(known.length).toBeGreaterThanOrEqual(Math.min(20, Object.keys(golden.literals).length));
    expect(known.filter((s) => golden.literals[hashString(s)] !== readingOf(s))).toEqual([]);
  });

  it('only the inset sentences read differently, and they now name their inset and its host', () => {
    expect(insets.map(hashString).sort()).toEqual(Object.keys(golden.insets).sort());
    for (const s of insets) {
      expect(readingOf(s), s).not.toBe(golden.insets[hashString(s)]);
      expect(geo.parseLayout(s)!.insets?.length, s).toBeGreaterThan(0);
    }
  });
});
