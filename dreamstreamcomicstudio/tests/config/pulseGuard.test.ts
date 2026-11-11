// @vitest-environment node
/**
 * Pulse guard (declutter DC-0, rubric C9 "calm motion"; docs/design/clean-and-smooth.md).
 *
 * A pulsing dot says "something is live". Several at once (the activity dot, two page chips, a Cast chip …) read as
 * anxiety, not progress, and a pulse that ignores `prefers-reduced-motion` moves for people who asked it not to.
 * The sanctioned live pulse is the token commit's `LiveDot` (components/ds/LiveDot.tsx: one dot, paused off-screen,
 * still under reduced motion); everything else is a RAW pulse.
 *
 * Counts, per file and per token, every raw `animate-pulse`, `animate-ping` and `animate-bounce` class (any variant
 * prefix, `!` included) written in a string or template literal of a scanned file (components/**, App.tsx, qa/**;
 * tests/config/classLists.ts) outside components/ds/**, and — as the `unguarded` token — each of them whose class
 * list (one literal, one template, one `cx(…)`/`cn(…)` call with its conditionals, one JSX `{…}`) neither carries the
 * pulse behind `motion-safe:` nor adds `motion-reduce:animate-none`. `animate-spin` is exempt: a spinner inside a busy
 * control is the control's state, not a decorative pulse (the runtime probe's C9 still counts what spins on screen).
 *
 * It RATCHETS against tests/config/baselines/pulse.json, exactly like DS-0's guards (baselines/README.md): a new
 * raw pulse fails, a new unguarded one fails, and a removed one fails until the baseline is lowered
 * (`UPDATE_BASELINES=1 npx vitest run tests/config/pulseGuard.test.ts`, by the slot's integration owner). On the tree
 * it landed on, the only unguarded pulses in Comic Studio are the board status chip's two dots
 * (components/comicstudio/board/ui.tsx, the `StatusChip` and the tile overlay: declutter F34; DC-3 makes them static).
 */
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  APP_ROOT,
  type Counts,
  compareToBaseline,
  countTokens,
  listScannedFiles,
  matchesGlob,
  PINNED_DIR,
  ratchet,
  readBaseline,
  REAL_TREE_TIMEOUT,
  RECIPE_FILES,
  scanTree,
  scriptKindOf,
  tempTree,
  type TokenHit,
  VARIANT,
  withoutVariant
} from './classLists';

const GUARD = 'pulse';
const TEST_FILE = 'tests/config/pulseGuard.test.ts';

/** A raw pulse class with its variant chain: `animate-pulse`, `md:motion-safe:animate-ping`, `!animate-bounce`. */
export const PULSE_CLASS = new RegExp(String.raw`(?<![\w-])${VARIANT}animate-(?:pulse|ping|bounce)(?![\w-])`, 'g');
/** The reduced-motion stop written in the same class list. */
const REDUCE_STOP = new RegExp(String.raw`(?<![\w-])(?:[\w\-[\]&:()>.*/@]+:)?motion-reduce:!?animate-none(?![\w-])`);
const CLASS_HELPERS = new Set(['cx', 'clsx', 'cn', 'twJoin']);

/** One raw pulse: where, which token, and whether reduced motion stops it. */
export interface PulseHit extends TokenHit {
  guarded: boolean;
}

const isLiteral = (n: ts.Node): boolean => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);

/**
 * The class list a literal belongs to (the same climb as classLists.ts `classListOf`): up through what only COMBINES
 * class strings — a template, `cx(…)` / `clsx(…)` / `cn(…)` / `twJoin(…)`, `+`, `&&` / `||` / `??`, a ternary, an
 * array, parentheses, a JSX `{…}` — and no further.
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

/** Every literal's text inside a node: the class names written in that class list. */
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
 * Every raw pulse in a source's literals (comments, JSX text and module specifiers never count), each with its line,
 * its token (`animate-pulse` …, variant stripped) and whether it is guarded: the pulse itself sits behind
 * `motion-safe:`, or its class list also writes `motion-reduce:animate-none`.
 */
export function findPulses(source: string, fileName = 'file.tsx'): PulseHit[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
  const lines = source.split('\n');
  const hits: PulseHit[] = [];
  const visit = (node: ts.Node) => {
    if (isLiteral(node) && !(node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)))) {
      const raw = node.getText(sf);
      const start = node.getStart(sf);
      let list: string | null = null;
      for (const m of raw.matchAll(PULSE_CLASS)) {
        list ??= literalText(classListOf(node), sf);
        const line = sf.getLineAndCharacterOfPosition(start + m.index!).line + 1;
        const guarded = /(?:^|:)motion-safe:/.test(m[0]) || REDUCE_STOP.test(list);
        hits.push({ line, token: withoutVariant(m[0]), match: m[0], text: (lines[line - 1] ?? '').trim(), guarded });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** The ratchet's tokens for one file: each raw pulse by kind, plus one `unguarded` per pulse reduced motion does not stop. */
export const pulseTokens = (hits: readonly PulseHit[]): TokenHit[] => [
  ...hits,
  ...hits.filter((h) => !h.guarded).map((h) => ({ ...h, token: 'unguarded' }))
];

/** The files the guard reads: every scanned file outside components/ds/** (where LiveDot and the recipes live). */
export const pulseFiles = (root = APP_ROOT) => listScannedFiles({ root, exclude: ['components/ds/**'] });

/** The guard's scan of an app tree. The real-tree test runs exactly this. */
export function pulseScan(root = APP_ROOT) {
  const files = pulseFiles(root);
  return { files, ...scanTree(files, (rel, source) => pulseTokens(findPulses(source, rel)), {}, root) };
}

const plant = (classes: string) => `export const Dot = () => <span className="h-1.5 w-1.5 rounded-full ${classes}" aria-hidden />;\n`;
const tokensOf = (src: string, file?: string) => pulseTokens(findPulses(src, file)).map((h) => h.token);

describe('pulse guard — the detector', () => {
  it('counts raw pulse, ping and bounce with any variant or important flag; spin is exempt', () => {
    expect(tokensOf(plant('animate-pulse'))).toEqual(['animate-pulse', 'unguarded']);
    expect(tokensOf(plant('animate-ping'))).toEqual(['animate-ping', 'unguarded']);
    expect(tokensOf(plant('group-hover:animate-bounce'))).toEqual(['animate-bounce', 'unguarded']);
    expect(tokensOf(plant('md:!animate-pulse'))).toEqual(['animate-pulse', 'unguarded']);
    expect(tokensOf(plant('animate-spin'))).toEqual([]);
    expect(tokensOf(plant('animate-pulse-slow animate-[pulse_2s] pulse'))).toEqual([]);
  });

  it('a pulse is guarded by motion-safe: on itself, or by motion-reduce:animate-none anywhere in its class list', () => {
    expect(tokensOf(plant('motion-safe:animate-pulse'))).toEqual(['animate-pulse']);
    expect(tokensOf(plant('md:motion-safe:animate-ping'))).toEqual(['animate-ping']);
    expect(tokensOf(plant('animate-pulse motion-reduce:animate-none'))).toEqual(['animate-pulse']);
    expect(tokensOf(plant('animate-pulse motion-reduce:!animate-none'))).toEqual(['animate-pulse']);
    // The board chip's shape: the pulse is a conditional part of cx(…), the stop sits in another part of the same call.
    expect(tokensOf(`const D = () => <span className={cx('h-1.5 rounded-full motion-reduce:animate-none', on && 'animate-pulse')} />;`)).toEqual(['animate-pulse']);
    expect(tokensOf(`const D = () => <span className={cn(\`h-2 \${on ? 'animate-ping' : ''} motion-reduce:animate-none\`)} />;`)).toEqual(['animate-ping']);
    // Today's board/ui.tsx: nothing in the list stops it.
    expect(tokensOf(`const D = () => <span className={cx('h-1.5 w-1.5 rounded-full bg-[var(--ds-accent)]', status === 'rendering' && 'animate-pulse')} aria-hidden />;`)).toEqual([
      'animate-pulse',
      'unguarded'
    ]);
    // A stop in a DIFFERENT class list (another element) guards nothing.
    expect(tokensOf(`const D = () => <><i className="motion-reduce:animate-none" /><span className="animate-pulse" /></>;`)).toEqual(['animate-pulse', 'unguarded']);
    // motion-reduce:animate-pulse animates only for people who asked for less motion: never a guard.
    expect(tokensOf(plant('motion-reduce:animate-pulse'))).toEqual(['animate-pulse', 'unguarded']);
  });

  it('comments, visible text and module specifiers never count; a .ts file reads as TypeScript', () => {
    expect(tokensOf('// was animate-pulse, now LiveDot\nexport const a = 1;')).toEqual([]);
    expect(tokensOf('<p>{/* animate-ping */}The dot used animate-pulse</p>')).toEqual([]);
    expect(tokensOf("import x from './animate-pulse';")).toEqual([]);
    const ts_ = "const pick = <T>(v: T) => v;\nexport const PULSE = 'h-2 animate-pulse';\n";
    expect(findPulses(ts_, 'components/x.ts').map((h) => [h.line, h.token, h.guarded])).toEqual([[2, 'animate-pulse', false]]);
  });

  it('skips components/ds/** only (LiveDot and the primitives are the sanctioned pulse)', () => {
    const root = tempTree({
      'components/ds/LiveDot.tsx': "export const L = 'motion-safe:animate-ping';\n",
      'components/ds/Progress.tsx': "export const P = 'animate-pulse';\n",
      'components/x.tsx': plant('animate-pulse'),
      'qa/scene.tsx': plant('motion-safe:animate-pulse'),
      'components/x.test.tsx': plant('animate-pulse')
    });
    try {
      const { files, counts } = pulseScan(root);
      expect(files).toEqual(['components/x.tsx', 'qa/scene.tsx']);
      expect(counts).toEqual({ 'components/x.tsx': { 'animate-pulse': 1, unguarded: 1 }, 'qa/scene.tsx': { 'animate-pulse': 1 } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(pulseFiles()).not.toContain('components/ds/LiveDot.tsx');
    expect(pulseFiles()).toContain('components/comicstudio/board/ui.tsx');
  });
});

describe('pulse guard — the ratchet', () => {
  const { baseline } = readBaseline(GUARD);
  const PLANTED = 'components/comicstudio/__planted__/Chip.tsx';

  it('a new raw pulse fails, and a new unguarded one fails twice over (the pulse and its missing stop)', () => {
    const guarded: Counts = { ...baseline, [PLANTED]: countTokens(pulseTokens(findPulses(plant('motion-safe:animate-pulse')))) };
    expect(compareToBaseline(guarded, baseline, TEST_FILE).over).toEqual([`${PLANTED}  animate-pulse: 1, baseline 0 — a file or token the baseline does not list must count 0`]);
    const raw: Counts = { ...baseline, [PLANTED]: countTokens(pulseTokens(findPulses(plant('animate-pulse')))) };
    expect(compareToBaseline(raw, baseline, TEST_FILE).over).toEqual([
      `${PLANTED}  animate-pulse: 1, baseline 0 — a file or token the baseline does not list must count 0`,
      `${PLANTED}  unguarded: 1, baseline 0 — a file or token the baseline does not list must count 0`
    ]);
  });

  it('removing the guard from a baselined pulse fails even though the pulse count is unchanged', () => {
    const [rel, tokens] = Object.entries(baseline).find(([, t]) => (t['animate-pulse'] ?? 0) > 0 && !t.unguarded) ?? [];
    expect(rel, 'the baseline holds a guarded pulse').toBeDefined();
    const stripped: Counts = { ...baseline, [rel!]: { ...tokens, unguarded: 1 } };
    expect(compareToBaseline(stripped, baseline, TEST_FILE).over).toEqual([`${rel}  unguarded: 1, baseline 0 — a file or token the baseline does not list must count 0`]);
  });

  it('Comic Studio: only the board status chip (board/ui.tsx: two dots, DC-3) may hold unguarded pulses', () => {
    const studio = Object.entries(baseline).filter(([rel, t]) => matchesGlob(rel, [PINNED_DIR]) && (t.unguarded ?? 0) > 0);
    for (const [rel, t] of studio) {
      expect(rel).toBe('components/comicstudio/board/ui.tsx');
      expect(t.unguarded).toBeLessThanOrEqual(2);
    }
  });

  it('the "never" rule it ratchets towards fails today exactly at the board status chip (board/ui.tsx:421 and :537, F34)', { timeout: REAL_TREE_TIMEOUT }, () => {
    // Strict mode, no baseline: in Comic Studio every raw pulse must stop under reduced motion.
    const studio = pulseFiles().filter((rel) => matchesGlob(rel, [PINNED_DIR]));
    const strict = studio.flatMap((rel) =>
      findPulses(readFileSync(path.join(APP_ROOT, rel), 'utf8'), rel)
        .filter((h) => !h.guarded)
        .map((h) => `${rel}:${h.line}`)
    );
    // An oracle that does not use the AST detector: the board chip's lines that write 'animate-pulse' with no
    // motion-reduce / motion-safe on the same line (the StatusChip dot and the tile overlay dot).
    const BOARD = 'components/comicstudio/board/ui.tsx';
    const oracle = readFileSync(path.join(APP_ROOT, BOARD), 'utf8')
      .split('\n')
      .flatMap((text, i) => (/'animate-pulse'/.test(text) && !/motion-(?:reduce|safe):/.test(text) ? [`${BOARD}:${i + 1}`] : []));
    expect(strict, 'the strict rule fails at exactly the board chip lines, nowhere else in Comic Studio').toEqual(oracle);
    // The baseline tolerates exactly those. DC-3 makes the chip static; the integration owner then lowers the
    // entry (the real-tree test below goes "under" first) and both lists are empty.
    expect(strict.length).toBe(baseline[BOARD]?.unguarded ?? 0);
  });

  it('components/**, App.tsx and qa/** (minus components/ds/**) match tests/config/baselines/pulse.json exactly', { timeout: REAL_TREE_TIMEOUT }, () => {
    const { files, counts, hits, stale } = pulseScan();
    expect(files.length).toBeGreaterThan(400);
    expect(files.some((f) => matchesGlob(f, RECIPE_FILES.filter((g) => g.startsWith('components/ds'))))).toBe(false);
    expect(stale).toEqual([]);
    const { over, under, problems } = ratchet(GUARD, TEST_FILE, counts);
    expect(problems).toEqual([]);
    // Name the lines behind a rise, so the failure points at the code.
    const where = (line: string) => {
      const rel = line.split('  ')[0];
      const at = (hits[rel] ?? []).filter((h) => line.includes(`  ${h.token}:`)).map((h) => `:${h.line}`);
      return at.length ? `${line} (at ${rel}${at.join(', ')})` : line;
    };
    expect(
      over.map(where),
      'A new raw pulse: show a live state with components/ds LiveDot (one per view), or a static "Drawing…" label; if a pulse must stay, put motion-safe: on it or add motion-reduce:animate-none to its class list.'
    ).toEqual([]);
    expect(under, 'Raw pulses were removed or guarded: lower the baseline so they cannot come back.').toEqual([]);
  });
});
