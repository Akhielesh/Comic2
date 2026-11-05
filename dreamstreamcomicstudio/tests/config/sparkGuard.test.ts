// @vitest-environment node
/**
 * Spark guard (the colour layer "Ink & Spark", design.md §3.7–3.8 and §3.11, V.2-9 and V.2-12; decision D7).
 *
 * The studio is black ink on white paper; the spark (--ds-spark, ultramarine) means CREATION and nothing else. It is
 * the one "start making" fill in a view, it never sits on a price or on a control that spends (colour must never
 * nudge spending: governed users see shares of their usage, and Approve, Draw · price, Redraw, Translate and Get more
 * stay the ink primary), the navigation panel's New comic stays ink (page content owns the one spark), and the
 * reader never takes it (the comic page keeps --ds-reader-*; the art supplies the colour). This file holds that:
 *
 *   1. ALLOWLISTED FILLS. A spark fill — `variant="create"` on a Button (or `variant: 'create'` in buttonClasses),
 *      the SPARK_FILL recipe, or a raw `bg-[var(--ds-spark…)]` / `bg-ds-spark…` class — appears only in the files
 *      ALLOWLIST pins, each use pinned by its token and source line, with a one-line reason. The recipe files
 *      (components/ds/**, studioDesign.ts) define the fill and are not uses. SPECIMENS (the DS gallery) may show
 *      every variant.
 *   2. ONE PER VIEW. A file renders at most one spark fill (the static half of "one spark fill per view"; the
 *      layout smoke counts `[data-variant="create"]` per viewport for the composed half).
 *   3. INK NAVIGATION. No spark fill in the panel and navigation (INK_ONLY), allowlisted or not.
 *   4. NO SPARK IN THE READER. No spark of any kind (fill, text, ring, making, Ben-Day, `--ds-spark*`) under
 *      components/comicstudio/{reader,immersive}/**, its CSS included.
 *   5. NEVER BESIDE A PRICE. The element that carries the fill, and its sibling elements, contain no price: no call
 *      to a price formatter (formatUsd, formatCostForUser, usageSafeSpendText, formatSpend, formatPrice(Compact),
 *      priceText, costFormat(For) / useCostFormat, nor a CostFormat method — exact / approx / badge / spoken /
 *      saved / quote / spent — on a formatter), no <Price…> component, no "$1", "¢" or "% of your usage" text.
 *      This applies to specimens too.
 * The detector reads each file's syntax tree (TypeScript's parser), so a comment or a sentence never counts.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as design from '../../components/chat/studioDesign';
import { BUTTON_EXTENSION_VARIANTS, BUTTON_VARIANT, BUTTON_VARIANTS } from '../../components/ds/Button';
import { PROGRESS_MAKING } from '../../components/ds/Progress';
import { APP_ROOT, listScannedFiles, matchesGlob, RECIPE_FILES, REAL_TREE_TIMEOUT, scriptKindOf, tempTree } from './classLists';

const TEST_FILE = 'tests/config/sparkGuard.test.ts';

/**
 * The spark fills the app may render, keyed by app-relative path: each pins its uses (token and trimmed source
 * line) with the reason. Page content owns the one spark per view, in this precedence (V.2-9): the My comics
 * header "New comic", the studio composer Send, the landing hero "Start a comic", "Share" on the ready moment,
 * "Make one like this" on a reader's share page. Never a price, never a spend control, never the panel.
 */
export const ALLOWLIST: Record<string, { uses: Array<{ token: string; line: string }>; reason: string }> = {};

/** Files that show every primitive variant as a specimen (rules 1 and 2 do not apply; rule 5 still does). */
export const SPECIMENS: Record<string, string> = {
  'qa/app/scenes/ds-gallery.tsx': 'the design-system gallery renders every Button variant and the colour layer as specimens'
};

/** The panel and navigation: ink only, whatever the allowlist says (rule 3). */
export const INK_ONLY: readonly string[] = ['components/nav/**', 'components/chat/ChatSidebar.tsx', '**/NavRail.tsx', '**/TabBar.tsx', '**/PlaceNav.tsx'];

/** The reader: no spark at all (rule 4). */
export const NO_SPARK: readonly string[] = ['components/comicstudio/reader/**', 'components/comicstudio/immersive/**'];

// ── The detector ──────────────────────────────────────────────────────────────────────────────────

/** A raw spark background utility, with any variant chain and opacity (`hover:bg-[var(--ds-spark-hover)]`, `bg-ds-spark/80`). */
const RAW_SPARK_FILL = /(?<![\w-])(?:[\w\-[\]&:()>.*/@]+:)?!?bg-(?:\[var\(--ds-spark(?:-hover)?\)\]|ds-spark(?:-hover)?)(?:\/[\w.[\]]+)?(?![\w[-])/g;
/** Any spark in a literal: a token, a named colour or one of the layer's two classes. */
const ANY_SPARK_LITERAL = /--ds-spark|(?<![\w-])(?:[\w\-[\]&:()>.*/@]+:)?(?:bg|text|border|outline|ring|fill|stroke|shadow|from|via|to|decoration|accent|caret)-ds-(?:spark|on-spark)|(?<![\w-])ds-(?:making-sweep|benday)(?![\w-])/;
/** The recipes that put the spark on screen. */
const SPARK_RECIPES = new Set(['SPARK_FILL', 'SPARK_TEXT', 'SPARK_SOFT_BG', 'SPARK_RING_ON_ART', 'MAKING_DOT', 'MAKING_SWEEP', 'MAKING_TEXT', 'BENDAY', 'PROGRESS_MAKING']);

const PRICE_CALLS = new Set(['formatUsd', 'formatCostForUser', 'usageSafeSpendText', 'formatSpend', 'formatPrice', 'formatPriceCompact', 'priceText', 'costFormat', 'costFormatFor', 'useCostFormat']);
/** CostFormat's methods (components/comicstudio/conversation/cost.ts and board/costFormat.ts). */
const COST_METHODS = new Set(['exact', 'approx', 'badge', 'spoken', 'saved', 'quote', 'spent']);
const COST_FACTORIES = new Set(['useCostFormat', 'costFormat', 'costFormatFor']);
/** Dollars, cents, a templated dollar amount, or a governed share of the allowance. */
const PRICE_TEXT = /\$\s?\d|\$\$\{|¢|%\s*of\s+your\s+(?:usage|month|allowance)/i;

export interface SparkUse {
  line: number;
  token: string;
  /** The trimmed source line. */
  text: string;
  /** Whether it paints a spark FILL (rules 1, 2, 3, 5) or only some spark (rule 4). */
  fill: boolean;
  node: ts.Node;
}
export interface PriceBeside {
  line: number;
  fill: string;
  price: string;
  text: string;
}

const parse = (source: string, fileName: string) => ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
const isStringy = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
/** `'create'`, `"create"`, `{'create'}`, or a ternary / `&&` that can yield it. */
function yieldsCreate(n: ts.Node | undefined): boolean {
  if (!n) return false;
  if (isStringy(n)) return n.text === 'create';
  if (ts.isJsxExpression(n) || ts.isParenthesizedExpression(n)) return yieldsCreate(n.expression);
  if (ts.isConditionalExpression(n)) return yieldsCreate(n.whenTrue) || yieldsCreate(n.whenFalse);
  if (ts.isBinaryExpression(n)) return yieldsCreate(n.right) || (n.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken && yieldsCreate(n.left));
  if (ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n)) return yieldsCreate(n.expression);
  return false;
}
const isDeclarationName = (n: ts.Identifier) => {
  const p = n.parent;
  return (
    (ts.isVariableDeclaration(p) && p.name === n) ||
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    (ts.isPropertyAssignment(p) && p.name === n) ||
    (ts.isBindingElement(p) && (p.name === n || p.propertyName === n))
  );
};

/** Every spark use in a parsed source (fills and any other spark). */
function usesIn(sf: ts.SourceFile, lines: readonly string[]): SparkUse[] {
  const out: SparkUse[] = [];
  const add = (node: ts.Node, token: string, fill: boolean, at = node.getStart(sf)) => {
    const line = sf.getLineAndCharacterOfPosition(at).line + 1;
    out.push({ line, token, text: (lines[line - 1] ?? '').trim(), fill, node });
  };
  const isMakingTone = (i: ts.JsxAttributeValue | undefined) =>
    !!i && ((isStringy(i) && i.text === 'making') || (ts.isJsxExpression(i) && !!i.expression && isStringy(i.expression) && i.expression.text === 'making'));
  const visit = (node: ts.Node) => {
    if ((ts.isJsxAttribute(node) || ts.isPropertyAssignment(node)) && node.name.getText(sf) === 'variant' && yieldsCreate(node.initializer)) add(node, 'variant=create', true);
    else if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'tone' && isMakingTone(node.initializer)) add(node, 'tone=making', false);
    else if (ts.isIdentifier(node) && SPARK_RECIPES.has(node.text) && !isDeclarationName(node)) add(node, node.text, node.text === 'SPARK_FILL');
    else if (isStringy(node) || ts.isTemplateExpression(node)) {
      const text = node.getText(sf);
      const fills = [...text.matchAll(RAW_SPARK_FILL)];
      for (const m of fills) add(node, `raw:${m[0]}`, true, node.getStart(sf) + (m.index ?? 0));
      if (!fills.length && ANY_SPARK_LITERAL.test(text)) add(node, `literal:${ANY_SPARK_LITERAL.exec(text)![0]}`, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
/** Every spark use in a source (fills and any other spark). */
export const sparkUses = (source: string, fileName = 'file.tsx'): SparkUse[] => usesIn(parse(source, fileName), source.split('\n'));

/** The JSX element a node sits on (the element whose attributes or className hold it), if any. */
function elementOf(node: ts.Node): ts.JsxElement | ts.JsxSelfClosingElement | null {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isJsxAttribute(n)) {
      const owner = n.parent.parent; // JsxAttributes → JsxOpeningElement | JsxSelfClosingElement
      return ts.isJsxOpeningElement(owner) ? owner.parent : (owner as ts.JsxSelfClosingElement);
    }
    if (ts.isSourceFile(n) || ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return null;
  }
  return null;
}

/** The element's siblings in its parent element or fragment (through `{cond && …}` and ternaries). */
function siblingsOf(el: ts.Node): ts.Node[] {
  let child: ts.Node = el;
  while (child.parent && (ts.isParenthesizedExpression(child.parent) || ts.isBinaryExpression(child.parent) || ts.isConditionalExpression(child.parent) || ts.isJsxExpression(child.parent))) child = child.parent;
  const parent = child.parent;
  if (parent && (ts.isJsxElement(parent) || ts.isJsxFragment(parent))) return parent.children.filter((c) => c !== child && !(ts.isJsxText(c) && !c.text.trim()));
  return [];
}

/** The first price inside a subtree, described, or null. */
function priceIn(root: ts.Node, sf: ts.SourceFile, costNames: Set<string>): string | null {
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && PRICE_CALLS.has(callee.text)) found = `${callee.text}()`;
      else if (ts.isPropertyAccessExpression(callee) && COST_METHODS.has(callee.name.text)) {
        const obj = callee.expression.getText(sf);
        if (costNames.has(obj) || /cost|price|fmt/i.test(obj)) found = `${obj}.${callee.name.text}()`;
      }
    } else if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && /(?:^|\.)Price[A-Z]?\w*$/.test(n.tagName.getText(sf))) {
      found = `<${n.tagName.getText(sf)}>`;
    } else if ((isStringy(n) || ts.isJsxText(n) || ts.isTemplateExpression(n)) && PRICE_TEXT.test(n.getText(sf))) {
      found = JSON.stringify(n.getText(sf).trim().slice(0, 60));
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

/** Spark fills with a price inside the element that carries them, or in a sibling element (rule 5). */
export function pricesBesideSpark(source: string, fileName = 'file.tsx'): PriceBeside[] {
  const sf = parse(source, fileName);
  const costNames = new Set<string>();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression) && COST_FACTORIES.has(n.initializer.expression.text)) costNames.add(n.name.text);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const out: PriceBeside[] = [];
  const seen = new Set<ts.Node>();
  for (const use of usesIn(sf, source.split('\n'))) {
    if (!use.fill) continue;
    const el = elementOf(use.node);
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const price = priceIn(el, sf, costNames) ?? siblingsOf(el).map((s) => priceIn(s, sf, costNames)).find(Boolean) ?? null;
    if (price) out.push({ line: use.line, fill: use.token, price, text: use.text });
  }
  return out;
}

// ── The rules over a tree ─────────────────────────────────────────────────────────────────────────

const SOURCE_EXT = /\.(?:tsx?|jsx?|mjs)$/;
/** The CSS files under the no-spark folders (RD-A's readerDesigns.css and anything after it). */
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

export interface GuardResult {
  scanned: number;
  violations: string[];
}

/** Every rule over the scanned tree under `root` (the app, or a temp tree in the tests below). */
export function checkSparkTree(
  root = APP_ROOT,
  allowlist: typeof ALLOWLIST = ALLOWLIST,
  specimens: typeof SPECIMENS = SPECIMENS
): GuardResult {
  const files = listScannedFiles({ root });
  const violations: string[] = [];
  const pinnedSeen = new Map<string, Set<string>>();
  for (const rel of files) {
    const source = readFileSync(path.join(root, rel), 'utf8');
    if (!/spark|create|BENDAY|MAKING_|making/i.test(source)) continue;
    const uses = sparkUses(source, rel);
    if (matchesGlob(rel, NO_SPARK)) {
      for (const u of uses) violations.push(`${rel}:${u.line}: the reader takes no spark (${u.token}) — the comic page keeps --ds-reader-* — ${u.text}`);
      continue;
    }
    for (const p of pricesBesideSpark(source, rel)) violations.push(`${rel}:${p.line}: a spark fill (${p.fill}) beside a price (${p.price}) — spend and price controls stay ink — ${p.text}`);
    if (matchesGlob(rel, RECIPE_FILES)) continue; // where the fill is defined, not used
    const fills = uses.filter((u) => u.fill);
    if (!fills.length) continue;
    if (matchesGlob(rel, INK_ONLY)) {
      for (const u of fills) violations.push(`${rel}:${u.line}: the panel and navigation stay ink (page content owns the one spark) — ${u.token} — ${u.text}`);
      continue;
    }
    if (rel in specimens) continue;
    const entry = allowlist[rel];
    const pinned = new Set((entry?.uses ?? []).map((u) => `${u.token}  @  ${u.line}`));
    const seen = new Set<string>();
    for (const u of fills) {
      const key = `${u.token}  @  ${u.text}`;
      if (pinned.has(key)) seen.add(key);
      else violations.push(`${rel}:${u.line}: a spark fill not in the allowlist (${TEST_FILE} ALLOWLIST, with its reason) — ${u.token} — ${u.text}`);
    }
    pinnedSeen.set(rel, seen);
    // One per view: a file renders at most one spark fill, pinned or not. (variant=create and its raw class on the
    // same element would count twice; a create Button never spells the class itself.)
    const elements = new Set(fills.map((u) => elementOf(u.node) ?? u.node));
    if (elements.size > 1) violations.push(`${rel}: ${elements.size} spark fills in one file — one spark fill per view (lines ${fills.map((u) => u.line).join(', ')})`);
  }
  for (const rel of cssUnder(root, NO_SPARK)) {
    const css = readFileSync(path.join(root, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/--ds-spark|ds-making-sweep|ds-benday/.test(css)) violations.push(`${rel}: the reader takes no spark (CSS)`);
  }
  for (const [rel, entry] of Object.entries(allowlist)) {
    const seen = pinnedSeen.get(rel) ?? new Set<string>();
    for (const u of entry.uses) if (!seen.has(`${u.token}  @  ${u.line}`)) violations.push(`${rel}: allowlisted spark use no longer present: ${u.token} @ ${u.line} (${entry.reason})`);
  }
  for (const rel of Object.keys(specimens)) if (!existsSync(path.join(root, rel))) violations.push(`${rel}: listed as a specimen but missing`);
  return { scanned: files.length, violations };
}

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────────

const tokens = (src: string, file = 'x.tsx') => sparkUses(src, file).map((u) => `${u.fill ? 'fill' : 'spark'} ${u.token}`);

describe('spark guard — the detector', () => {
  it('finds every spelling of a spark fill', () => {
    const src = [
      'import { SPARK_FILL } from "../chat/studioDesign";',
      'export const A = () => <Button variant="create">New comic</Button>;',
      "export const B = () => <Button variant={'create'}>Start</Button>;",
      'export const C = ({ big }) => <Button variant={big ? "create" : "outline"}>Send</Button>;',
      'export const D = () => <button className={SPARK_FILL}>Send</button>;',
      'export const E = () => <a className={design.SPARK_FILL}>Go</a>;',
      'export const F = () => <a className={buttonClasses({ variant: "create" })}>Start</a>;',
      'export const G = () => <span className="rounded bg-[var(--ds-spark)] text-white hover:bg-[var(--ds-spark-hover)]">x</span>;',
      'export const H = () => <span className="bg-ds-spark/80">x</span>;'
    ].join('\n');
    expect(tokens(src)).toEqual([
      'fill variant=create',
      'fill variant=create',
      'fill variant=create',
      'fill SPARK_FILL',
      'fill SPARK_FILL',
      'fill variant=create',
      'fill raw:bg-[var(--ds-spark)]',
      'fill raw:hover:bg-[var(--ds-spark-hover)]',
      'fill raw:bg-ds-spark/80'
    ]);
  });

  it('tells a fill from the rest of the spark, and ignores what only looks like one', () => {
    const src = [
      'export const A = () => <LiveDot className={MAKING_DOT} />;',
      'export const B = () => <Progress tone="making" value={3} max={6} />;',
      'export const C = () => <p className="text-[var(--ds-spark-text)]">Drawing page 3 of 6</p>;',
      'export const D = () => <div className="ds-benday" />;',
      // Not spark: the word create elsewhere, an ink primary, a mode called create, a comment.
      'export const E = () => <Button>Create</Button>;',
      "const mode = { kind: 'create' };",
      '// <Button variant="create"> in a comment never counts',
      'export const F = () => <Button variant="default">Approve</Button>;'
    ].join('\n');
    expect(tokens(src)).toEqual(['spark MAKING_DOT', 'spark tone=making', 'spark literal:--ds-spark', 'spark literal:ds-benday']);
  });

  it('finds a price inside the spark element: a formatter call, a CostFormat method, a <Price…> component, dollars or a usage share', () => {
    const cases: Array<[string, string]> = [
      ['<Button variant="create">Draw 4 pages · {cost.approx(0.48)}</Button>', 'cost.approx()'],
      ['<Button variant="create">Draw · {formatUsd(0.12)}</Button>', 'formatUsd()'],
      ['<Button variant="create">Draw <PriceBadge usd={0.12} /></Button>', '<PriceBadge>'],
      ['<Button variant="create">Draw for $0.12</Button>', '"Draw for $0.12"'],
      ['<Button variant="create" aria-label="Draw for $0.12">Draw</Button>', '"\\"Draw for $0.12\\""'],
      ['<Button variant="create">Draw (≈2% of your usage)</Button>', '"Draw (≈2% of your usage)"'],
      ['<Button variant="create">{`Draw ${fmt.quote(usd)}`}</Button>', 'fmt.quote()']
    ];
    for (const [jsx, price] of cases) {
      const found = pricesBesideSpark(`export const X = ({ cost, fmt, usd }) => ${jsx};`);
      expect(found.map((p) => p.price), jsx).toEqual([price]);
    }
  });

  it('finds a price BESIDE the spark (a sibling element, through a condition) but not in a cousin', () => {
    const beside = 'export const X = ({ cost }) => <div><Button variant="create">Start</Button>{show && <PriceBadge usd={0.1} />}</div>;';
    expect(pricesBesideSpark(beside).map((p) => p.price)).toEqual(['<PriceBadge>']);
    const bound = 'export const X = ({ studio }) => { const money = useCostFormat(studio); return <div><Button variant="create">Start</Button><span>{money.badge(0.1)}</span></div>; };';
    expect(pricesBesideSpark(bound).map((p) => p.price)).toEqual(['money.badge()']);
    const cousin = 'export const X = ({ cost }) => <div><header><Button variant="create">Start</Button></header><section><span>{cost.badge(0.1)}</span></section></div>;';
    expect(pricesBesideSpark(cousin)).toEqual([]);
  });

  it('an ink primary with a price is fine (spend controls stay ink) — only the spark is held to it', () => {
    expect(pricesBesideSpark('export const X = ({ cost }) => <div><Button>Draw · {cost.approx(1)}</Button><PriceBadge usd={1} /></div>;')).toEqual([]);
  });
});

describe('spark guard — the rules over a tree', () => {
  const run = (files: Record<string, string>, allowlist: typeof ALLOWLIST = {}, specimens: typeof SPECIMENS = {}) => {
    const root = tempTree(files);
    try {
      return checkSparkTree(root, allowlist, specimens).violations;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const HOME = 'components/home/MyComicsHeader.tsx';
  const LINE = '<Button variant="create">New comic</Button>';
  const PINNED = { [HOME]: { uses: [{ token: 'variant=create', line: LINE }], reason: 'My comics header: the page’s one "start making" action' } };

  it('a pinned spark fill on its own passes', () => {
    expect(run({ [HOME]: `export const H = () => (\n  <header>\n    <h1>My comics</h1>\n    ${LINE}\n  </header>\n);\n` }, PINNED)).toEqual([]);
  });

  it('a spark fill next to a price fails (even when pinned)', () => {
    const violations = run({ [HOME]: `export const H = ({ cost }) => (\n  <header>\n    ${LINE}\n    <span>{cost.badge(0.12)}</span>\n  </header>\n);\n` }, PINNED);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/MyComicsHeader\.tsx:3: a spark fill \(variant=create\) beside a price \(cost\.badge\(\)\)/);
  });

  it('a spark fill that is not allowlisted fails, and so does a stale pin', () => {
    expect(run({ 'components/x/Y.tsx': `export const Y = () => ${LINE};\n` })).toEqual([expect.stringMatching(/Y\.tsx:1: a spark fill not in the allowlist/)]);
    expect(run({ [HOME]: 'export const H = () => <Button>New comic</Button>;\n' }, PINNED)).toEqual([expect.stringMatching(/allowlisted spark use no longer present/)]);
  });

  it('one spark fill per view: two in one file fail, even when both are pinned', () => {
    const second = '<Button variant="create">Start a comic</Button>';
    const src = `export const H = () => (\n  <div>\n    ${LINE}\n    ${second}\n  </div>\n);\n`;
    const pins = { [HOME]: { uses: [{ token: 'variant=create', line: LINE }, { token: 'variant=create', line: second }], reason: 'test' } };
    expect(run({ [HOME]: src }, pins)).toEqual([expect.stringMatching(/2 spark fills in one file — one spark fill per view/)]);
  });

  it('the left panel’s New comic stays ink: no spark fill in the panel or navigation, allowlisted or not', () => {
    const panel = 'components/nav/NewButton.tsx';
    const pins = { [panel]: { uses: [{ token: 'variant=create', line: LINE }], reason: 'test' } };
    expect(run({ [panel]: `export const N = () => ${LINE};\n` }, pins)).toEqual([
      expect.stringMatching(/NewButton\.tsx:1: the panel and navigation stay ink/),
      expect.stringMatching(/allowlisted spark use no longer present/)
    ]);
    expect(run({ 'components/chat/ChatSidebar.tsx': 'export const S = () => <button className={SPARK_FILL}>New chat</button>;\n' })).toEqual([expect.stringMatching(/ChatSidebar\.tsx:1: the panel and navigation stay ink/)]);
  });

  it('the reader takes no spark at all: code (fill, text, making) or its CSS', () => {
    expect(run({
      'components/comicstudio/immersive/ReaderHud.tsx': 'export const H = () => <div className="text-[var(--ds-spark-text)]"><LiveDot className={MAKING_DOT} /></div>;\n',
      'components/comicstudio/immersive/readerDesigns.css': '[data-reader-room="day"] { --ds-reader-accent: var(--ds-spark); }\n'
    })).toEqual([
      expect.stringMatching(/ReaderHud\.tsx:1: the reader takes no spark \(literal:--ds-spark\)/),
      expect.stringMatching(/ReaderHud\.tsx:1: the reader takes no spark \(MAKING_DOT\)/),
      expect.stringMatching(/readerDesigns\.css: the reader takes no spark \(CSS\)/)
    ]);
  });

  it('a specimen may show several spark fills, but never beside a price', () => {
    const gallery = 'qa/app/scenes/ds-gallery.tsx';
    const specimens = { [gallery]: 'specimens' };
    const two = `export const G = () => <div><section>${LINE}</section><section><Button variant="create">Send</Button></section></div>;\n`;
    expect(run({ [gallery]: two }, {}, specimens)).toEqual([]);
    const priced = `export const G = () => <div>${LINE}<span>$0.12</span></div>;\n`;
    expect(run({ [gallery]: priced }, {}, specimens)).toEqual([expect.stringMatching(/a spark fill \(variant=create\) beside a price/)]);
  });

  it('the recipe files define the fill and are not uses (but a price beside a fill there still fails)', () => {
    expect(run({ 'components/ds/Button.tsx': 'export const V = { create: `border-transparent ${SPARK_FILL}` };\n' })).toEqual([]);
  });
});

describe('spark guard — the app', () => {
  it('scans the app and every rule holds (allowlist pins current, specimens present)', { timeout: REAL_TREE_TIMEOUT }, () => {
    const { scanned, violations } = checkSparkTree();
    expect(scanned).toBeGreaterThan(300);
    expect(violations).toEqual([]);
    for (const [rel, entry] of Object.entries(ALLOWLIST)) expect(entry.reason.length, rel).toBeGreaterThan(10);
  });

  it('the primitives: `create` is the spark fill beside Atlas’s six untouched variants; the making bar is the spark', () => {
    expect(BUTTON_VARIANTS).toEqual(['default', 'destructive', 'outline', 'secondary', 'ghost', 'link']);
    expect(BUTTON_EXTENSION_VARIANTS).toEqual(['create']);
    expect(BUTTON_VARIANT.create).toContain(design.SPARK_FILL);
    for (const v of BUTTON_VARIANTS) expect(BUTTON_VARIANT[v], v).not.toMatch(/--ds-spark/);
    expect(design.SPARK_FILL).toBe('bg-[var(--ds-spark)] text-[var(--ds-on-spark)] hover:bg-[var(--ds-spark-hover)]');
    expect(PROGRESS_MAKING).toBe('bg-[var(--ds-spark)]');
    // No ink recipe reads the spark: focus, the primary, status and charts stay as they were.
    for (const [name, value] of Object.entries(design)) {
      if (/^(?:SPARK_|MAKING_|HUE_|ART_|BENDAY|hueSlot)/.test(name)) continue;
      const strings = typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).filter((v): v is string => typeof v === 'string') : [];
      for (const s of strings) expect(s, name).not.toMatch(/--ds-(?:spark|hue-|art\b)/);
    }
  });
});
