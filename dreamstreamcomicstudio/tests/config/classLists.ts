/**
 * Class-list analysis for the status ink guard (tests/config/statusInkGuard.test.ts).
 *
 * `cx(...)` (and `clsx` / `cn`, a `${…}` template, a `+` concatenation) only JOINS class strings; it
 * does not merge them. When one class list carries two unvariant text colours — a shared base
 * constant's `text-[var(--ds-ink)]` and a `TONE_TEXT.danger` added after it — the one Tailwind emits
 * LATER wins, whatever order they were written in. Tailwind v3 emits arbitrary-value colours in
 * candidate (alphabetical) order: accent < danger-text < faint < info-text < ink < muted <
 * success-text < warning-text. So the danger and info inks lose to ink and muted (the destructive
 * button renders in plain ink), and an emphasis stacked on a muted base (`'… text-[var(--ds-muted)]',
 * busy && 'text-[var(--ds-ink)]'`) never shows. The colour has to be CHOSEN
 * (`danger ? TONE_TEXT.danger : 'text-[var(--ds-ink)]'`, as GhostButton does), never stacked.
 *
 * This walks each source file's syntax tree (TypeScript's parser, so strings, templates and comments
 * are never mistaken for one another) and reports every class list in which two different unvariant
 * text colours can apply together, however they arrive: a literal, a studioDesign recipe (TONE_TEXT,
 * STATUS_INK, TONE_CHIP, STATUS_CHIP_TONE, SEGMENTED_ACTIVE, OVERLINE, HEADING …) or a file-local
 * constant or record built from them. A conditional part (`a && X`, `a ? X : Y`, a record indexed by
 * a variable) only competes with a part that is always applied, so mutually exclusive tones
 * (`tone === 'warn' && TONE_CHIP.warning, tone === 'danger' && TONE_CHIP.danger`) and a colour chosen
 * in one ternary pass. Variant colours (`hover:`, `dark:`, `group-hover:`) are states, not stacking.
 * A `className` prop forwarded into a component's own list is not followed (it is not a constant).
 * Not a test file (no `.test.` in the name), so vitest does not collect it; the typecheck covers it.
 */
import ts from 'typescript';
import { TONE_INK, textColours } from './textColours';

export { TONE_INK, textColours };

/** What a class-list part can paint: colours it always applies, and colours it may apply. */
interface Ink {
  always: string[];
  maybe: string[];
}
const NONE: Ink = { always: [], maybe: [] };
const join = (...inks: Ink[]): Ink => ({ always: inks.flatMap((i) => i.always), maybe: inks.flatMap((i) => i.maybe) });
const conditional = (...inks: Ink[]): Ink => ({ always: [], maybe: inks.flatMap((i) => i.maybe) });
const fromText = (text: string): Ink => {
  const c = textColours(text);
  return { always: c, maybe: c };
};

const CLASS_HELPERS = new Set(['cx', 'clsx', 'cn', 'twJoin']);

export interface InkConflict {
  line: number;
  /** The distinct text colours that compete in this class list. */
  colours: string[];
  /** A readable tone ink (`--ds-*-text`) is among them: the status meaning can be lost. */
  tone: boolean;
  snippet: string;
}

/**
 * Class lists that can apply two different unvariant text colours together.
 * `external` maps imported constant names to their values (the studioDesign module).
 */
export function findCompetingInks(source: string, external: Record<string, unknown> = {}): InkConflict[] {
  const sf = ts.createSourceFile('file.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const consts = new Map<string, ts.Expression>();
  const collect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    ) {
      consts.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const externalInk = (value: unknown, key?: string): Ink => {
    if (typeof value === 'string') return fromText(value);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (key !== undefined) return key in record ? externalInk(record[key]) : NONE;
      return conditional(...Object.values(record).map((v) => externalInk(v)));
    }
    return NONE;
  };
  const objectInk = (obj: ts.ObjectLiteralExpression, seen: Set<string>, key?: string): Ink => {
    const values: Ink[] = [];
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
      if (key !== undefined && name === key) return analyse(prop.initializer, seen);
      values.push(analyse(prop.initializer, seen));
    }
    return conditional(...values);
  };
  /** A record (local or studioDesign) read with `.key`, `['key']` or `[expr]`. */
  const recordInk = (base: ts.Expression, key: string | undefined, seen: Set<string>): Ink => {
    if (!ts.isIdentifier(base)) return NONE;
    const name = base.text;
    const local = consts.get(name);
    if (local && !seen.has(name)) {
      let init: ts.Expression = local;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) return objectInk(init, new Set([...seen, name]), key);
      return NONE;
    }
    return name in external ? externalInk(external[name], key) : NONE;
  };

  const analyse = (node: ts.Expression, seen: Set<string>): Ink => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
      return analyse(node.expression, seen);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return fromText(node.text);
    if (ts.isTemplateExpression(node)) {
      return join(fromText(node.head.text), ...node.templateSpans.flatMap((s) => [analyse(s.expression, seen), fromText(s.literal.text)]));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CLASS_HELPERS.has(node.expression.text)) {
      return join(...node.arguments.map((a) => analyse(a, seen)));
    }
    if (ts.isConditionalExpression(node)) return conditional(analyse(node.whenTrue, seen), analyse(node.whenFalse, seen));
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) return join(analyse(node.left, seen), analyse(node.right, seen));
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        return conditional(analyse(node.left, seen), analyse(node.right, seen));
      }
      return NONE;
    }
    if (ts.isIdentifier(node)) {
      const local = consts.get(node.text);
      if (local && !seen.has(node.text)) {
        let init: ts.Expression = local;
        while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
        // A whole record is not a class string (it is read with a key).
        if (ts.isObjectLiteralExpression(init) || ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return NONE;
        return analyse(init, new Set([...seen, node.text]));
      }
      return node.text in external ? externalInk(external[node.text]) : NONE;
    }
    if (ts.isPropertyAccessExpression(node)) return recordInk(node.expression, node.name.text, seen);
    if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      const key = ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : undefined;
      const ink = recordInk(node.expression, key, seen);
      return key === undefined ? conditional(ink) : ink;
    }
    return NONE;
  };

  /** Two parts compete when one always paints and another can paint a different colour (or one part paints two). */
  const competing = (parts: Ink[]): string[] | null => {
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].always.length === 0) continue;
      for (let j = 0; j < parts.length; j++) {
        const involved = new Set(i === j ? parts[i].always : [...parts[i].always, ...parts[j].maybe]);
        if (involved.size >= 2) return [...involved].sort();
      }
    }
    return null;
  };

  const conflicts: InkConflict[] = [];
  const report = (node: ts.Node, colours: string[]) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    conflicts.push({ line: line + 1, colours, tone: colours.some((c) => TONE_INK.test(c)), snippet: node.getText(sf).replace(/\s+/g, ' ').slice(0, 160) });
  };
  const seen = new Set<string>();
  const visit = (node: ts.Node) => {
    let parts: Ink[] | null = null;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CLASS_HELPERS.has(node.expression.text)) {
      parts = node.arguments.map((a) => analyse(a, seen));
    } else if (ts.isTemplateExpression(node)) {
      parts = [fromText(node.head.text), ...node.templateSpans.flatMap((s) => [analyse(s.expression, seen), fromText(s.literal.text)])];
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      parts = [fromText(node.text)];
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && !ts.isBinaryExpression(node.parent)) {
      parts = [analyse(node.left, seen), analyse(node.right, seen)];
    }
    const colours = parts && competing(parts);
    if (colours) report(node, colours);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return conflicts;
}

// ── Hand-rolled overlines (tests/config/overlineGuard.test.ts) ───────────────────────────────────

/** `uppercase` as a class (any variant prefix). */
const UPPERCASE = /(?<![\w-])(?:[\w\-[\]&:()>.*]+:)?uppercase(?![\w-])/g;
/**
 * The wide trackings eyebrows are hand-rolled with (any variant prefix): wide, wider, widest and any
 * positive arbitrary tracking (`tracking-[0.12em]`, `tracking-[.2em]`, `tracking-[1px]`).
 */
export const WIDE_TRACKING = /(?<![\w-])(?:[\w\-[\]&:()>.*]+:)?tracking-(?:wide|wider|widest|\[(?!-)[^\]\s]+\])(?![\w-])/;

/** An eyebrow-sized text (9–12.5 px, `text-xs`): small uppercase with no tracking at all is a hand-rolled eyebrow too. */
const SMALL_TEXT = /(?<![\w-])(?:[\w\-[\]&:()>.*]+:)?text-(?:xs|\[(?:9|10|11|12)(?:\.\d+)?px\])(?![\w-])/;
const ANY_TRACKING = /(?<![\w-])(?:[\w\-[\]&:()>.*]+:)?tracking-/;

const isLiteral = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateLiteralLikeNode =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);

/**
 * The class list a literal belongs to: climb while the parent only COMBINES class strings (a template,
 * `cx(…)` / `clsx(…)` / `cn(…)`, `+`, `&&` / `||` / `??`, a ternary, an array, parentheses, a JSX
 * `{…}`); stop at anything that uses the value (a declaration, an attribute, a property, another call).
 */
function classListOf(node: ts.Node): ts.Node {
  let at = node;
  for (;;) {
    const p = at.parent;
    if (!p) return at;
    const combines =
      ts.isTemplateSpan(p) ||
      ts.isTemplateExpression(p) ||
      ts.isParenthesizedExpression(p) ||
      ts.isConditionalExpression(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isJsxExpression(p) ||
      ts.isAsExpression(p) ||
      (ts.isBinaryExpression(p) &&
        [ts.SyntaxKind.PlusToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) ||
      (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && CLASS_HELPERS.has(p.expression.text) && p.arguments.includes(at as ts.Expression));
    if (!combines) return at;
    at = p;
  }
}

/** Every literal's raw text inside a node (the class names written there; code and comments excluded). */
function literalText(node: ts.Node, sf: ts.SourceFile): string {
  const parts: string[] = [];
  const visit = (n: ts.Node) => {
    if (isLiteral(n)) parts.push(n.getText(sf));
    ts.forEachChild(n, visit);
  };
  visit(node);
  return parts.join(' ');
}

/**
 * Hand-rolled eyebrows: each `uppercase` class written in a string or template literal whose class
 * list (see classListOf: one literal, one template, one `cx(…)` call with its conditionals, one JSX
 * `{…}` expression — however many lines it spans) also spells a wide tracking, or an eyebrow-sized
 * text with no tracking class at all (a plain `uppercase`). The studioDesign
 * recipes are constants, not literals in the file, so `cx('mb-1', OVERLINE)` is never a hit; a
 * file-local constant is a hit once, where its literal is written.
 */
export function findHandRolledOverlines(source: string): Array<{ line: number; snippet: string }> {
  const sf = ts.createSourceFile('file.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: Array<{ line: number; snippet: string }> = [];
  const lines = source.split('\n');
  const visit = (node: ts.Node) => {
    if (isLiteral(node)) {
      const raw = node.getText(sf);
      const start = node.getStart(sf);
      for (const m of raw.matchAll(UPPERCASE)) {
        const list = literalText(classListOf(node), sf);
        // Small text with no tracking counts for a plain `uppercase` only (`first-letter:uppercase` capitalises a sentence).
        if (!WIDE_TRACKING.test(list) && !(m[0] === 'uppercase' && SMALL_TEXT.test(list) && !ANY_TRACKING.test(list))) continue;
        const { line } = sf.getLineAndCharacterOfPosition(start + m.index!);
        hits.push({ line: line + 1, snippet: lines[line].trim().slice(0, 160) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/**
 * Every class list in a source (see classListOf), once each: its first line and all the class names
 * written in it (the literals of a `cx(…)` call with its conditionals, a template, a JSX `{…}`).
 */
export function classListsOf(source: string): Array<{ line: number; classes: string }> {
  const sf = ts.createSourceFile('file.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const seen = new Set<ts.Node>();
  const out: Array<{ line: number; classes: string }> = [];
  const visit = (node: ts.Node) => {
    if (isLiteral(node)) {
      const list = classListOf(node);
      if (!seen.has(list)) {
        seen.add(list);
        out.push({ line: sf.getLineAndCharacterOfPosition(list.getStart(sf)).line + 1, classes: literalText(list, sf) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * An allowlist entry pins WHAT it permits (each hit's key: the token, or the trimmed source line), not
 * how many: a different raw use cannot take an allowed one's place. Returns the hits the pinned list
 * does not cover and the pinned keys no hit used (stale).
 */
export function matchPinned(hits: string[], pinned: readonly string[] = []): { extra: string[]; missing: string[] } {
  const left = [...pinned];
  const extra: string[] = [];
  for (const key of hits) {
    const i = left.indexOf(key);
    if (i >= 0) left.splice(i, 1);
    else extra.push(key);
  }
  return { extra, missing: left };
}
