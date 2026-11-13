// @vitest-environment node
/**
 * Overflow guard (SPEC-overflow §7.2; docs/design/design-system.md "Long words"): the static half of "nothing spills or
 * gets cut". Five rules, counted per file and per rule, RATCHETED against tests/config/baselines/overflow.json (the
 * counts that predate the guard; they only fall: `UPDATE_BASELINES=1 npx vitest run tests/config/overflowGuard.test.ts`).
 *
 *   nowrapNoClip        G1  a class list with `whitespace-nowrap` / `text-nowrap` and none of `truncate`, `text-ellipsis`,
 *                           `line-clamp-*`, `overflow-(x-)hidden|auto|scroll|clip`: one line that can only push past its
 *                           box. Use CLIP_TEXT (an ellipsis) or WRAP_TEXT. Scanned roots minus the recipe files.
 *   breakWords          G2  `break-words`: it breaks a long word but does not lower min-content, so a flex child still
 *                           cannot shrink (research R5). Use WRAP_TEXT. Every scanned file.
 *   maxHNoOverflow      G4  a class list with `max-h-*` and no `overflow-*`: content past the cap draws over what follows.
 *                           Every scanned file.
 *   rawErrorText        G5a `err.message` / `e.message` / `error.message` / `ex.message` / `outcome.message` /
 *                           `viaApi.message` / `result.message` / `res.message` / `state.message` (optional chains too)
 *                           read in source: raw error text on its way to a screen.
 *   rawErrorSink        G5b a `setError` / `setMessage` / `setNotice` / `setStatus` call whose arguments hold `.message`,
 *                           `.error` or `String(e|err|error)`. G5 scope: components/** and App.tsx, minus admin screens,
 *                           components/comicstudio/calmError.ts, services/authErrorCopy.ts and studioApi.ts (the mappers
 *                           themselves).
 *   dynamicButtonLabel  G6  a `<Button>` whose children hold an expression whose last identifier is `model`, `modelId`,
 *                           `id`, `slug`, `url`, `path`, `file`, `fileName`, or ends in one after a camelCase boundary
 *                           (`userId`, `projectUrl`; not `isPaid`, `valid`, `grid`). A Button label is a verb, not an id:
 *                           its span ends in an ellipsis, so an id there would be cut. Every scanned file.
 *
 * G3 (edge-anchored popovers) is not a class rule: tests/e2e/overflow.spec.ts measures opened popovers on screen.
 */
import { rmSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  APP_ROOT,
  type Counts,
  classListsOf,
  compareToBaseline,
  countTokens,
  findInLiterals,
  listScannedFiles,
  matchesGlob,
  ratchet,
  readBaseline,
  REAL_TREE_TIMEOUT,
  RECIPE_FILES,
  scanTree,
  scriptKindOf,
  tempTree,
  type TokenHit,
  VARIANT
} from './classLists';

const GUARD = 'overflow';
const TEST_FILE = 'tests/config/overflowGuard.test.ts';

export const OVERFLOW_RULES = ['nowrapNoClip', 'breakWords', 'maxHNoOverflow', 'rawErrorText', 'rawErrorSink', 'dynamicButtonLabel'] as const;
export type OverflowRule = (typeof OVERFLOW_RULES)[number];

const cls = (body: string) => new RegExp(String.raw`(?<![\w-])${VARIANT}(?:${body})(?![\w-])`);
const NOWRAP = cls('whitespace-nowrap|text-nowrap');
const CLIPS = cls(String.raw`truncate|text-ellipsis|line-clamp-[\w[\]]+|overflow-(?:x-)?(?:hidden|auto|scroll|clip)`);
const MAX_H = cls(String.raw`max-h-[\w[\].()%-]+`);
const ANY_OVERFLOW = cls(String.raw`overflow-[\w-]+`);
const BREAK_WORDS = new RegExp(String.raw`(?<![\w-])${VARIANT}break-words(?![\w-])`, 'g');

/** G5's receivers and sinks. */
const ERROR_RECEIVERS = new Set(['err', 'e', 'error', 'ex', 'outcome', 'viaApi', 'result', 'res', 'state']);
const ERROR_SINKS = new Set(['setError', 'setMessage', 'setNotice', 'setStatus']);
const SINK_ARG = /\.message\b|\.error\b|\bString\(\s*(?:e|err|error)\s*\)/;
/** G5 scope: the app's screens, minus admin and the error mappers themselves. */
const G5_ROOTS = ['components/**', 'App.tsx'];
const G5_EXCLUDE = ['**/admin/**', 'components/comicstudio/calmError.ts', 'services/authErrorCopy.ts', 'components/comicstudio/studioApi.ts'];

/** G6: an identifier that names an id-like value. */
const ID_LIKE = /^(?:model|modelId|id|slug|url|path|file|fileName)$|[a-z0-9](?:Model|ModelId|Id|Slug|Url|Path|File|FileName)$/;

const hit = (sf: ts.SourceFile, lines: string[], node: ts.Node, token: OverflowRule): TokenHit => {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  return { line, token, match: node.getText(sf).slice(0, 80), text: (lines[line - 1] ?? '').trim() };
};

const lastIdentifier = (node: ts.Expression): string | null => {
  let e: ts.Expression = node;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
};

/** Every G1/G2/G4 hit in a source's class lists and literals. */
export function findClassHits(source: string, fileName = 'file.tsx', opts: { recipe?: boolean } = {}): TokenHit[] {
  const lines = source.split('\n');
  const out: TokenHit[] = [];
  for (const { line, classes } of classListsOf(source, fileName)) {
    const text = (lines[line - 1] ?? '').trim();
    if (!opts.recipe && NOWRAP.test(classes) && !CLIPS.test(classes)) out.push({ line, token: 'nowrapNoClip', match: classes.slice(0, 80), text });
    if (MAX_H.test(classes) && !ANY_OVERFLOW.test(classes)) out.push({ line, token: 'maxHNoOverflow', match: classes.slice(0, 80), text });
  }
  out.push(...findInLiterals(source, BREAK_WORDS, () => 'breakWords', fileName));
  return out;
}

/** Every G5 (a: a raw read, b: a raw sink) and G6 hit in a source's syntax. */
export function findSyntaxHits(source: string, fileName = 'file.tsx', opts: { errors?: boolean } = { errors: true }): TokenHit[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
  const lines = source.split('\n');
  const out: TokenHit[] = [];
  const visit = (node: ts.Node) => {
    if (opts.errors && ts.isPropertyAccessExpression(node) && node.name.text === 'message' && ts.isIdentifier(node.expression) && ERROR_RECEIVERS.has(node.expression.text)) {
      out.push(hit(sf, lines, node, 'rawErrorText'));
    }
    if (opts.errors && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ERROR_SINKS.has(node.expression.text)) {
      if (node.arguments.some((a) => SINK_ARG.test(a.getText(sf)))) out.push(hit(sf, lines, node, 'rawErrorSink'));
    }
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === 'Button') {
      for (const child of node.children) {
        if (ts.isJsxExpression(child) && child.expression) {
          const name = lastIdentifier(child.expression);
          if (name && ID_LIKE.test(name)) out.push(hit(sf, lines, child, 'dynamicButtonLabel'));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** All the guard's hits for one app-relative file, each rule in its own scope. */
export function overflowHitsOf(rel: string, source: string): TokenHit[] {
  const recipe = matchesGlob(rel, RECIPE_FILES);
  const errors = matchesGlob(rel, G5_ROOTS) && !matchesGlob(rel, G5_EXCLUDE);
  return [...findClassHits(source, rel, { recipe }), ...findSyntaxHits(source, rel, { errors })];
}

export function overflowScan(root = APP_ROOT) {
  const files = listScannedFiles({ root });
  return { files, ...scanTree(files, overflowHitsOf, {}, root) };
}

const tokensOf = (hits: TokenHit[]) => hits.map((h) => h.token);

describe('overflow guard — the detectors', () => {
  it('G1 nowrapNoClip: one line with nothing to cut it; a clip, an ellipsis or a clamp in the same list is fine', () => {
    expect(tokensOf(findClassHits('<span className="whitespace-nowrap px-2">x</span>'))).toEqual(['nowrapNoClip']);
    expect(tokensOf(findClassHits('<span className="sm:text-nowrap">x</span>'))).toEqual(['nowrapNoClip']);
    expect(tokensOf(findClassHits("<span className={cn('whitespace-nowrap', open && 'gap-1')}>x</span>"))).toEqual(['nowrapNoClip']);
    for (const ok of ['whitespace-nowrap truncate', 'whitespace-nowrap overflow-hidden text-ellipsis', 'whitespace-nowrap overflow-x-auto', 'whitespace-nowrap line-clamp-2', 'whitespace-normal']) {
      expect(findClassHits(`<span className="${ok}">x</span>`), ok).toEqual([]);
    }
    // The recipe files define the shapes (CHIP is nowrap by design): G1 skips them.
    expect(findClassHits("export const CHIP = 'inline-flex whitespace-nowrap';", 'x.ts', { recipe: true })).toEqual([]);
  });

  it('G2 breakWords and G4 maxHNoOverflow', () => {
    expect(tokensOf(findClassHits('<p className="break-words md:break-words">x</p>'))).toEqual(['breakWords', 'breakWords']);
    expect(findClassHits('<p className="break-all [overflow-wrap:anywhere]">x</p>')).toEqual([]);
    expect(tokensOf(findClassHits('<div className="max-h-60 p-2">x</div>'))).toEqual(['maxHNoOverflow']);
    expect(tokensOf(findClassHits('<div className="max-h-[50vh]">x</div>'))).toEqual(['maxHNoOverflow']);
    expect(findClassHits('<div className="max-h-60 overflow-y-auto">x</div>')).toEqual([]);
    expect(findClassHits('<div className="max-w-60 h-10">x</div>')).toEqual([]);
  });

  it('G5 rawErrorText reads and rawErrorSink calls; comments and visible text never count', () => {
    const src = [
      'try { go(); } catch (err) { show(err.message); }',
      'const t = e?.message ?? "";',
      'setError(String(error));',
      'setNotice(res.error || "x");',
      'setStatus("Saved");',
      'const m = person.message;',
      '// err.message is never shown',
      'const p = <p>err.message</p>;'
    ].join('\n');
    expect(findSyntaxHits(src).map((h) => [h.line, h.token])).toEqual([
      [1, 'rawErrorText'],
      [2, 'rawErrorText'],
      [3, 'rawErrorSink'],
      [4, 'rawErrorSink']
    ]);
    expect(findSyntaxHits(src, 'file.tsx', { errors: false })).toEqual([]);
  });

  it('G6 dynamicButtonLabel: an id-like expression in a Button; a camelCase boundary is required', () => {
    const flagged = ['{model}', '{modelId}', '{c.id}', '{page.slug}', '{share.url}', '{asset.path}', '{file}', '{upload.fileName}', '{userId}', '{projectUrl}', '{props.styleModel}'];
    for (const expr of flagged) expect(tokensOf(findSyntaxHits(`const x = <Button>Use ${expr}</Button>;`)), expr).toEqual(['dynamicButtonLabel']);
    const fine = ['{isPaid}', '{valid}', '{grid}', '{label}', '{count} pages', '{t.title}'];
    for (const expr of fine) expect(findSyntaxHits(`const x = <Button>Use ${expr}</Button>;`), expr).toEqual([]);
    expect(findSyntaxHits('const x = <GhostButton>{modelId}</GhostButton>;')).toEqual([]);
  });

  it('scopes: G1 skips the recipe files, G5 skips admin, the mappers and qa/**; the rest read every scanned file', () => {
    const nowrap = "export const A = 'whitespace-nowrap';\n";
    const raw = 'export const f = (err: Error) => err.message;\n';
    const root = tempTree({
      'components/ds/Pill.tsx': nowrap,
      'components/chat/studioDesign.ts': nowrap,
      'components/x.tsx': nowrap + raw,
      'components/admin/Panel.tsx': raw,
      'components/comicstudio/studioApi.ts': raw,
      'qa/app/scenes/s.tsx': raw,
      'App.tsx': raw
    });
    try {
      const { counts } = overflowScan(root);
      expect(counts).toEqual({ 'App.tsx': { rawErrorText: 1 }, 'components/x.tsx': { nowrapNoClip: 1, rawErrorText: 1 } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('overflow guard — the ratchet', () => {
  const { baseline } = readBaseline(GUARD);
  const PLANTED = 'components/__planted__/Fixture.tsx';
  const plants: Record<OverflowRule, string> = {
    nowrapNoClip: 'export const F = () => <span className="whitespace-nowrap">x</span>;\n',
    breakWords: 'export const F = () => <p className="break-words">x</p>;\n',
    maxHNoOverflow: 'export const F = () => <div className="max-h-40">x</div>;\n',
    rawErrorText: 'export const f = (err: Error) => err.message;\n',
    rawErrorSink: 'declare const setError: (s: string) => void; export const f = (e: unknown) => setError(String(e));\n',
    dynamicButtonLabel: 'declare const Button: any; export const F = ({ modelId }: { modelId: string }) => <Button>{modelId}</Button>;\n'
  };

  it('one planted offender of each rule fails, naming the file, the rule and the count', () => {
    for (const rule of OVERFLOW_RULES) {
      const actual: Counts = { ...baseline, [PLANTED]: countTokens(overflowHitsOf(PLANTED, plants[rule])) };
      expect(compareToBaseline(actual, baseline, TEST_FILE), rule).toEqual({
        over: [`${PLANTED}  ${rule}: 1, baseline 0 — a file or token the baseline does not list must count 0`],
        under: []
      });
    }
  });

  it('removing one use from a baselined file fails until the baseline is lowered', () => {
    const [rel, tokens] = Object.entries(baseline)[0];
    const [token, n] = Object.entries(tokens)[0];
    const fewer: Counts = { ...baseline, [rel]: { ...tokens, [token]: n - 1 } };
    const { over, under } = compareToBaseline(fewer, baseline, TEST_FILE);
    expect(over).toEqual([]);
    expect(under).toEqual([`${rel}  ${token}: ${n - 1}, baseline ${n} — the count fell: lower the baseline to ${n - 1} (UPDATE_BASELINES=1 npx vitest run ${TEST_FILE}) so the gain is kept`]);
  });

  it('components/**, App.tsx and qa/** match tests/config/baselines/overflow.json exactly', { timeout: REAL_TREE_TIMEOUT }, () => {
    const { files, counts, stale } = overflowScan();
    expect(files.length).toBeGreaterThan(400);
    expect(stale).toEqual([]);
    // The primitives this release fixed hold no offender of their own.
    for (const rel of ['components/ds/Button.tsx', 'components/ds/Badge.tsx', 'components/ds/MessageText.tsx', 'components/ds/ErrorState.tsx', 'qa/app/scenes/overflow-stress.tsx']) {
      expect(counts[rel], rel).toBeUndefined();
    }
    const { over, under, problems } = ratchet(GUARD, TEST_FILE, counts);
    expect(problems).toEqual([]);
    expect(over, 'A new overflow risk: use WRAP_TEXT / CLIP_TEXT / TWO_LINE_TEXT or MessageText (docs/design/design-system.md "Long words"); no ids in a Button label; calm words, never raw error text.').toEqual([]);
    expect(under, 'Overflow risks were removed: lower the baseline so they cannot come back.').toEqual([]);
  });
});
