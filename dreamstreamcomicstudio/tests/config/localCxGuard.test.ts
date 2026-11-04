// @vitest-environment node
/**
 * Local `cx` guard (DS-0, master plan §1.4; docs/design/atlas-skin.md "Wave 8 port").
 *
 * A file-local `cx` (`const cx = (...parts) => parts.filter(Boolean).join(' ')`) JOINS class strings; it
 * does not merge them. Two utilities of one kind in the joined list — a base constant's
 * `text-[var(--ds-ink)]` and a `TONE_TEXT.danger` added after it — both reach the element, and the one
 * Tailwind emits later wins whatever the order they were written in: the wave 8 ink bug, where the
 * destructive buttons rendered in plain ink (tests/config/classLists.ts findCompetingInks). Class lists
 * are composed with `cn` from lib/utils.ts (twMerge over clsx), which keeps the last utility of each
 * kind, so `cn(BASE, className)` lets a caller override a primitive's padding or colour.
 *
 * Fails on a local class joiner named `cx`: a `const` / `let` / `var cx` whose value is a function or an
 * alias of a class helper (`clsx`, `classnames`, `twJoin`, `twMerge`, `cn`), or a `function cx(…)`.
 * A coordinate called `cx` (`const cx = size / 2`), a destructured `{ cx }`, an imported `cx` and an SVG
 * `cx={…}` attribute are not joiners. It RATCHETS against tests/config/baselines/localCx.json over
 * components/**, App.tsx and qa/** (`UPDATE_BASELINES=1 npx vitest run tests/config/localCxGuard.test.ts`
 * once a file moves onto `cn`).
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { type Allowlist, type Counts, type TokenHit, compareToBaseline, countTokens, listScannedFiles, ratchet, readBaseline, scanTree } from './classLists';

const GUARD = 'localCx';
const TEST_FILE = 'tests/config/localCxGuard.test.ts';

/** Class helpers a `cx` may alias (it is still a local `cx`: one name, one meaning, `cn`). */
const CLASS_HELPERS = new Set(['clsx', 'classnames', 'classNames', 'twJoin', 'twMerge', 'cn']);

const isFunctionValue = (init: ts.Expression): boolean => {
  let e = init;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return ts.isArrowFunction(e) || ts.isFunctionExpression(e) || (ts.isIdentifier(e) && CLASS_HELPERS.has(e.text));
};

/** Every local class joiner named `cx` in a source (its declaration's line). */
export function findLocalCx(source: string): TokenHit[] {
  const sf = ts.createSourceFile('file.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.split('\n');
  const hits: TokenHit[] = [];
  const report = (node: ts.Node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    hits.push({ line, token: 'cx', match: 'cx', text: (lines[line - 1] ?? '').trim() });
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'cx' && node.initializer && isFunctionValue(node.initializer)) report(node);
    else if (ts.isFunctionDeclaration(node) && node.name?.text === 'cx') report(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Content exemptions (token and trimmed line, one-line reason). None: no `cx` is content. */
const ALLOWLIST: Allowlist = {};

const PLANTED = 'components/__planted__/Fixture.tsx';

describe('local cx guard — the detector', () => {
  it('recognises a local class joiner named cx, however it is written', () => {
    const flagged = [
      "const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');",
      "export const cx = (...p: Array<string | false>) => p.filter(Boolean).join(' ');",
      "function cx(...classes: string[]) {\n  return classes.filter(Boolean).join(' ');\n}",
      "export function cx(a: string, b?: string) { return `${a} ${b ?? ''}`; }",
      "let cx = function (a: string, b: string) { return a + ' ' + b; };",
      'const cx = clsx;',
      'const cx = (cn as (...c: string[]) => string);',
      "const Card = () => {\n  const cx = (...p: string[]) => p.join(' ');\n  return <div className={cx('a', 'b')} />;\n};"
    ];
    for (const src of flagged) expect(findLocalCx(src).map((h) => h.token), src).toEqual(['cx']);
    expect(findLocalCx("const a = 1;\nconst cx = (...p: string[]) => p.join(' ');").map((h) => h.line)).toEqual([2]);
  });

  it('leaves coordinates, imports, destructuring, attributes, cn and comments alone', () => {
    const allowed = [
      'const cx = size / 2;',
      "const cx = canvas.getContext('2d');",
      'const cx = p.transform?.cx ?? p.x + p.w / 2;',
      'const { cx, cy } = circle;',
      "import { cx } from './ui';",
      "import { cn } from '../../lib/utils';\nconst Box = () => <div className={cn('p-2', 'p-3')} />;",
      '<circle cx={12} cy={12} r={4} />',
      "const helpers = { cx: (...p: string[]) => p.join(' ') };",
      "const cxs = (...p: string[]) => p.join(' ');",
      "// const cx = (...p) => p.filter(Boolean).join(' ');\nconst a = 1;",
      "const doc = 'const cx = (...p) => p.join(\" \")';"
    ];
    for (const src of allowed) expect(findLocalCx(src), src).toEqual([]);
  });
});

describe('local cx guard — the ratchet', () => {
  const { baseline } = readBaseline(GUARD);

  it('a local cx planted in any scanned file fails, naming the file and the count', () => {
    const src = "const cx = (...p: Array<string | false>) => p.filter(Boolean).join(' ');\nexport const Fixture = () => <div className={cx('p-2')} />;\n";
    const actual: Counts = { ...baseline, [PLANTED]: countTokens(findLocalCx(src)) };
    expect(compareToBaseline(actual, baseline, TEST_FILE)).toEqual({
      over: [`${PLANTED}  cx: 1, baseline 0 — a file or token the baseline does not list must count 0`],
      under: []
    });
  });

  it('a second cx in a baselined file fails; a file that moved onto cn fails until its entry is dropped', () => {
    const [rel] = Object.keys(baseline);
    expect(compareToBaseline({ ...baseline, [rel]: { cx: baseline[rel].cx + 1 } }, baseline, TEST_FILE).over).toEqual([
      `${rel}  cx: ${baseline[rel].cx + 1}, baseline ${baseline[rel].cx} — 1 new use`
    ]);
    const { [rel]: _moved, ...rest } = baseline;
    expect(compareToBaseline(rest, baseline, TEST_FILE).under).toEqual([
      `${rel}  cx: 0, baseline ${baseline[rel].cx} — the count fell: lower the baseline to 0 (UPDATE_BASELINES=1 npx vitest run ${TEST_FILE}) so the gain is kept`
    ]);
  });

  it('components/**, App.tsx and qa/** match tests/config/baselines/localCx.json exactly', () => {
    const files = listScannedFiles();
    expect(files.length).toBeGreaterThan(400);
    const { counts, stale } = scanTree(files, (_rel, source) => findLocalCx(source), ALLOWLIST);
    expect(stale).toEqual([]);
    const { over, under, problems } = ratchet(GUARD, TEST_FILE, counts);
    expect(problems).toEqual([]);
    expect(over, "A new local cx: compose classes with cn from lib/utils.ts (twMerge over clsx), which merges instead of stacking two utilities of one kind.").toEqual([]);
    expect(under, 'A local cx is gone: lower the baseline so it cannot come back.').toEqual([]);
  });
});
