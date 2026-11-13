// Shared by the colour guards (sparkGuard.test.ts, colourUseGuard.test.ts): the price and spend-control detector over a
// file's syntax tree (TypeScript's parser, so a comment or a sentence never counts). Moved out of sparkGuard.test.ts
// unchanged (CL-6) so both guards read one list of price formatters. Not a test file (no `.test.` in the name).
import ts from 'typescript';
import { scriptKindOf } from './classLists';


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
export const COST_METHODS = new Set(['exact', 'approx', 'badge', 'spoken', 'saved', 'quote', 'spent']);
export const COST_FACTORIES = new Set(['useCostFormat', 'costFormat', 'costFormatFor']);
/** Dollars, cents, a templated dollar amount, or a governed share of the allowance ("≈2% of your usage", "a little of your usage"). */
export const PRICE_TEXT = /\$\s?\d|\$\$\{|¢|\bof\s+your\s+(?:usage|month|allowance)\b/i;
/** JSX text ending in a dollar sign, right before an expression: `<span>${amount}</span>` is the text "$", then {amount}. */
export const DOLLAR_BEFORE_EXPRESSION = /\$\s*$/;
/** The spend controls (§3.7): they stay the ink primary whether or not a price shows. */
export const SPEND_LABEL = /^(?:Approve|Draw|Redraw|Translate|Get\s+more)\b/i;

export const parse = (source: string, fileName: string) => ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
export const isStringy = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

/** The JSX element a node sits on (the element whose attributes or className hold it), if any. */
export function elementOf(node: ts.Node): ts.JsxElement | ts.JsxSelfClosingElement | null {
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
export function siblingsOf(el: ts.Node): ts.Node[] {
  let child: ts.Node = el;
  while (child.parent && (ts.isParenthesizedExpression(child.parent) || ts.isBinaryExpression(child.parent) || ts.isConditionalExpression(child.parent) || ts.isJsxExpression(child.parent))) child = child.parent;
  const parent = child.parent;
  if (parent && (ts.isJsxElement(parent) || ts.isJsxFragment(parent))) return parent.children.filter((c) => c !== child && !(ts.isJsxText(c) && !c.text.trim()));
  return [];
}

/** The JSX child right after a text child, if any. */
export function jsxNext(n: ts.JsxText): ts.Node | undefined {
  const p = n.parent;
  if (!ts.isJsxElement(p) && !ts.isJsxFragment(p)) return undefined;
  return p.children[p.children.indexOf(n) + 1];
}
export const isExpression = (n: ts.Node | undefined): boolean => !!n && ts.isJsxExpression(n) && !!n.expression;

/** The first price inside a subtree, described, or null. */
export function priceIn(root: ts.Node, sf: ts.SourceFile, costNames: Set<string>): string | null {
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

/** The plain text an element says: its text children and string children, nested elements included. */
export function textOf(children: readonly ts.JsxChild[]): string {
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
export function labelsOf(el: ts.JsxElement | ts.JsxSelfClosingElement): string[] {
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

/** The variables a file binds to a CostFormat factory (`const fmt = useCostFormat()`): their methods are prices. */
export function costNamesOf(sf: ts.SourceFile): Set<string> {
  const costNames = new Set<string>();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression) && COST_FACTORIES.has(n.initializer.expression.text)) costNames.add(n.name.text);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  return costNames;
}
