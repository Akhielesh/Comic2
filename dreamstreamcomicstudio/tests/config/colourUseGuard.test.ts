// @vitest-environment node
/**
 * Colour-use guard for the colour layer "Ink, Paper & Colour" (CL-6; docs/design/design-system.md § Colour layer).
 * Text stays ink on paper, buttons that spend stay ink, colour never replaces a word and never nudges spending.
 * The detector reads each file's syntax tree (TypeScript's parser, the same price detector as sparkGuard.test.ts:
 * tests/config/priceDetect.ts), so a comment or a sentence never counts. The rules:
 *
 *   1. NO HUE AS TEXT. `text-[var(--ds-hue-N)]` (the mark itself, 3.1 to 4.7:1) or `text-ds-hue-N` never colours
 *      text: words in a hue use HUE_TEXT (the -text step, ≥ 4.5:1), and only on slots 1, 5 and 7; on slots 2, 3, 4 and 6
 *      the text step is for an icon (it sits near a status colour), so an element carrying it holds no words.
 *   2. NEVER ON OR BESIDE A PRICE OR A SPEND CONTROL. No hue, tint, solid, studio accent, wash or art tint on an element
 *      that holds a price, beside one (a sibling element), or on a control whose own label starts with Approve, Draw,
 *      Redraw, Translate or Get more. One exception, the owner's decision "colour on usage and spend charts, for the
 *      charts only, starting at magenta, no blue next to money": a CHART MARK (an SVG fill or stroke, judged by the <svg>
 *      it draws in) may sit beside a price, except slot 1 (ultramarine) and the two ramps (both ultramarine family).
 *   3. WASHES ONLY WHERE THEY BELONG. WASH_HERO / WASH_EMPTY (and any --ds-wash-*) only in WASH_FILES, at most one
 *      element per file and never inside a list: a hero or an empty state, never a working view.
 *   4. NO WORDS ON A SOLID WHITE CAN'T CARRY. HUE_SOLID on slots 2, 3, 4 and 7 (white on them is 3.4 to 4.4:1 in light)
 *      holds an icon only; a solid picked by a computed index holds no words either (the slot is not known here).
 *   5. INK NAVIGATION. The panel and navigation (sparkGuard's INK_ONLY) take no ultramarine (hue 1 is the spark's
 *      family) and no wash; the studio accent's 2 px marker is the one colour allowed there.
 *   6. NO COLOUR LAYER IN THE READER. components/comicstudio/{reader,immersive}/** read no hue, tint, solid, ramp,
 *      wash, studio or art-scope token, their CSS included (the comic page keeps --ds-reader-*; the art is the colour).
 *   7. NO HUE BUTTON. No Button variant reads a colour-layer token (primary buttons stay ink; the spark is the one
 *      coloured fill, sparkGuard.test.ts).
 * A chart mark on slot 1 is not a spark fill: the spark rule counts controls, tiles and rings, not marks.
 * Specimens (the colour specimen and the gallery scenes) may show every wash; rules 1, 2 and 4 still hold there.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { BUTTON_VARIANT } from '../../components/ds/Button';
import { APP_ROOT, listScannedFiles, matchesGlob, REAL_TREE_TIMEOUT, tempTree } from './classLists';
import { costNamesOf, elementOf, isStringy, labelsOf, parse, priceIn, siblingsOf, SPEND_LABEL, textOf } from './priceDetect';

/** Where hero and empty-state washes may go (rule 3): one element per file. CL-10 puts the hero wash on the landing. */
export const WASH_FILES: Record<string, string> = {
  'components/comicshost/ComicsLanding.tsx': 'the comics landing hero (CL-10): one wash behind the headline and the drawn pages'
};
/** Files that show the layer as specimens (rule 3 does not apply; rules 1, 2, 4 do). */
export const SPECIMENS: readonly string[] = ['components/ds/specimens/**', 'qa/app/scenes/colour-layer.tsx', 'qa/app/scenes/ds-gallery.tsx'];
/** Where the recipes are defined, not used. */
const DEFINITIONS: readonly string[] = ['components/chat/studioDesign.ts', 'components/ds/recipes.ts'];
/** sparkGuard's ink-only navigation, and its no-spark reader. */
const INK_ONLY: readonly string[] = ['components/nav/**', 'components/chat/ChatSidebar.tsx', '**/NavRail.tsx', '**/TabBar.tsx', '**/PlaceNav.tsx'];
const NO_COLOUR: readonly string[] = ['components/comicstudio/reader/**', 'components/comicstudio/immersive/**'];

// ── The detector ──────────────────────────────────────────────────────────────────────────────────

/** A colour-layer token in a literal (CSS var or named ds colour). The ink chart steps and the spark are not this layer. */
const LAYER_TOKEN = /--ds-(?:hue-\d(?:-(?:text|soft|solid))?|on-hue|studio(?:-soft)?|wash-[\w]+|art-(?:soft|edge|glow)|chart-(?:seq|div)-\d)(?![\w-])|(?<![\w-])(?:[\w\-[\]&:()>.*/@]+:)?(?:bg|text|border|outline|ring|fill|stroke|shadow|from|via|to|decoration)-ds-(?:hue-\d|on-hue|studio|art-(?:soft|edge)|chart-(?:seq|div))|(?<![\w-])ds-art-scope(?![\w-])/;
/** The mark itself as a text colour (rule 1). */
const HUE_AS_TEXT = /(?<![\w-])(?:[\w\-[\]&:()>.*/@]+:)?text-(?:\[(?:color:)?var\(--ds-hue-\d\)\]|ds-hue-\d(?![\w-]))/;
/** A text step as a literal class, by slot. */
const HUE_TEXT_LITERAL = /text-\[var\(--ds-hue-(\d)-text\)\]/;
/** A solid as a literal class, by slot. */
const HUE_SOLID_LITERAL = /bg-\[var\(--ds-hue-(\d)-solid\)\]/;
/** An SVG mark (rule 2's chart exception). */
const MARK_LITERAL = /(?<![\w-])(?:fill|stroke)-\[var\(--ds-(?:hue-\d|chart-seq-\d)\)\]/;
const WASH_LITERAL = /--ds-wash-|bg-\[image:var\(--ds-wash/;

/** The recipes, by what they paint. */
const MARK_RECIPES = new Set(['HUE_FILL', 'HUE_STROKE', 'CHART_SEQ_FILL', 'CHART_DIV_FILL']);
const COLOUR_RECIPES = new Set(['HUE_DOT', 'HUE_FILL', 'HUE_STROKE', 'HUE_MARK', 'HUE_TEXT', 'HUE_SOFT_BG', 'HUE_SOLID', 'hueChip', 'hueClass', 'chartHue', 'CHART_SEQ_FILL', 'CHART_SEQ_BG', 'CHART_DIV_FILL', 'CHART_DIV_BG', 'WASH_HERO', 'WASH_EMPTY', 'ART_SCOPE', 'ART_SOFT_BG', 'ART_EDGE', 'STUDIO_SOFT_BG', 'STUDIO_MARK']);
const WASH_RECIPES = new Set(['WASH_HERO', 'WASH_EMPTY']);
const SLOTTED = new Set(['HUE_DOT', 'HUE_FILL', 'HUE_STROKE', 'HUE_TEXT', 'HUE_SOFT_BG', 'HUE_SOLID']);

export interface ColourUse {
  line: number;
  token: string;
  /** An SVG chart mark (rule 2's exception). */
  mark: boolean;
  /** Reads hue slot 1 (ultramarine) or the diverging ramp; null when the slot is computed. */
  blue: boolean | null;
  wash: boolean;
  /** HUE_SOLID / HUE_TEXT slot, when known; 0 = computed. */
  solidSlot?: number;
  textSlot?: number;
  hueAsText: boolean;
  text: string;
  node: ts.Node;
}

/** The literal number an element access or call argument holds, or null when it is computed. */
const literalIndex = (n: ts.Expression | undefined): number | null => (n && ts.isNumericLiteral(n) ? Number(n.text) : null);
const nameOf = (n: ts.Node): string | null => (ts.isIdentifier(n) ? n.text : ts.isPropertyAccessExpression(n) && /^(?:design|recipes|ds)$/.test(n.expression.getText()) ? n.name.text : null);
const isDeclName = (n: ts.Node) => {
  const p = n.parent;
  return !!p && ((ts.isVariableDeclaration(p) && p.name === n) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || (ts.isPropertyAssignment(p) && p.name === n));
};

/** Every colour-layer use in a source. */
export function colourUses(source: string, fileName = 'file.tsx'): ColourUse[] {
  const sf = parse(source, fileName);
  const lines = source.split('\n');
  const out: ColourUse[] = [];
  const add = (node: ts.Node, u: Omit<ColourUse, 'line' | 'text' | 'node'>) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    out.push({ ...u, line, text: (lines[line - 1] ?? '').trim(), node });
  };
  const visit = (node: ts.Node) => {
    const name = nameOf(node);
    if (name && COLOUR_RECIPES.has(name) && !isDeclName(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && name !== 'HUE_MARK')) {
      const parent = node.parent;
      let token = name;
      let mark = MARK_RECIPES.has(name);
      // Both ramps are in the ultramarine family (the sequential ramp is one ultramarine; the diverging one ends in it).
      let blue: boolean | null = /^CHART_(?:SEQ|DIV)/.test(name) ? true : null;
      let slot: number | null = null;
      if (SLOTTED.has(name) && ts.isElementAccessExpression(parent) && parent.expression === node) {
        const i = literalIndex(parent.argumentExpression);
        slot = i === null ? 0 : i + 1;
        token = `${name}[${i ?? '…'}]`;
      } else if (name === 'HUE_MARK' && ts.isPropertyAccessExpression(parent)) {
        mark = parent.name.text !== 'dot';
        token = `HUE_MARK.${parent.name.text}`;
        const access = parent.parent;
        if (ts.isElementAccessExpression(access)) {
          const i = literalIndex(access.argumentExpression);
          slot = i === null ? 0 : i + 1;
        }
      } else if ((name === 'chartHue' || name === 'hueClass' || name === 'hueChip') && ts.isCallExpression(parent)) {
        const [kind, index] = name === 'hueChip' ? [undefined, parent.arguments[0]] : parent.arguments;
        mark = !!kind && isStringy(kind) && kind.text !== 'dot';
        const i = literalIndex(index as ts.Expression | undefined);
        // chartHue's series 0 and hueClass's index 0 and hueChip(0) all read slot 1.
        slot = i === null ? 0 : i === 0 ? 1 : 2;
        token = `${name}(${parent.arguments.map((a) => a.getText(sf)).join(', ')})`;
      } else if (SLOTTED.has(name) || name === 'HUE_MARK' || name === 'chartHue' || name === 'hueClass' || name === 'hueChip') {
        slot = 0; // spread, mapped or passed on: every slot, the first included
      }
      if (slot !== null && blue === null) blue = slot === 0 ? null : slot === 1;
      if (blue === null && slot === null) blue = false;
      add(node, {
        token,
        mark,
        blue,
        wash: WASH_RECIPES.has(name),
        solidSlot: name === 'HUE_SOLID' ? (slot ?? 0) : undefined,
        textSlot: name === 'HUE_TEXT' ? (slot ?? 0) : undefined,
        hueAsText: false
      });
    } else if (isStringy(node) || ts.isTemplateExpression(node) || ts.isJsxText(node)) {
      const text = ts.isJsxText(node) ? '' : node.getText(sf);
      if (text && (LAYER_TOKEN.test(text) || HUE_AS_TEXT.test(text))) {
        const solid = HUE_SOLID_LITERAL.exec(text);
        const words = HUE_TEXT_LITERAL.exec(text);
        add(node, {
          token: `literal:${(LAYER_TOKEN.exec(text) ?? HUE_AS_TEXT.exec(text))![0]}`,
          mark: MARK_LITERAL.test(text) && !/(?<![\w-])(?:bg|text|border)-/.test(text.replace(MARK_LITERAL, '')),
          blue: /--ds-hue-1(?![\d])|--ds-chart-(?:div|seq)-/.test(text),
          wash: WASH_LITERAL.test(text),
          solidSlot: solid ? Number(solid[1]) : undefined,
          textSlot: words ? Number(words[1]) : undefined,
          hueAsText: HUE_AS_TEXT.test(text)
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The <svg> element a chart mark draws in, if any. */
function svgOf(el: ts.Node): ts.JsxElement | null {
  for (let n: ts.Node | undefined = el; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText() === 'svg') return n;
  }
  return null;
}

/** Whether an element (or anything inside it) says words: text, a string, or an expression that is not an element. */
function holdsWords(el: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  if (!ts.isJsxElement(el)) return false;
  if (textOf(el.children).replace(/\s+/g, '').length > 0) return true;
  const visit = (n: ts.Node): boolean => {
    if (ts.isJsxExpression(n) && n.expression && !ts.isJsxElement(n.expression) && !ts.isJsxSelfClosingElement(n.expression) && !ts.isConditionalExpression(n.expression) && !ts.isBinaryExpression(n.expression)) return true;
    if (ts.isJsxElement(n)) return n.children.some(visit);
    return false;
  };
  return el.children.some(visit);
}

/** The list call a node renders inside (`.map()`, `.flatMap()`, `Array.from(…, fn)`), or null. */
function inList(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n && !ts.isSourceFile(n); n = n.parent) {
    if (!(ts.isArrowFunction(n) || ts.isFunctionExpression(n))) continue;
    const call = n.parent;
    if (call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && ['map', 'flatMap'].includes(call.expression.name.text)) return true;
  }
  return false;
}

export interface GuardResult {
  scanned: number;
  violations: string[];
}

/** The rules over one source (rules 1, 2, 4 everywhere; 3, 5, 6 by path). */
export function checkColourSource(rel: string, source: string, opts: { washFiles?: Record<string, string>; specimens?: readonly string[] } = {}): string[] {
  const washFiles = opts.washFiles ?? WASH_FILES;
  const specimens = opts.specimens ?? SPECIMENS;
  if (matchesGlob(rel, DEFINITIONS)) return [];
  const uses = colourUses(source, rel);
  if (!uses.length) return [];
  const v: string[] = [];
  if (matchesGlob(rel, NO_COLOUR)) {
    for (const u of uses) v.push(`${rel}:${u.line}: the reader takes no colour-layer token (${u.token}) — the comic page keeps --ds-reader-* — ${u.text}`);
    return v;
  }
  for (const u of uses) {
    if (u.hueAsText) v.push(`${rel}:${u.line}: a hue mark as a text colour (${u.token}) — words use HUE_TEXT (the -text step), on slots 1, 5 and 7 only — ${u.text}`);
    const el = elementOf(u.node);
    if (el) {
      const sfOf = el.getSourceFile();
      const names = costNamesOf(sfOf);
      // A chart mark is judged by its chart: the <svg> it draws in, and what sits beside that.
      const at = (u.mark ? svgOf(el) : null) ?? el;
      const price = priceIn(at, sfOf, names) ?? siblingsOf(at).map((s) => priceIn(s, sfOf, names)).find(Boolean) ?? null;
      if (price && (!u.mark || u.blue !== false)) {
        v.push(`${rel}:${u.line}: colour (${u.token}) on or beside a price (${price}) — prices and spend controls stay ink${u.mark ? '; a chart mark beside money starts at magenta, never ultramarine' : ''} — ${u.text}`);
      }
      const spend = labelsOf(el).find((l) => SPEND_LABEL.test(l));
      if (spend && !u.mark) v.push(`${rel}:${u.line}: colour (${u.token}) on a spend control (${JSON.stringify(spend)}) — Approve, Draw, Redraw, Translate and Get more stay ink — ${u.text}`);
      if (u.solidSlot !== undefined && (u.solidSlot === 0 || [2, 3, 4, 7].includes(u.solidSlot)) && holdsWords(el)) {
        v.push(`${rel}:${u.line}: words inside HUE_SOLID on ${u.solidSlot ? `slot ${u.solidSlot}` : 'a computed slot'} (${u.token}) — white on it is under 4.5:1 in light: an icon only, or slots 1, 5, 6 — ${u.text}`);
      }
      if (u.textSlot !== undefined && (u.textSlot === 0 || ![1, 5, 7].includes(u.textSlot)) && holdsWords(el)) {
        v.push(`${rel}:${u.line}: coloured words in HUE_TEXT on ${u.textSlot ? `slot ${u.textSlot}` : 'a computed slot'} (${u.token}) — coloured text only on slots 1, 5 and 7 (the rest sit near a status colour); an icon is fine — ${u.text}`);
      }
    }
  }
  const washes = uses.filter((u) => u.wash);
  if (washes.length && !matchesGlob(rel, specimens)) {
    if (!(rel in washFiles)) for (const u of washes) v.push(`${rel}:${u.line}: a wash (${u.token}) outside the hero and empty-state files (${'WASH_FILES'}) — never a working view — ${u.text}`);
    else {
      const elements = new Set(washes.map((u) => elementOf(u.node) ?? u.node));
      if (elements.size > 1) v.push(`${rel}: ${elements.size} washes in one file — one wash per page (lines ${washes.map((u) => u.line).join(', ')})`);
      for (const u of washes) if (inList(u.node)) v.push(`${rel}:${u.line}: a wash inside a list renders one per item — ${u.text}`);
    }
  }
  if (matchesGlob(rel, INK_ONLY)) {
    for (const u of uses) {
      if (u.wash) v.push(`${rel}:${u.line}: navigation takes no wash — ${u.text}`);
      else if (u.blue !== false && !/STUDIO_|--ds-studio/.test(u.token)) v.push(`${rel}:${u.line}: navigation takes no ultramarine (hue 1 is the spark's family; ${u.token}) — only the studio marker — ${u.text}`);
    }
  }
  return v;
}

const SOURCE_EXT = /\.(?:tsx?|jsx?|mjs)$/;
function cssUnder(root: string, globs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const full = path.join(root, rel);
    if (!existsSync(full)) return;
    if (statSync(full).isDirectory()) for (const e of readdirSync(full)) walk(`${rel}/${e}`);
    else if (rel.endsWith('.css') && matchesGlob(rel, globs)) out.push(rel);
  };
  walk('components');
  return out.sort();
}

/** Every rule over the scanned tree under `root` (the app, or a temp tree in the tests below). */
export function checkColourTree(root = APP_ROOT, opts: { washFiles?: Record<string, string>; specimens?: readonly string[] } = {}): GuardResult {
  const files = listScannedFiles({ root }).filter((f) => SOURCE_EXT.test(f));
  const violations: string[] = [];
  for (const rel of files) {
    const source = readFileSync(path.join(root, rel), 'utf8');
    if (!/ds-(?:hue|on-hue|studio|wash|art-|chart-seq|chart-div)|HUE_|hueC|chartHue|CHART_(?:SEQ|DIV)|WASH_|ART_(?:SCOPE|SOFT|EDGE)|STUDIO_/.test(source)) continue;
    violations.push(...checkColourSource(rel, source, opts));
  }
  for (const rel of cssUnder(root, NO_COLOUR)) {
    const css = readFileSync(path.join(root, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (LAYER_TOKEN.test(css)) violations.push(`${rel}: the reader takes no colour-layer token (CSS)`);
  }
  for (const rel of Object.keys(opts.washFiles ?? WASH_FILES)) if (!existsSync(path.join(root, rel))) violations.push(`${rel}: listed in WASH_FILES but missing`);
  return { scanned: files.length, violations };
}

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────────

const PRICE_ROW = (inner: string) => `export const P = ({ fmt }) => (\n  <div>\n    ${inner}\n    <span>{formatUsd(0.04)}</span>\n  </div>\n);\n`;
const check = (src: string, rel = 'components/x/X.tsx', opts?: Parameters<typeof checkColourSource>[2]) => checkColourSource(rel, src, opts);

describe('colour-use guard — the detector', () => {
  it('finds every spelling: recipes (indexed, called, spread), literal tokens, named ds colours and the art scope', () => {
    const src = [
      'export const A = () => <span className={HUE_SOFT_BG[1]}>Cast</span>;',
      'export const B = () => <span className={hueChip(2)}>Style</span>;',
      'export const C = () => <rect className={chartHue("fill", 0)} />;',
      'export const D = () => <span className="bg-[var(--ds-hue-6-soft)]">x</span>;',
      'export const E = () => <span className="bg-ds-hue-7">x</span>;',
      'export const F = () => <div className={WASH_HERO} />;',
      'export const G = () => <div className="ds-art-scope" />;',
      'export const H = () => <rect className={HUE_MARK.fill[3]} />;'
    ].join('\n');
    expect(colourUses(src).map((u) => `${u.token}${u.mark ? ' mark' : ''}${u.blue ? ' blue' : ''}${u.wash ? ' wash' : ''}`)).toEqual([
      'HUE_SOFT_BG[1]',
      'hueChip(2)',
      'chartHue("fill", 0) mark blue',
      'literal:--ds-hue-6-soft',
      'literal:bg-ds-hue-7',
      'WASH_HERO wash',
      'literal:ds-art-scope',
      'HUE_MARK.fill mark'
    ]);
  });

  it('ignores the ink system, the spark and what only looks like the layer (comments, words, the ink chart steps)', () => {
    const src = [
      '// HUE_SOLID on a price would fail; this comment does not',
      'export const A = () => <span className="bg-[var(--ds-chart-2)] text-[var(--ds-ink)]">Hue and colour</span>;',
      'export const B = () => <span className="bg-[var(--ds-spark)]">New comic</span>;',
      'export const C = () => <span className="bg-[var(--ds-hue)] text-hue-1">x</span>;'
    ].join('\n');
    expect(colourUses(src)).toEqual([]);
  });
});

describe('colour-use guard — the rules on one file', () => {
  it('rule 1: a hue mark as a text colour fails; the text step on slots 1, 5, 7 passes; on 2, 3, 4, 6 only as an icon', () => {
    expect(check('export const A = () => <p className="text-[var(--ds-hue-2)]">Cast</p>;').join()).toMatch(/hue mark as a text colour/);
    expect(check('export const A = () => <p className="text-ds-hue-3">Cast</p>;').join()).toMatch(/hue mark as a text colour/);
    expect(check('export const A = () => <p className={HUE_TEXT[0]}>Story</p>;')).toEqual([]);
    expect(check('export const A = () => <p className={HUE_TEXT[6]}>Read</p>;')).toEqual([]);
    expect(check('export const A = () => <p className={HUE_TEXT[1]}>Cast</p>;').join()).toMatch(/coloured words in HUE_TEXT on slot 2/);
    expect(check('export const A = () => <span className={HUE_TEXT[1]}><Users aria-hidden /></span>;')).toEqual([]);
    expect(check('export const A = () => <p className="text-[var(--ds-hue-4-text)]">Pages</p>;').join()).toMatch(/slot 4/);
  });

  it('rule 2: colour on or beside a price fails (a tint, a chip, a solid, a studio tint, the art tint)', () => {
    for (const inner of ['<span className={HUE_SOFT_BG[2]}>Pages</span>', '<span className={hueChip(1)}>Cast</span>', '<b className={HUE_SOLID[0]}><Star /></b>', '<i className={STUDIO_SOFT_BG} />', '<i className={ART_SOFT_BG} />']) {
      expect(check(PRICE_ROW(inner)).join(), inner).toMatch(/beside a price \(formatUsd\(\)\)/);
    }
    // In the same element as the price, too, and a CostFormat method counts.
    expect(check('export const P = () => { const fmt = useCostFormat(); return <span className={HUE_SOFT_BG[3]}>{fmt.badge(0.2)}</span>; };').join()).toMatch(/fmt\.badge\(\)/);
    // A cousin (not a sibling) is fine.
    expect(check('export const P = () => (<div><section><span className={HUE_SOFT_BG[2]}>Pages</span></section><section><span>{formatUsd(1)}</span></section></div>);')).toEqual([]);
  });

  it('rule 2: a spend control takes no colour, price or not (Approve, Draw, Redraw, Translate, Get more)', () => {
    expect(check('export const A = () => <button className={HUE_SOLID[0]}>Approve</button>;').join()).toMatch(/spend control \("Approve"\)/);
    expect(check('export const A = () => <button className={STUDIO_SOFT_BG} aria-label="Get more pictures"><Plus /></button>;').join()).toMatch(/spend control/);
    expect(check('export const A = () => <button className={HUE_SOLID[0]}><Star aria-hidden /></button>;')).toEqual([]);
  });

  it('rule 2: a chart mark may sit beside a price (spend charts start at magenta), but never slot 1 or the diverging ramp', () => {
    expect(check(PRICE_ROW('<svg><rect className={chartHue("fill", 1)} /></svg>'))).toEqual([]);
    expect(check(PRICE_ROW('<svg><rect className={HUE_MARK.fill[1]} /></svg>'))).toEqual([]);
    expect(check(PRICE_ROW('<svg><rect className="fill-[var(--ds-hue-2)]" /></svg>'))).toEqual([]);
    expect(check(PRICE_ROW('<svg><rect className={chartHue("fill", 0)} /></svg>')).join()).toMatch(/never ultramarine/);
    expect(check(PRICE_ROW('<svg><rect className="fill-[var(--ds-hue-1)]" /></svg>')).join()).toMatch(/never ultramarine/);
    expect(check(PRICE_ROW('<svg><rect className={CHART_DIV_FILL[2]} /></svg>')).join()).toMatch(/beside a price/);
    expect(check(PRICE_ROW('<svg><rect className={CHART_SEQ_FILL[4]} /></svg>')).join()).toMatch(/beside a price/);
    // A series index computed at runtime may be slot 1: it fails beside money.
    expect(check(PRICE_ROW('<svg><rect className={chartHue("fill", i)} /></svg>')).join()).toMatch(/never ultramarine/);
  });

  it('rule 3: a wash only in WASH_FILES, one per file, never in a list; specimens may show several', () => {
    const one = 'export const L = () => <section className={WASH_HERO}><h1>Make a comic</h1></section>;';
    expect(check(one, 'components/studio/Board.tsx').join()).toMatch(/outside the hero and empty-state files/);
    expect(check(one, 'components/comicshost/ComicsLanding.tsx')).toEqual([]);
    const two = 'export const L = () => <><section className={WASH_HERO} /><section className={WASH_EMPTY} /></>;';
    expect(check(two, 'components/comicshost/ComicsLanding.tsx').join()).toMatch(/2 washes in one file/);
    expect(check('export const L = ({ xs }) => <ul>{xs.map((x) => <li key={x} className={WASH_EMPTY} />)}</ul>;', 'components/comicshost/ComicsLanding.tsx').join()).toMatch(/inside a list/);
    expect(check(two, 'components/ds/specimens/ColourSpecimen.tsx')).toEqual([]);
    expect(check('export const W = () => <div className="bg-[image:var(--ds-wash-hero)]" />;', 'components/x/Y.tsx').join()).toMatch(/a wash/);
  });

  it('rule 4: words on a solid that cannot carry them fail (slots 2, 3, 4, 7, or a computed slot); icons and slots 1, 5, 6 pass', () => {
    expect(check('export const T = () => <span className={HUE_SOLID[1]}>New</span>;').join()).toMatch(/words inside HUE_SOLID on slot 2/);
    expect(check('export const T = () => <span className="bg-[var(--ds-hue-7-solid)] text-[var(--ds-on-hue)]">3</span>;').join()).toMatch(/slot 7/);
    expect(check('export const T = ({ i }) => <span className={HUE_SOLID[i]}>{label}</span>;').join()).toMatch(/computed slot/);
    expect(check('export const T = () => <span className={HUE_SOLID[1]}><Palette aria-hidden /></span>;')).toEqual([]);
    expect(check('export const T = () => <span className={HUE_SOLID[5]}>Leaf</span>;')).toEqual([]);
    expect(check('export const T = () => <span className={HUE_SOLID[0]}>New</span>;')).toEqual([]);
  });

  it('rule 5: navigation takes no ultramarine and no wash; the studio marker is allowed', () => {
    expect(check('export const N = () => <i className={HUE_SOFT_BG[0]} />;', 'components/nav/Rail.tsx').join()).toMatch(/no ultramarine/);
    expect(check('export const N = () => <i className="bg-[var(--ds-hue-1)]" />;', 'components/comicstudio/TabBar.tsx').join()).toMatch(/no ultramarine/);
    expect(check('export const N = () => <i className={STUDIO_MARK} />;', 'components/nav/Rail.tsx')).toEqual([]);
    expect(check('export const N = () => <i className={HUE_SOFT_BG[1]} />;', 'components/nav/Rail.tsx')).toEqual([]);
  });

  it('rule 6: the reader takes no colour-layer token at all', () => {
    expect(check('export const R = () => <i className={HUE_SOFT_BG[2]} />;', 'components/comicstudio/immersive/Hud.tsx').join()).toMatch(/the reader takes no colour-layer token/);
    expect(check('export const R = () => <i className="ds-art-scope" />;', 'components/comicstudio/reader/X.tsx').join()).toMatch(/the reader/);
  });
});

describe('colour-use guard — the rules over a tree', () => {
  const run = (files: Record<string, string>, opts?: Parameters<typeof checkColourTree>[1]) => {
    const root = tempTree(files);
    try {
      return checkColourTree(root, opts).violations;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('finds a violation in a scanned file and in the reader CSS; a WASH_FILES entry that is missing fails', () => {
    expect(run({ 'components/x/A.tsx': PRICE_ROW('<span className={HUE_SOFT_BG[2]}>Pages</span>') }, { washFiles: {} }).join()).toMatch(/beside a price/);
    expect(run({ 'components/comicstudio/immersive/room.css': '.x { background: var(--ds-hue-3-soft); }' }, { washFiles: {} })).toEqual(['components/comicstudio/immersive/room.css: the reader takes no colour-layer token (CSS)']);
    expect(run({ 'components/x/A.tsx': 'export const A = 1;' }, { washFiles: { 'components/gone.tsx': 'x' } })).toEqual(['components/gone.tsx: listed in WASH_FILES but missing']);
  });
});

describe('colour-use guard — the app', () => {
  it('scans the app and every rule holds', { timeout: REAL_TREE_TIMEOUT }, () => {
    const { scanned, violations } = checkColourTree();
    expect(scanned).toBeGreaterThan(300);
    expect(violations).toEqual([]);
    for (const [rel, reason] of Object.entries(WASH_FILES)) expect(reason.length, rel).toBeGreaterThan(10);
  });

  it('rule 7: no Button variant reads a colour-layer token (primary buttons stay ink)', () => {
    for (const [variant, cls] of Object.entries(BUTTON_VARIANT)) expect(LAYER_TOKEN.test(cls), variant).toBe(false);
  });
});
