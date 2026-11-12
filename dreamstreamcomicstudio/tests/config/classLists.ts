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
 *
 * It also holds the app-wide scan and the ratchet every design-system guard shares (DS-0, see the
 * section "App-wide scanning and the ratchet" below and tests/config/baselines/README.md).
 * Not a test file (no `.test.` in the name), so vitest does not collect it; the typecheck covers it.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * The parser's language for a file, from its extension. A `.ts` file must be read as TypeScript, not
 * TSX: there `<T>(v: T) => …` is a generic arrow and `<T>value` a type assertion, while TSX reads either
 * as a JSX opening tag and loses (or turns into JSX text) every literal after it. `.js` / `.mjs` /
 * `.cjs` read as JavaScript (which TypeScript parses with JSX allowed), `.jsx` as JSX, and anything else
 * — the in-memory snippets the detector tests pass without a name — as TSX.
 */
export function scriptKindOf(fileName: string): ts.ScriptKind {
  if (/\.tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.(?:mjs|cjs|js)$/.test(fileName)) return ts.ScriptKind.JS;
  if (/\.(?:mts|cts|ts)$/.test(fileName)) return ts.ScriptKind.TS;
  return ts.ScriptKind.TSX;
}

/** A source's syntax tree, parsed in the language its file name implies (scriptKindOf). */
const parseSource = (source: string, fileName: string): ts.SourceFile =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));

/**
 * The syntax errors the guards' parser reports for a source, as `fileName:line message`. A guard reads a
 * file in full only when this is empty: after an error the parser recovers by guessing, and the literals
 * it guesses past are lost or become JSX text (the `.ts`-read-as-TSX bug). The ratchet test asserts it
 * for every scanned file.
 */
export function parseErrorsOf(source: string, fileName = 'file.tsx'): string[] {
  const sf = parseSource(source, fileName);
  // parseDiagnostics is the parser's own list (not in the public typings; the ratchet test checks it is read).
  const diagnostics = (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  return diagnostics.map((d) => `${fileName}:${sf.getLineAndCharacterOfPosition(d.start).line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}

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
 * `external` maps imported constant names to their values (the studioDesign module); `fileName` picks the
 * parser's language (see scriptKindOf: pass the file's path when scanning a `.ts` file).
 */
export function findCompetingInks(source: string, external: Record<string, unknown> = {}, fileName = 'file.tsx'): InkConflict[] {
  const sf = parseSource(source, fileName);
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
 * file-local constant is a hit once, where its literal is written. A scan passes the file's path as
 * `fileName`, so a `.ts` file is parsed as TypeScript (scriptKindOf).
 */
export function findHandRolledOverlines(source: string, fileName = 'file.tsx'): Array<{ line: number; snippet: string }> {
  const sf = parseSource(source, fileName);
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
 * A scan passes the file's path as `fileName` (scriptKindOf).
 */
export function classListsOf(source: string, fileName = 'file.tsx'): Array<{ line: number; classes: string }> {
  const sf = parseSource(source, fileName);
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

// ── App-wide scanning and the ratchet (DS-0) ─────────────────────────────────────────────────────
//
// The design-system guards (tests/config/{legacyKit,terracotta,localCx,zLadder}Guard.test.ts and the
// widened statusInkGuard / overlineGuard / dialogTitle) scan the whole app, not only Comic Studio. The
// app still carries about 1,750 legacy uses that predate them, so outside the exact-line pins they
// RATCHET: tests/config/baselines/<guard>.json records, per file and per token, how many uses each file
// had when the guard landed. A file or token the baseline does not list must count 0; a count above its
// entry fails (a new use); a count BELOW its entry fails too, until the entry is lowered, so a
// migration's gain is locked in and the numbers only ever fall. Entries are generated, never typed:
// `UPDATE_BASELINES=1 npx vitest run tests/config/<guard test>` lowers every entry to today's count and
// drops the zeros (it never raises one), after renaming the files `BASELINE_MOVES='old=new'` names (a moved
// file keeps its entry); `UPDATE_BASELINES=reset` rewrites the file from the tree (the first generation,
// or a reviewed exception: the JSON diff shows the rise). Every file is parsed in its own language
// (scriptKindOf), so a `.ts` file's generic arrow never hides a literal. See baselines/README.md.

/** The app directory (`dreamstreamcomicstudio/`). Every path the scan reports is relative to it, with `/`. */
export const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The time a real-tree scan may take (it parses every scanned file, about 600): vitest's 5 s default is
 * too tight when the full suite runs it beside other workers.
 */
export const REAL_TREE_TIMEOUT = 60_000;

/** What every app-wide guard scans: the components, the root App and the QA harness. */
export const SCANNED_ROOTS: readonly string[] = ['components', 'App.tsx', 'qa'];

/**
 * Never scanned by an app-wide guard: tests and specs, the folders only tests read, and Stream Studio
 * (`live/**`: its own brand and tokens until DS-11; outside the roots today, excluded in case one grows).
 */
export const EXCLUDED: readonly string[] = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/__mocks__/**', '**/__fixtures__/**', 'live/**'];

/** The recipe files, where z-indexes and tokens are spelled on purpose (skipped by the z-ladder guard). */
export const RECIPE_FILES: readonly string[] = ['components/ds/**', 'components/chat/studioDesign.ts'];

/** Comic Studio: the three wave 8 guards keep their exact-line pins here; their ratchet covers the rest. */
export const PINNED_DIR = 'components/comicstudio/**';

const SOURCE_FILE = /\.(?:tsx?|jsx?|mjs)$/;

/** A path glob (`*` within a segment, `**` across segments, `?` one character) as an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` is zero or more whole directories; any other `**` is the rest of the path.
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * A fresh OS temp folder holding the given app-relative files, for a guard's scan to run on (tests only:
 * never the repository). The caller removes it.
 */
export function tempTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ds0-tree-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
}

/** Whether an app-relative path matches any of the globs. */
export const matchesGlob = (rel: string, globs: readonly string[]): boolean => globs.some((g) => globToRegExp(g).test(rel));

/**
 * The app-relative source files (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`) under the roots, sorted, minus
 * EXCLUDED and any extra globs. A root may be a directory or a single file; one that does not exist
 * is skipped (the guards assert the count, so a broken scan cannot pass empty).
 */
export function listScannedFiles(options: { roots?: readonly string[]; exclude?: readonly string[]; root?: string } = {}): string[] {
  const root = options.root ?? APP_ROOT;
  const exclude = [...EXCLUDED, ...(options.exclude ?? [])];
  const out: string[] = [];
  const walk = (rel: string) => {
    const full = path.join(root, rel);
    if (!existsSync(full)) return;
    if (statSync(full).isDirectory()) {
      for (const entry of readdirSync(full)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        walk(`${rel}/${entry}`);
      }
    } else if (SOURCE_FILE.test(rel) && !matchesGlob(rel, exclude)) out.push(rel);
  };
  for (const r of options.roots ?? SCANNED_ROOTS) walk(r.replace(/\/+$/, ''));
  return [...new Set(out)].sort();
}

/**
 * A Tailwind variant chain before a utility (`dark:`, `hover:`, `md:`, `group-hover/place:`,
 * `[&_svg]:`, `@lg:`) and the `!` important modifier, as the wave 8 guards read it. Put it right after a
 * `(?<![\w-])` boundary.
 */
export const VARIANT = String.raw`(?:[\w\-[\]&:()>.*/@]+:)?!?`;

/** A matched class without its variant chain or `!` (`dark:hover:!z-50` → `z-50`). */
export const withoutVariant = (cls: string): string => cls.replace(/^.*:/, '').replace(/^!/, '');

/** A Tailwind opacity suffix (`/80`, `/[0.35]`) removed: the ratchet counts the colour, not its strength. */
export const withoutOpacity = (cls: string): string => cls.replace(/\/(?:\d+|\[[^\]]*\])$/, '');

const isModuleSpecifier = (node: ts.Node): boolean => {
  const p = node.parent;
  if (!p) return false;
  if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === node) return true;
  if (ts.isExternalModuleReference(p)) return true;
  // import('…') and require('…')
  return ts.isCallExpression(p) && (p.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(p.expression) && p.expression.text === 'require'));
};

/**
 * Every string and template literal in a source with the line it starts on, as written (quotes and
 * `${` / `}` included, so a token at an edge keeps its boundary). Comments, JSX text, identifiers,
 * regular expressions and module specifiers are not literals here, so a comment that explains a rule
 * ("never `shadow-comic`") or a visible sentence never counts. A scan passes the file's path as
 * `fileName`, so a `.ts` file is parsed as TypeScript (scriptKindOf); in-memory snippets default to TSX.
 */
export function literalsOf(source: string, fileName = 'file.tsx'): Array<{ line: number; text: string }> {
  const sf = parseSource(source, fileName);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (isLiteral(node) && !isModuleSpecifier(node)) {
      out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.getText(sf) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** One use a guard counts: where it is, its ratchet token, the text it matched and its trimmed source line. */
export interface TokenHit {
  line: number;
  token: string;
  match: string;
  text: string;
}

/**
 * Every match of a global pattern inside the literals of a source (see literalsOf), each named by
 * `token(match)` (the per-token key of the ratchet). `fileName` as in literalsOf.
 */
export function findInLiterals(source: string, pattern: RegExp, token: (match: string) => string, fileName = 'file.tsx'): TokenHit[] {
  if (!pattern.global) throw new Error(`findInLiterals needs a global pattern: ${pattern}`);
  const lines = source.split('\n');
  const hits: TokenHit[] = [];
  for (const lit of literalsOf(source, fileName)) {
    for (const m of lit.text.matchAll(pattern)) {
      const line = lit.line + (lit.text.slice(0, m.index).match(/\n/g)?.length ?? 0);
      hits.push({ line, token: token(m[0]), match: m[0], text: (lines[line - 1] ?? '').trim() });
    }
  }
  return hits;
}

/** Per-token counts for one file, and for the tree (app-relative file → token → count). */
export type FileCounts = Record<string, number>;
export type Counts = Record<string, FileCounts>;

export const countTokens = (hits: ReadonlyArray<{ token: string }>): FileCounts => {
  const counts: FileCounts = {};
  for (const h of hits) counts[h.token] = (counts[h.token] ?? 0) + 1;
  return counts;
};

/**
 * A guard's content exemptions, keyed by app-relative path: each pins the exact uses it permits (the
 * token and its trimmed source line), never a count, with a one-line reason. A pinned use is content
 * (reader content tokens, lettering, a third-party mark, a data-viz palette), not legacy chrome, so it is
 * not counted at all; a different use in the same file still is.
 */
export type Allowlist = Record<string, { uses: Array<{ token: string; line: string }>; reason: string }>;

const useKeyOf = (u: { token: string; line: string }) => `${u.token}  @  ${u.line}`;

/** One file's hits minus its allowlisted uses, and the pinned uses no hit matched (stale). */
export function applyAllowlist(rel: string, hits: readonly TokenHit[], allowlist: Allowlist = {}): { counted: TokenHit[]; stale: string[] } {
  const entry = allowlist[rel];
  if (!entry) return { counted: [...hits], stale: [] };
  const { extra, missing } = matchPinned(
    hits.map((h) => useKeyOf({ token: h.token, line: h.text })),
    entry.uses.map(useKeyOf)
  );
  const left = [...extra];
  const counted = hits.filter((h) => {
    const i = left.indexOf(useKeyOf({ token: h.token, line: h.text }));
    if (i < 0) return false;
    left.splice(i, 1);
    return true;
  });
  return { counted, stale: missing };
}

/**
 * Scans files (app-relative) with a guard's detector and returns the per-file per-token counts (files
 * with none are left out), the stale allowlist pins and the allowlisted files that were not scanned.
 */
export function scanTree(
  files: readonly string[],
  hitsOf: (rel: string, source: string) => TokenHit[],
  allowlist: Allowlist = {},
  root = APP_ROOT
): { counts: Counts; stale: string[]; hits: Record<string, TokenHit[]> } {
  const counts: Counts = {};
  const hits: Record<string, TokenHit[]> = {};
  const stale: string[] = [];
  const seen = new Set<string>();
  for (const rel of files) {
    seen.add(rel);
    const { counted, stale: s } = applyAllowlist(rel, hitsOf(rel, readFileSync(path.join(root, rel), 'utf8')), allowlist);
    for (const key of s) stale.push(`${rel}: allowlisted use no longer present: ${key} (${allowlist[rel].reason})`);
    if (counted.length) {
      counts[rel] = countTokens(counted);
      hits[rel] = counted;
    }
  }
  for (const rel of Object.keys(allowlist)) if (!seen.has(rel)) stale.push(`${rel}: allowlisted but not scanned (moved or deleted?)`);
  return { counts, stale, hits };
}

// ── The baselines ────────────────────────────────────────────────────────────────────────────────

export const BASELINE_DIR = path.join(APP_ROOT, 'tests', 'config', 'baselines');

/** `tests/config/baselines/<guard>.json`. `totals` is derived (the sum per token) and checked. */
export interface BaselineFile {
  guard: string;
  test: string;
  note: string;
  totals: FileCounts;
  files: Counts;
}

/** `UPDATE_BASELINES`: unset / `0` / `false` checks; `reset` rewrites from the tree; anything else (`1`) only lowers. */
export type RatchetMode = 'check' | 'shrink' | 'reset';
export function ratchetMode(value: string | undefined = process.env.UPDATE_BASELINES): RatchetMode {
  const v = (value ?? '').trim().toLowerCase();
  if (!v || v === '0' || v === 'false' || v === 'no') return 'check';
  return v === 'reset' ? 'reset' : 'shrink';
}

/** The sum per token over every file. */
export function totalsOf(counts: Counts): FileCounts {
  const totals: FileCounts = {};
  for (const tokens of Object.values(counts)) for (const [t, n] of Object.entries(tokens)) totals[t] = (totals[t] ?? 0) + n;
  return sortKeys(totals);
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The command that lowers a guard's baseline. */
export const shrinkCommand = (testFile: string) => `UPDATE_BASELINES=1 npx vitest run ${testFile}`;

/**
 * The ratchet itself. `over`: a file or token above its baseline entry (absent = 0) — a new use.
 * `under`: below its entry (a file that no longer exists counts 0) — the entry must be lowered so the
 * gain cannot be spent again. Each line names the file, the token, the count, the baseline and the fix.
 */
export function compareToBaseline(actual: Counts, baseline: Counts, testFile: string): { over: string[]; under: string[] } {
  const over: string[] = [];
  const under: string[] = [];
  const files = [...new Set([...Object.keys(actual), ...Object.keys(baseline)])].sort();
  for (const rel of files) {
    const a = actual[rel] ?? {};
    const b = baseline[rel] ?? {};
    for (const token of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const n = a[token] ?? 0;
      const base = b[token] ?? 0;
      if (n > base) {
        over.push(
          base === 0
            ? `${rel}  ${token}: ${n}, baseline 0 — a file or token the baseline does not list must count 0`
            : `${rel}  ${token}: ${n}, baseline ${base} — ${n - base} new use${n - base === 1 ? '' : 's'}`
        );
      } else if (n < base) {
        under.push(
          `${rel}  ${token}: ${n}, baseline ${base} — the count fell: lower the baseline to ${n} (${shrinkCommand(testFile)}) so the gain is kept`
        );
      }
    }
  }
  return { over, under };
}

/**
 * Renames applied to a baseline before it is lowered (`BASELINE_MOVES`, README "Moving a file"): old
 * app-relative path → new one. Without them a moved file fails twice (over at its new path, under at its
 * old one) and only a reset, which rewrites every entry, would record it. A key ending in `/` moves a
 * whole folder (`components/comicstudio/editor/kit/` → `components/ds/creative/`).
 */
export type BaselineMoves = Record<string, string>;

/**
 * `BASELINE_MOVES` as moves: `old=new` pairs separated by commas, semicolons or whitespace. A folder
 * move names folders on both sides (each ends in `/`). Anything else is an error, never a silent no-op.
 */
export function parseMoves(value: string | undefined = process.env.BASELINE_MOVES): BaselineMoves {
  const moves: BaselineMoves = {};
  const bad = (p: string) => p.startsWith('/') || p.split('/').includes('..');
  for (const pair of (value ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const m = /^([^=]+)=([^=]+)$/.exec(pair);
    if (!m || m[1] === m[2] || m[1].endsWith('/') !== m[2].endsWith('/') || bad(m[1]) || bad(m[2])) {
      throw new Error(`BASELINE_MOVES: "${pair}" is not old=new (app-relative paths; a folder ends in / on both sides)`);
    }
    moves[m[1]] = m[2];
  }
  return moves;
}

/**
 * A baseline with its moved files renamed (folders by prefix). Files moved onto one path add up: the
 * uses they carried together, never more. Everything else is unchanged.
 */
export function moveBaseline(baseline: Counts, moves: BaselineMoves): Counts {
  const target = (rel: string): string => {
    if (rel in moves) return moves[rel];
    const folder = Object.keys(moves).find((from) => from.endsWith('/') && rel.startsWith(from));
    return folder ? moves[folder] + rel.slice(folder.length) : rel;
  };
  const out: Counts = {};
  for (const [rel, tokens] of Object.entries(baseline)) {
    const to = (out[target(rel)] ??= {});
    for (const [token, n] of Object.entries(tokens)) to[token] = (to[token] ?? 0) + n;
  }
  return out;
}

/**
 * The baseline lowered to the tree where the tree is lower, zeros dropped; never raised, never extended.
 * `moves` renames moved files first (moveBaseline), so their entries follow them.
 */
export function shrinkBaseline(actual: Counts, baseline: Counts, moves: BaselineMoves = {}): Counts {
  const out: Counts = {};
  for (const [rel, tokens] of Object.entries(moveBaseline(baseline, moves))) {
    const kept: FileCounts = {};
    for (const [token, base] of Object.entries(tokens)) {
      const n = Math.min(base, actual[rel]?.[token] ?? 0);
      if (n > 0) kept[token] = n;
    }
    if (Object.keys(kept).length) out[rel] = kept;
  }
  return out;
}

/** A baseline as checked-in JSON: one line per file, keys sorted, so a shrink is a one-line diff. */
export function serialiseBaseline(guard: string, testFile: string, counts: Counts): string {
  const files = sortKeys(Object.fromEntries(Object.entries(counts).filter(([, t]) => Object.values(t).some((n) => n > 0)).map(([f, t]) => [f, sortKeys(Object.fromEntries(Object.entries(t).filter(([, n]) => n > 0)))])));
  const note =
    'Ratchet baseline: per-file, per-token counts of the uses that predate the guard. A file or token not listed must count 0; ' +
    'a count above its entry fails; a count below fails until the entry is lowered. Generated, never typed: ' +
    `${shrinkCommand(testFile)} lowers it (see README.md).`;
  const line = (record: FileCounts) => {
    const parts = Object.entries(record).map(([k, n]) => `${JSON.stringify(k)}: ${n}`);
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  };
  const body = Object.entries(files).map(([f, t]) => `    ${JSON.stringify(f)}: ${line(t)}`);
  return [
    '{',
    `  "guard": ${JSON.stringify(guard)},`,
    `  "test": ${JSON.stringify(testFile)},`,
    `  "note": ${JSON.stringify(note)},`,
    `  "totals": ${line(totalsOf(files))},`,
    body.length ? `  "files": {\n${body.join(',\n')}\n  }` : '  "files": {}',
    '}',
    ''
  ].join('\n');
}

/** Reads and validates a baseline file; `problems` explains anything that is not a clean, consistent file. */
export function readBaseline(guard: string, dir = BASELINE_DIR): { baseline: Counts; problems: string[]; exists: boolean } {
  const file = path.join(dir, `${guard}.json`);
  if (!existsSync(file)) return { baseline: {}, problems: [], exists: false };
  const problems: string[] = [];
  let parsed: Partial<BaselineFile>;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BaselineFile>;
  } catch (e) {
    return { baseline: {}, problems: [`${guard}.json is not valid JSON (${(e as Error).message})`], exists: true };
  }
  if (parsed.guard !== guard) problems.push(`${guard}.json names guard ${JSON.stringify(parsed.guard)}`);
  const baseline: Counts = {};
  for (const [rel, tokens] of Object.entries(parsed.files ?? {})) {
    baseline[rel] = {};
    for (const [token, n] of Object.entries(tokens ?? {})) {
      if (!Number.isInteger(n) || n <= 0) problems.push(`${guard}.json: ${rel} ${token} is ${JSON.stringify(n)} (entries are positive integers; drop a zero)`);
      else baseline[rel][token] = n;
    }
  }
  if (JSON.stringify(sortKeys(parsed.totals ?? {})) !== JSON.stringify(totalsOf(baseline))) {
    problems.push(`${guard}.json: "totals" does not match "files" (regenerate it: ${shrinkCommand(parsed.test ?? `tests/config/<${guard} guard>.test.ts`)})`);
  }
  return { baseline, problems, exists: true };
}

/**
 * Compares a guard's counts with its baseline, first applying `UPDATE_BASELINES` (see ratchetMode):
 * `shrink` lowers the file and drops the zeros (what is over stays over and still fails), after renaming
 * the files `BASELINE_MOVES` names (parseMoves); `reset` rewrites it from the counts. Returns the over /
 * under lines and any problem with the file itself.
 */
export function ratchet(
  guard: string,
  testFile: string,
  actual: Counts,
  options: { mode?: RatchetMode; dir?: string; moves?: BaselineMoves } = {}
): { over: string[]; under: string[]; problems: string[]; written: boolean } {
  const dir = options.dir ?? BASELINE_DIR;
  const mode = options.mode ?? ratchetMode();
  const moves = options.moves ?? parseMoves();
  let { baseline, problems, exists } = readBaseline(guard, dir);
  let written = false;
  if (mode === 'reset' || (mode === 'shrink' && exists && problems.length === 0)) {
    const next = mode === 'reset' ? actual : shrinkBaseline(actual, baseline, moves);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${guard}.json`), serialiseBaseline(guard, testFile, next));
    written = true;
    ({ baseline, problems, exists } = readBaseline(guard, dir));
  }
  if (!exists) problems.push(`no baseline tests/config/baselines/${guard}.json: generate it from the tree with UPDATE_BASELINES=reset npx vitest run ${testFile}`);
  if (mode !== 'shrink' && Object.keys(moves).length) problems.push(`BASELINE_MOVES only applies with UPDATE_BASELINES=1 (${shrinkCommand(testFile)})`);
  return { ...compareToBaseline(actual, baseline, testFile), problems, written };
}
