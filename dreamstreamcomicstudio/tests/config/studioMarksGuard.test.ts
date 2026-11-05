// @vitest-environment node
/**
 * Guard for components/brand/** (the studio marks: StudioMark, StudioLogo, studio-marks.css).
 *
 * 1. None of the legacy comic kit: no black comic borders, comic shadows or comic fonts, no brand-*
 *    palette classes, no Tailwind display-font class (it means Bangers here), no terracotta or other
 *    hue (Atlas is monochrome: the marks draw in currentColor; the only literals are the mask's black
 *    and white), no local class-joining helper (clsx is imported), no z-index ladder numbers.
 *    This guard lives in tests/config, not next to the components, so its own patterns never trip
 *    the components/** scans.
 * 2. Plain CSS: Stream Studio has no Tailwind, so every class the components write is a ds-logo class
 *    defined in studio-marks.css, and every class that file styles is one the components use.
 * 3. Motion contract: tokens read with fallbacks (the file must work where no --ds-* exists), every
 *    movement only under prefers-reduced-motion: no-preference, a reduce block that stops
 *    everything, loops paused under [data-inview="false"], keyframes that end at rest.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { STUDIOS } from '../../components/brand/studios';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = 'components/brand';
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

function listFiles(rel: string): string[] {
  return readdirSync(path.join(ROOT, rel)).flatMap((entry) => {
    const child = `${rel}/${entry}`;
    return statSync(path.join(ROOT, child)).isDirectory() ? listFiles(child) : [child];
  });
}

const FILES = listFiles(DIR);
const SOURCES = FILES.filter((f) => /\.(tsx?|css)$/.test(f));
const COMPONENTS = FILES.filter((f) => /\.tsx$/.test(f) && !/\.test\./.test(f));
const CSS_FILE = `${DIR}/studio-marks.css`;
const css = read(CSS_FILE);

const LEGACY: Array<[string, RegExp]> = [
  ['comic border', /\bborder-black\b/],
  ['comic shadow', /\bshadow-comic\b/],
  ['comic font', /\bfont-comic\b/],
  ['brand palette class', /\bbrand-[\w-]+/],
  ['Tailwind display-font class (Bangers here)', /(?<!--ds-)\bfont-display\b/],
  ['terracotta / cream', /#(?:c2603f|d97757|c15f3c|cc785c|da7756|e07a5f|fdfbf7|faf9f5)\b/i],
  ['local class-joining helper', /\b(?:const|let|var|function)\s+(?:cx|cn|classNames|joinClassNames)\b/],
  ['z-index number', /z-index\s*:|(?<![\w-])-?z-(?:\d|\[)/],
  ['Tailwind directive', /@(?:apply|tailwind|layer)\b/],
];

describe('components/brand stays clear of the legacy comic kit', () => {
  it('has the files this guard expects', () => {
    expect(FILES).toEqual(expect.arrayContaining([`${DIR}/StudioMark.tsx`, `${DIR}/StudioLogo.tsx`, CSS_FILE, `${DIR}/studios.ts`]));
  });

  it.each(SOURCES)('%s has no legacy-kit pattern', (rel) => {
    const source = read(rel);
    const found = LEGACY.filter(([, re]) => re.test(source)).map(([name, re]) => `${name}: ${source.match(re)![0]}`);
    expect(found).toEqual([]);
  });

  it.each(SOURCES)('%s spells no colour but the mask black and white (hue only for status, never in a mark)', (rel) => {
    const hexes = [...read(rel).matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase());
    expect(hexes.filter((h) => !['#000', '#fff', '#000000', '#ffffff'].includes(h))).toEqual([]);
    expect(read(rel)).not.toMatch(/\b(?:rgba?|hsla?|oklch|color-mix)\(/i);
  });
});

/** Class tokens the components write: JSX className strings and the string parts of clsx(…) calls. */
function classTokensOf(source: string): { fixed: string[]; templates: string[] } {
  const sf = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fixed: string[] = [];
  const templates: string[] = [];
  const take = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) fixed.push(...node.text.split(/\s+/).filter(Boolean));
    else if (ts.isTemplateExpression(node)) templates.push(node.head.text + '${…}');
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) take(node.right);
    else if (ts.isConditionalExpression(node)) {
      take(node.whenTrue);
      take(node.whenFalse);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'className' && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) take(node.initializer);
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) take(node.initializer.expression);
    }
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'clsx') node.arguments.forEach(take);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { fixed, templates };
}

/** Every class selector the stylesheet styles. */
const cssClasses = new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));

describe('plain CSS: the components need no Tailwind', () => {
  const used = COMPONENTS.map((rel) => ({ rel, ...classTokensOf(read(rel)) }));

  it.each(used)('$rel writes only ds-logo classes, each one styled by studio-marks.css', ({ rel, fixed, templates }) => {
    expect(fixed.length, rel).toBeGreaterThan(0);
    for (const token of fixed) {
      expect(token, `${rel}: "${token}"`).toMatch(/^ds-logo(?:-[a-z]+)*(?:--[a-z]+)?$/);
      expect(cssClasses.has(token), `${rel}: .${token} is styled`).toBe(true);
    }
    for (const t of templates) expect(t, rel).toMatch(/^ds-logo(?:-mark)?--\$\{…\}$/);
  });

  it('styles every studio and every lockup size the components can produce', () => {
    for (const s of STUDIOS) expect(cssClasses.has(`ds-logo-mark--${s}`), s).toBe(true);
    for (const size of ['header', 'display', 'compact']) expect(cssClasses.has(`ds-logo--${size}`), size).toBe(true);
    for (const c of ['ds-logo-mark--loading', 'ds-logo--endorsed', 'ds-logo-cut', 'ds-logo-point']) expect(cssClasses.has(c), c).toBe(true);
  });

  it('styles no class the components never write (no dead rules)', () => {
    const written = new Set(used.flatMap((u) => u.fixed));
    const families = [...STUDIOS.map((s) => `ds-logo-mark--${s}`), 'ds-logo--header', 'ds-logo--display', 'ds-logo--compact'];
    for (const c of cssClasses) expect(written.has(c) || families.includes(c) || c === 'ds-logo-cut' || c === 'ds-logo-point', c).toBe(true);
  });
});

/** Each declaration with the block preludes around it (outermost first). */
function declarations(source: string): Array<{ prop: string; value: string; within: string[] }> {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<{ prop: string; value: string; within: string[] }> = [];
  const stack: string[] = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
    } else if (ch === '}' || ch === ';') {
      const m = buf.trim().match(/^([\w-]+)\s*:\s*([\s\S]+)$/);
      if (m) out.push({ prop: m[1], value: m[2].trim(), within: [...stack] });
      buf = '';
      if (ch === '}') stack.pop();
    } else buf += ch;
  }
  return out;
}

describe('studio-marks.css motion contract', () => {
  const decls = declarations(css);
  const inKeyframes = (d: { within: string[] }) => d.within.some((p) => p.startsWith('@keyframes'));
  const underNoPreference = (d: { within: string[] }) => d.within.some((p) => /@media[^{]*prefers-reduced-motion:\s*no-preference/.test(p));
  const underReduce = (d: { within: string[] }) => d.within.some((p) => /@media[^{]*prefers-reduced-motion:\s*reduce/.test(p));

  it('reads every shared token with a fallback, so Stream Studio (no --ds-* tokens) renders it', () => {
    const vars = [...css.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)];
    expect(vars.length).toBeGreaterThan(0);
    for (const [, name, comma] of vars) {
      if (name.startsWith('--ds-logo-')) continue; // the lockup's own variables, set on .ds-logo
      expect(comma, `${name} has a fallback`).toBe(',');
    }
    for (const token of ['--ds-ease-spring', '--ds-ease', '--ds-motion-panel', '--ds-motion-fast']) {
      expect(css, token).toMatch(new RegExp(`var\\(${token}, `));
    }
    expect(css).toContain('font-family: var(--ds-font-display, "Space Grotesk", system-ui, sans-serif);');
  });

  it('moves nothing outside prefers-reduced-motion: no-preference', () => {
    const moving = decls.filter(
      (d) => !inKeyframes(d) && /^(animation|transition|transform)(-|$)/.test(d.prop) && !/^none\b/.test(d.value) && d.prop !== 'transform-origin' && d.prop !== 'transform-box' && d.prop !== 'animation-play-state',
    );
    expect(moving.length).toBeGreaterThan(5);
    for (const d of moving) expect(underNoPreference(d), `${d.prop}: ${d.value} (in ${d.within.join(' / ')})`).toBe(true);
  });

  it('stops every animation and transition on a mark under reduced motion', () => {
    const reduce = decls.filter(underReduce);
    const selector = reduce[0]?.within.at(-1) ?? '';
    for (const part of ['.ds-logo-mark', '.ds-logo-cut', '.ds-logo-point']) expect(selector).toContain(part);
    expect(reduce.map((d) => `${d.prop}: ${d.value}`)).toEqual(['animation: none !important', 'transition: none !important']);
  });

  it('pauses the loading loops off screen and in hidden tabs ([data-inview="false"])', () => {
    const pause = decls.filter((d) => d.prop === 'animation-play-state');
    expect(pause).toHaveLength(1);
    expect(pause[0].value).toBe('paused');
    expect(pause[0].within.at(-1)).toMatch(/\[data-inview="false"\] \.ds-logo-mark--loading/);
    expect(pause[0].within.at(-1)).toMatch(/\.ds-logo-mark--loading\[data-inview="false"\]/);
  });

  it('hovers only where a pointer hovers', () => {
    for (const d of decls.filter((x) => x.within.some((p) => p.includes(':hover')))) {
      expect(d.within.some((p) => /@media[^{]*\(hover: hover\)/.test(p)), d.within.join(' / ')).toBe(true);
    }
  });

  it('loops forever only on loading marks', () => {
    for (const d of decls.filter((x) => x.prop === 'animation' && /\binfinite\b/.test(x.value))) {
      expect(d.within.at(-1)).toContain('.ds-logo-mark--loading');
    }
  });

  it('defines every keyframes it uses, and each ends at rest (transform: none)', () => {
    const defined = new Map<string, string>();
    for (const m of css.matchAll(/@keyframes ([\w-]+) \{([\s\S]*?)\n\}/g)) defined.set(m[1], m[2]);
    const used = new Set(decls.filter((d) => d.prop === 'animation' && !/^none\b/.test(d.value)).map((d) => d.value.split(/\s+/)[0]));
    expect(used.size).toBeGreaterThan(3);
    for (const name of used) {
      expect(defined.has(name), name).toBe(true);
      expect(defined.get(name), name).toMatch(/(?:100%|0%, (?:\d+%, )*100%) \{ transform: none;/);
    }
  });
});
