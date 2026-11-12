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
 *   1. ALLOWLISTED FILLS. A spark fill — `variant="create"` on a Button (or `variant: 'create'` in buttonClasses,
 *      directly, through a ternary or through a same-file const), the SPARK_FILL recipe, any `bg-[…]` whose
 *      bracket reads --ds-spark or --ds-spark-hover (`bg-[var(--ds-spark)]`, `bg-[color:var(--ds-spark)]`,
 *      `hover:bg-[color:color-mix(in_srgb,var(--ds-spark)_92%,transparent)]`; the -soft / -glow / -text tints are
 *      not fills), a `bg-ds-spark…` class, or a style `background(Color)` holding the spark — appears only in the
 *      files ALLOWLIST pins, each use pinned by its token and source line, with a one-line reason. SPARK_DEFINITIONS
 *      (Button.tsx, Progress.tsx, recipes.ts, studioDesign.ts) define the fill and are not uses; every other
 *      components/ds file (the composites: EmptyState, PageHeader, SectionCard, …) is held like any screen, since
 *      a `create` default there would put a spark on every screen using it. SPECIMENS (the DS gallery) may show
 *      every variant.
 *   2. ONE PER VIEW. A file renders at most one spark fill (the static half of "one spark fill per view"; the
 *      layout smoke counts `[data-variant="create"]` per viewport for the composed half), and never one inside a
 *      list (`.map()`, `.flatMap()`, `Array.from(…, fn)`), which renders one per item.
 *   3. INK NAVIGATION. No spark of any kind in the panel and navigation (INK_ONLY), allowlisted or not: no fill,
 *      no spark text, tint, ring or Ben-Day (§3.8: navigation labels and chrome icons take no colour). The one
 *      exception is the making dot beside its words (MAKING_DOT, `tone="making"`).
 *   4. NO SPARK IN THE READER. No spark of any kind (fill, text, ring, making, Ben-Day, `--ds-spark*`) under
 *      components/comicstudio/{reader,immersive}/**, its CSS included.
 *   5. NEVER BESIDE A PRICE. The element that carries the fill, and its sibling elements, contain no price: no call
 *      to a price formatter (PRICE_CALLS: formatUsd, formatCostForUser, usageSafeSpendText, costLabel, usageLabel,
 *      governText, formatLabUsd, formatImagePrice, localCostLabel, … — bare or as `module.name(…)`), nor a
 *      CostFormat method — exact / approx / badge / spoken / saved / quote / spent — on a formatter), no
 *      UNKNOWN_USAGE_SHARE(_IN_SENTENCE), no <Price…> component, no "$1", "$${…}", a "$" before an expression,
 *      "¢" or "… of your usage / month / allowance" text. This applies to specimens too.
 *   6. NEVER A SPEND CONTROL. A spark fill whose own label starts with Approve, Draw, Redraw, Translate or Get
 *      more (§3.7: the spend controls stay the ink primary, with or without a price shown). Specimens too.
 * The detector reads each file's syntax tree (TypeScript's parser), so a comment or a sentence never counts.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as design from '../../components/chat/studioDesign';
import { BUTTON_EXTENSION_VARIANTS, BUTTON_VARIANT, BUTTON_VARIANTS } from '../../components/ds/Button';
import { PROGRESS_MAKING } from '../../components/ds/Progress';
import { APP_ROOT, listScannedFiles, matchesGlob, REAL_TREE_TIMEOUT, scriptKindOf, tempTree } from './classLists';

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

/**
 * Where the spark fill is DEFINED, not used (rules 1–3 do not apply; rules 5 and 6 still do). Only these: the rest of
 * components/ds (EmptyState, PageHeader, SectionCard, MetricCard, ErrorState, LoadingState, …) composes actions and
 * is held like any screen.
 */
export const SPARK_DEFINITIONS: readonly string[] = ['components/ds/Button.tsx', 'components/ds/Progress.tsx', 'components/ds/recipes.ts', 'components/chat/studioDesign.ts'];

/** The panel and navigation: ink only, whatever the allowlist says (rule 3). */
export const INK_ONLY: readonly string[] = ['components/nav/**', 'components/chat/ChatSidebar.tsx', '**/NavRail.tsx', '**/TabBar.tsx', '**/PlaceNav.tsx'];
/** The one spark navigation may carry: the making dot beside its words ("Drawing page 3", §3.8's exception). */
const INK_ONLY_EXCEPT = new Set(['MAKING_DOT', 'tone=making']);

/** The reader: no spark at all (rule 4). */
export const NO_SPARK: readonly string[] = ['components/comicstudio/reader/**', 'components/comicstudio/immersive/**'];

// ── The detector ──────────────────────────────────────────────────────────────────────────────────

/**
 * A raw spark background utility, with any variant chain and opacity: any `bg-[…]` whose bracket reads --ds-spark or
 * --ds-spark-hover however it is spelled (`bg-[var(--ds-spark)]`, `bg-[color:var(--ds-spark)]`, the house hover
 * `hover:bg-[color:color-mix(in_srgb,var(--ds-spark)_92%,transparent)]`, a gradient), or the named colour
 * (`bg-ds-spark/80`). The tints (--ds-spark-soft, -glow, -text) are not fills.
 */
const RAW_SPARK_FILL = /(?<![\w-])(?:[\w\-[\]&:()>.*/@]+:)?!?bg-(?:\[[^\]\s]*--ds-spark(?:-hover)?(?![\w-])[^\]\s]*\]|ds-spark(?:-hover)?(?![\w-]))(?:\/[\w.[\]]+)?(?![\w[-])/g;
/** The spark as a fill colour in a value (a style `background` / `backgroundColor`). */
const SPARK_FILL_VALUE = /--ds-spark(?:-hover)?(?![\w-])/;
/** Style properties that paint a fill. */
const STYLE_FILL_PROPS = new Set(['background', 'backgroundColor', 'background-color', 'backgroundImage', 'background-image']);
/** Any spark in a literal: a token, a named colour or one of the layer's two classes. */
const ANY_SPARK_LITERAL = /--ds-spark|(?<![\w-])(?:[\w\-[\]&:()>.*/@]+:)?(?:bg|text|border|outline|ring|fill|stroke|shadow|from|via|to|decoration|accent|caret)-ds-(?:spark|on-spark)|(?<![\w-])ds-(?:making-sweep|benday)(?![\w-])/;
/** The recipes that put the spark on screen. */
const SPARK_RECIPES = new Set(['SPARK_FILL', 'SPARK_TEXT', 'SPARK_SOFT_BG', 'SPARK_RING_ON_ART', 'MAKING_DOT', 'MAKING_SWEEP', 'MAKING_TEXT', 'BENDAY', 'PROGRESS_MAKING']);

/**
 * Every function in the app that returns a price or a governed share of the allowance (called bare or as
 * `module.name(…)`). Keep this in step with the formatters: a new one that is missing here can sit beside the spark.
 */
export const PRICE_CALLS: ReadonlySet<string> = new Set([
  // shared/comic/models.ts and platform-core cost/wording.ts formatUsd; services/costDisplay.ts; conversation/cost.ts;
  // board/costFormat.ts (V.2-12).
  'formatUsd', 'formatCostForUser', 'usageSafeSpendText', 'formatSpend', 'formatPrice', 'formatPriceCompact', 'priceText', 'costFormat', 'costFormatFor', 'useCostFormat',
  // services/modelCatalog.ts costLabel ("$0.040/img", the chat model picker and suggester beside the composer Send)
  // and platform-core cost/wording.ts costLabel / usageLabel / governText.
  'costLabel', 'usageLabel', 'governText',
  // The Model Lab's spend button ("Run · ≈ {formatLabUsd(…)}", models/lab/labApi.ts), services/imageModelRanking.ts,
  // and the export review (steps/comicCostDisplay.ts comicCostView / localCostLabel / formatUsageShare).
  'formatLabUsd', 'formatImagePrice', 'localCostLabel', 'formatUsageShare', 'comicCostView',
  // services/costDisplay.ts: the governed share shortened for a chip, and in a sentence.
  'compactUsageShare', 'amountInSentence'
]);
/** Price constants: the governed "uses a little of your usage" while the share is unknown (costDisplay.ts, wording.ts). */
export const PRICE_IDENTS: ReadonlySet<string> = new Set(['UNKNOWN_USAGE_SHARE', 'UNKNOWN_USAGE_SHARE_IN_SENTENCE']);
/** CostFormat's methods (components/comicstudio/conversation/cost.ts and board/costFormat.ts). */
const COST_METHODS = new Set(['exact', 'approx', 'badge', 'spoken', 'saved', 'quote', 'spent']);
const COST_FACTORIES = new Set(['useCostFormat', 'costFormat', 'costFormatFor']);
/** Dollars, cents, a templated dollar amount, or a governed share of the allowance ("≈2% of your usage", "a little of your usage"). */
const PRICE_TEXT = /\$\s?\d|\$\$\{|¢|\bof\s+your\s+(?:usage|month|allowance)\b/i;
/** JSX text ending in a dollar sign, right before an expression: `<span>${amount}</span>` is the text "$", then {amount}. */
const DOLLAR_BEFORE_EXPRESSION = /\$\s*$/;
/** The spend controls (§3.7): they stay the ink primary whether or not a price shows. */
const SPEND_LABEL = /^(?:Approve|Draw|Redraw|Translate|Get\s+more)\b/i;

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
export interface SpendSpark {
  line: number;
  fill: string;
  /** The control's own label, as read. */
  label: string;
  text: string;
}

const parse = (source: string, fileName: string) => ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
const isStringy = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

/** The file's `const` initializers by name (a name declared twice in different scopes keeps both). */
type Consts = Map<string, ts.Expression[]>;
function constsOf(sf: ts.SourceFile): Consts {
  const out: Consts = new Map();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.getCombinedNodeFlags(n) & ts.NodeFlags.Const) {
      out.set(n.name.text, [...(out.get(n.name.text) ?? []), n.initializer]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
/** `'create'`, `"create"`, `{'create'}`, a ternary / `&&` that can yield it, or a same-file const that holds one. */
function yieldsCreate(n: ts.Node | undefined, consts: Consts, seen: Set<string> = new Set()): boolean {
  if (!n) return false;
  if (isStringy(n)) return n.text === 'create';
  if (ts.isIdentifier(n)) {
    if (seen.has(n.text)) return false;
    seen.add(n.text);
    return (consts.get(n.text) ?? []).some((init) => yieldsCreate(init, consts, seen));
  }
  if (ts.isJsxExpression(n) || ts.isParenthesizedExpression(n)) return yieldsCreate(n.expression, consts, seen);
  if (ts.isConditionalExpression(n)) return yieldsCreate(n.whenTrue, consts, seen) || yieldsCreate(n.whenFalse, consts, seen);
  if (ts.isBinaryExpression(n)) return yieldsCreate(n.right, consts, seen) || (n.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken && yieldsCreate(n.left, consts, seen));
  if (ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n) || ts.isNonNullExpression(n)) return yieldsCreate(n.expression, consts, seen);
  return false;
}
/** A property's name as written (`background`, `'background-color'`). */
const propName = (name: ts.PropertyName): string => (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text : '');
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
  const consts = constsOf(sf);
  const isMakingTone = (i: ts.JsxAttributeValue | undefined) =>
    !!i && ((isStringy(i) && i.text === 'making') || (ts.isJsxExpression(i) && !!i.expression && isStringy(i.expression) && i.expression.text === 'making'));
  const visit = (node: ts.Node) => {
    if ((ts.isJsxAttribute(node) || ts.isPropertyAssignment(node)) && node.name.getText(sf) === 'variant' && yieldsCreate(node.initializer, consts)) add(node, 'variant=create', true);
    else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'variant' && yieldsCreate(node.name, consts)) add(node, 'variant=create', true);
    else if (ts.isPropertyAssignment(node) && STYLE_FILL_PROPS.has(propName(node.name)) && SPARK_FILL_VALUE.test(node.initializer.getText(sf))) {
      add(node, `style:${propName(node.name)}`, true);
      return; // the value's own string is this fill, not a second use
    } else if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'tone' && isMakingTone(node.initializer)) add(node, 'tone=making', false);
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

/** The JSX child right after a text child, if any. */
function jsxNext(n: ts.JsxText): ts.Node | undefined {
  const p = n.parent;
  if (!ts.isJsxElement(p) && !ts.isJsxFragment(p)) return undefined;
  return p.children[p.children.indexOf(n) + 1];
}
const isExpression = (n: ts.Node | undefined): boolean => !!n && ts.isJsxExpression(n) && !!n.expression;

/** The first price inside a subtree, described, or null. */
function priceIn(root: ts.Node, sf: ts.SourceFile, costNames: Set<string>): string | null {
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && PRICE_CALLS.has(callee.text)) found = `${callee.text}()`;
      else if (ts.isPropertyAccessExpression(callee) && PRICE_CALLS.has(callee.name.text)) found = `${callee.getText(sf)}()`;
      else if (ts.isPropertyAccessExpression(callee) && COST_METHODS.has(callee.name.text)) {
        const obj = callee.expression.getText(sf);
        if (costNames.has(obj) || /cost|price|fmt/i.test(obj)) found = `${obj}.${callee.name.text}()`;
      }
    } else if (ts.isIdentifier(n) && PRICE_IDENTS.has(n.text)) {
      found = n.text;
    } else if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && /(?:^|\.)Price[A-Z]?\w*$/.test(n.tagName.getText(sf))) {
      found = `<${n.tagName.getText(sf)}>`;
    } else if ((isStringy(n) || ts.isJsxText(n) || ts.isTemplateExpression(n)) && PRICE_TEXT.test(n.getText(sf))) {
      found = JSON.stringify(n.getText(sf).trim().slice(0, 60));
    } else if (ts.isJsxText(n) && DOLLAR_BEFORE_EXPRESSION.test(n.text) && isExpression(jsxNext(n))) {
      found = JSON.stringify(`${n.text.trim()}{…}`);
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

/** The plain text an element says: its text children and string children, nested elements included. */
function textOf(children: readonly ts.JsxChild[]): string {
  const parts: string[] = [];
  for (const c of children) {
    if (ts.isJsxText(c)) parts.push(c.text);
    else if (ts.isJsxExpression(c) && c.expression && isStringy(c.expression)) parts.push(c.expression.text);
    else if (ts.isJsxElement(c) || ts.isJsxFragment(c)) parts.push(textOf(c.children));
    else parts.push(' ');
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}
/** The element's own labels: its text, and its aria-label / title / label strings. */
function labelsOf(el: ts.JsxElement | ts.JsxSelfClosingElement): string[] {
  const out: string[] = [];
  const attrs = (ts.isJsxElement(el) ? el.openingElement : el).attributes.properties;
  for (const a of attrs) {
    if (!ts.isJsxAttribute(a) || !a.initializer || !['aria-label', 'title', 'label'].includes(a.name.getText())) continue;
    const v = ts.isJsxExpression(a.initializer) ? a.initializer.expression : a.initializer;
    if (v && isStringy(v)) out.push(v.text.trim());
  }
  if (ts.isJsxElement(el)) out.push(textOf(el.children));
  return out.filter(Boolean);
}

/** Spark fills on a spend control: the element's own label starts with Approve, Draw, Redraw, Translate or Get more (rule 6). */
export function spendSparks(source: string, fileName = 'file.tsx'): SpendSpark[] {
  const sf = parse(source, fileName);
  const out: SpendSpark[] = [];
  const seen = new Set<ts.Node>();
  for (const use of usesIn(sf, source.split('\n'))) {
    if (!use.fill) continue;
    const el = elementOf(use.node);
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const label = labelsOf(el).find((l) => SPEND_LABEL.test(l));
    if (label) out.push({ line: use.line, fill: use.token, label, text: use.text });
  }
  return out;
}

/** The list call a node renders inside (`.map()`, `.flatMap()`, `Array.from(…, fn)`), or null. */
function listCallOf(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node; n && !ts.isSourceFile(n); n = n.parent) {
    if (!(ts.isArrowFunction(n) || ts.isFunctionExpression(n))) continue;
    const call = n.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(n as ts.Expression)) continue;
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee) && ['map', 'flatMap'].includes(callee.name.text)) return `.${callee.name.text}()`;
    if (ts.isPropertyAccessExpression(callee) && callee.getText() === 'Array.from') return 'Array.from()';
  }
  return null;
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
    for (const s of spendSparks(source, rel)) violations.push(`${rel}:${s.line}: a spark fill (${s.fill}) on a spend control (${JSON.stringify(s.label)}) — Approve, Draw, Redraw, Translate and Get more stay the ink primary — ${s.text}`);
    if (matchesGlob(rel, SPARK_DEFINITIONS)) continue; // where the fill is defined, not used
    if (matchesGlob(rel, INK_ONLY)) {
      for (const u of uses) {
        if (INK_ONLY_EXCEPT.has(u.token)) continue;
        violations.push(`${rel}:${u.line}: the panel and navigation stay ink (no spark ${u.fill ? 'fill' : 'text, tint or ring'}; page content owns the one spark; only the making dot beside its words) — ${u.token} — ${u.text}`);
      }
      continue;
    }
    const fills = uses.filter((u) => u.fill);
    if (!fills.length) continue;
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
    // A list renders the fill once per item: as many sparks as rows.
    for (const u of fills) {
      const list = listCallOf(u.node);
      if (list) violations.push(`${rel}:${u.line}: a spark fill inside a list (${list}) renders one per item — one spark fill per view — ${u.token} — ${u.text}`);
    }
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

  it('finds the other spellings: a colour-typed bracket, the colour-mix hover, an inline style, and a create held in a const', () => {
    const src = [
      'export const A = () => <span className="bg-[color:var(--ds-spark)]">x</span>;',
      'export const B = () => <span className="hover:bg-[color:color-mix(in_srgb,var(--ds-spark)_92%,transparent)]">x</span>;',
      "export const C = () => <span style={{ background: 'var(--ds-spark)' }}>x</span>;",
      'export const D = ({ on }) => <span style={{ backgroundColor: on ? "var(--ds-spark-hover)" : undefined }}>x</span>;',
      "const V = 'create' as const;",
      'export const E = () => <Button variant={V}>New comic</Button>;',
      "const variant = 'create';",
      'export const F = () => <a className={buttonClasses({ variant })}>Start</a>;'
    ].join('\n');
    expect(tokens(src)).toEqual([
      'fill raw:bg-[color:var(--ds-spark)]',
      'fill raw:hover:bg-[color:color-mix(in_srgb,var(--ds-spark)_92%,transparent)]',
      'fill style:background',
      'fill style:backgroundColor',
      'fill variant=create',
      'fill variant=create'
    ]);
    // The tints are not fills: soft, glow and text in a bracket or a style stay "some spark".
    const tints = [
      'export const T = () => <span className="bg-[var(--ds-spark-soft)] bg-[color:var(--ds-spark-glow)]">x</span>;',
      "export const S = () => <span style={{ background: 'var(--ds-spark-soft)' }}>x</span>;",
      "const W = 'outline';",
      'export const U = () => <Button variant={W}>Later</Button>;'
    ].join('\n');
    expect(tokens(tints)).toEqual(['spark literal:--ds-spark', 'spark literal:--ds-spark']);
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
      ['<Button variant="create">{`Draw ${fmt.quote(usd)}`}</Button>', 'fmt.quote()'],
      // The other formatters in the app (services/modelCatalog.ts, platform-core cost/wording.ts, the Model Lab, the
      // image model ranking, the export review, services/costDisplay.ts) and the unknown-share constants.
      ['<Button variant="create">Send <span>{costLabel(model)}</span></Button>', 'costLabel()'],
      ['<Button variant="create">{usageLabel(u)}</Button>', 'usageLabel()'],
      ['<Button variant="create">{governText(text, view)}</Button>', 'governText()'],
      ['<Button variant="create">Run · {formatLabUsd(q)}</Button>', 'formatLabUsd()'],
      ['<Button variant="create">{formatImagePrice(m)}</Button>', 'formatImagePrice()'],
      ['<Button variant="create">{localCostLabel(report, ctx, 4)}</Button>', 'localCostLabel()'],
      ['<Button variant="create">{formatUsageShare(pct)}</Button>', 'formatUsageShare()'],
      ['<Button variant="create">{compactUsageShare(label)}</Button>', 'compactUsageShare()'],
      ['<Button variant="create">{amountInSentence(label)}</Button>', 'amountInSentence()'],
      ['<Button variant="create">{wording.costLabel(0.04, view)}</Button>', 'wording.costLabel()'],
      ['<Button variant="create">{UNKNOWN_USAGE_SHARE}</Button>', 'UNKNOWN_USAGE_SHARE'],
      ['<Button variant="create">Uses {costDisplay.UNKNOWN_USAGE_SHARE_IN_SENTENCE}</Button>', 'UNKNOWN_USAGE_SHARE_IN_SENTENCE'],
      ['<Button variant="create">Start (uses a little of your usage)</Button>', '"Start (uses a little of your usage)"'],
      ['<Button variant="create">Start · ${usd}</Button>', '"Start · ${…}"']
    ];
    for (const [jsx, price] of cases) {
      const found = pricesBesideSpark(`export const X = ({ cost, fmt, usd, u, q, m, model, report, ctx, pct, label, text, view }) => ${jsx};`);
      expect(found.map((p) => p.price), jsx).toEqual([price]);
    }
  });

  it('every export of the cost modules is a price the detector knows, or says why it is not one', () => {
    // A new price formatter in a cost module must join PRICE_CALLS / PRICE_IDENTS, or NOT_PRICE with the reason.
    const COST_MODULES = [
      'services/costDisplay.ts',
      'components/steps/comicCostDisplay.ts',
      'components/comicstudio/conversation/cost.ts',
      'components/comicstudio/board/costFormat.ts',
      'packages/platform-core/src/cost/wording.ts'
    ];
    const NOT_PRICE: Record<string, string> = {
      DOLLAR_CONTEXT: 'a display context, not text',
      costContextFromAllowance: 'a display context, not text',
      standardPageProviderUsd: 'a number for the server formula, never rendered',
      isGovernedComicCost: 'a predicate',
      costSummaryForExport: 'the export JSON payload, not on screen',
      aiUsageForExport: 'the export JSON payload, not on screen',
      artifactsForExport: 'the export JSON payload, not on screen',
      costContextFor: 'a display context, not text',
      useCostContext: 'a display context, not text',
      boardCostContext: 'a display context, not text',
      COST_MICROS_HEADER: 'an HTTP header name',
      usdToMicros: 'a number',
      microsToUsd: 'a number'
    };
    const unknown: string[] = [];
    for (const rel of COST_MODULES) {
      const src = readFileSync(path.join(APP_ROOT, rel), 'utf8');
      const names = [...src.matchAll(/^export (?:const|function|async function|class) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
      expect(names.length, rel).toBeGreaterThan(2);
      for (const n of names) if (!PRICE_CALLS.has(n) && !PRICE_IDENTS.has(n) && !(n in NOT_PRICE)) unknown.push(`${rel}: ${n}`);
    }
    expect(unknown).toEqual([]);
    // The price formatters that live in mixed modules are still there under these names (else PRICE_CALLS rots).
    const mixed: Array<[string, string]> = [
      ['services/modelCatalog.ts', 'costLabel'],
      ['services/imageModelRanking.ts', 'formatImagePrice'],
      ['components/comicstudio/models/lab/labApi.ts', 'formatLabUsd'],
      ['shared/comic/models.ts', 'formatUsd']
    ];
    for (const [rel, name] of mixed) {
      expect(readFileSync(path.join(APP_ROOT, rel), 'utf8'), `${rel} exports ${name}`).toMatch(new RegExp(`^export const ${name}\\b`, 'm'));
      expect(PRICE_CALLS.has(name), name).toBe(true);
    }
  });

  it('a spark fill on a spend control fails even with no price shown (Approve, Draw, Redraw, Translate, Get more stay ink)', () => {
    const cases: Array<[string, string]> = [
      ['<Button variant="create">Approve</Button>', 'Approve'],
      ['<Button variant="create"><Icon /> Draw 4 pages</Button>', 'Draw 4 pages'],
      ['<Button variant="create">{"Redraw"}</Button>', 'Redraw'],
      ['<button className={SPARK_FILL}>Translate to Telugu</button>', 'Translate to Telugu'],
      ['<Button variant="create" aria-label="Get more usage"><Plus /></Button>', 'Get more usage']
    ];
    for (const [jsx, label] of cases) expect(spendSparks(`export const X = () => ${jsx};`).map((s) => s.label), jsx).toEqual([label]);
    // Making words and creation words are not spend controls.
    for (const jsx of ['<Button variant="create">New comic</Button>', '<Button variant="create">Drawing…</Button>', '<Button variant="create">Start a comic</Button>', '<Button>Draw 4 pages</Button>']) {
      expect(spendSparks(`export const X = () => ${jsx};`), jsx).toEqual([]);
    }
  });

  it('finds a price BESIDE the spark (a sibling element, through a condition) but not in a cousin', () => {
    const beside = 'export const X = ({ cost }) => <div><Button variant="create">Start</Button>{show && <PriceBadge usd={0.1} />}</div>;';
    expect(pricesBesideSpark(beside).map((p) => p.price)).toEqual(['<PriceBadge>']);
    const bound = 'export const X = ({ studio }) => { const money = useCostFormat(studio); return <div><Button variant="create">Start</Button><span>{money.badge(0.1)}</span></div>; };';
    expect(pricesBesideSpark(bound).map((p) => p.price)).toEqual(['money.badge()']);
    // The composer: Send beside the model picker's per-image price (services/modelCatalog.ts costLabel).
    const composer = 'export const X = ({ model }) => <div><Button variant="create">Send</Button><span>{costLabel(model)}</span></div>;';
    expect(pricesBesideSpark(composer).map((p) => p.price)).toEqual(['costLabel()']);
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

  it('navigation takes no spark text, tint, ring or Ben-Day either; only the making dot beside its words', () => {
    const nav = 'components/nav/X.tsx';
    expect(run({ [nav]: 'export const X = () => <a className={SPARK_TEXT}>My comics</a>;\n' })).toEqual([expect.stringMatching(/X\.tsx:1: the panel and navigation stay ink \(no spark text, tint or ring.*SPARK_TEXT/)]);
    expect(run({ 'components/nav/Rail.tsx': 'export const R = () => <a className={cn(SPARK_SOFT_BG, "text-[var(--ds-spark-text)]")}>Library</a>;\n' })).toEqual([
      expect.stringMatching(/Rail\.tsx:1: .*SPARK_SOFT_BG/),
      expect.stringMatching(/Rail\.tsx:1: .*literal:--ds-spark/)
    ]);
    expect(run({ 'components/x/TabBar.tsx': 'export const T = () => <div className={BENDAY} />;\n' })).toEqual([expect.stringMatching(/TabBar\.tsx:1: the panel and navigation stay ink/)]);
    // The exception: "Drawing page 3" in the panel, its making dot beside the words.
    expect(run({ [nav]: 'export const X = () => <a><LiveDot className={MAKING_DOT} /> Drawing page 3</a>;\n' })).toEqual([]);
  });

  it('a components/ds composite is held like any screen: a create default in EmptyState is not allowlisted (only the four definition files are exempt)', () => {
    const empty = 'components/ds/EmptyState.tsx';
    expect(run({ [empty]: 'export const EmptyState = ({ action }) => <div><p>Nothing yet</p><Button variant="create">{action}</Button></div>;\n' })).toEqual([
      expect.stringMatching(/EmptyState\.tsx:1: a spark fill not in the allowlist/)
    ]);
    expect(SPARK_DEFINITIONS).toEqual(['components/ds/Button.tsx', 'components/ds/Progress.tsx', 'components/ds/recipes.ts', 'components/chat/studioDesign.ts']);
    for (const rel of SPARK_DEFINITIONS) expect(existsSync(path.join(APP_ROOT, rel)), rel).toBe(true);
  });

  it('one spark fill per view: a create Button inside a list renders one per item, so it fails even when pinned', () => {
    const line = '{items.map((it) => <Button key={it.id} variant="create">{it.label}</Button>)}';
    const pins = { [HOME]: { uses: [{ token: 'variant=create', line }], reason: 'test' } };
    expect(run({ [HOME]: `export const H = ({ items }) => (\n  <div>\n    ${line}\n  </div>\n);\n` }, pins)).toEqual([expect.stringMatching(/MyComicsHeader\.tsx:3: a spark fill inside a list \(\.map\(\)\) renders one per item/)]);
  });

  it('a spark fill on a spend control fails in the tree, specimens included', () => {
    const gallery = 'qa/app/scenes/ds-gallery.tsx';
    expect(run({ [gallery]: 'export const G = () => <Button variant="create">Approve</Button>;\n' }, {}, { [gallery]: 'specimens' })).toEqual([
      expect.stringMatching(/ds-gallery\.tsx:1: a spark fill \(variant=create\) on a spend control \("Approve"\)/)
    ]);
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

  it('the four definition files define the fill and are not uses (but a price beside a fill there still fails)', () => {
    expect(run({ 'components/ds/Button.tsx': 'export const V = { create: `border-transparent ${SPARK_FILL}` };\n' })).toEqual([]);
    expect(run({ 'components/ds/Button.tsx': 'export const B = () => <button className={SPARK_FILL}>Start <PriceBadge usd={1} /></button>;\n' })).toEqual([
      expect.stringMatching(/Button\.tsx:1: a spark fill \(SPARK_FILL\) beside a price \(<PriceBadge>\)/)
    ]);
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
      if (/^(?:SPARK_|MAKING_|HUE_|ART_|BENDAY|hueIndex|hueClass)/.test(name)) continue;
      const strings = typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).filter((v): v is string => typeof v === 'string') : [];
      for (const s of strings) expect(s, name).not.toMatch(/--ds-(?:spark|hue-|art\b)/);
    }
  });
});
