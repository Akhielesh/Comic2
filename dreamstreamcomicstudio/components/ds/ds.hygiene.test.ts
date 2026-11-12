// @vitest-environment node
/**
 * Design-system hygiene for components/ds/** and its QA scene (qa/app/scenes/ds-gallery.tsx), so DS-0's
 * app-wide guards (legacy kit, terracotta, local cx, z ladder, status ink, overline) find nothing here
 * at integration: a file absent from their baselines must count 0.
 *
 * Every non-test source file must contain: no `#` hex literal (colours are tokens), no local `cx`
 * (classes compose with `cn` from lib/utils.ts), no raw z-index class (layers come from the Z recipe in
 * studioDesign), none of the legacy kit (`border-black`, `shadow-comic`, `font-comic`, `brand-*`, the
 * Bangers `font-display` — spelled nowhere, not even inside a token name), no raw hue text colour, no
 * spelled duration or delay (motion reads the `--ds-motion-*` tokens), no class list that stacks two
 * text colours, no hand-rolled eyebrow; and every `var(--ds-*)` it reads must exist in index.css.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as design from '../chat/studioDesign';
import { APP_ROOT, parseRules, indexCss, tokenBlocks } from '../../tests/config/cssTokens';
import { findCompetingInks, findHandRolledOverlines } from '../../tests/config/classLists';

const DS_DIR = path.join(APP_ROOT, 'components/ds');
const SCENE = path.join(APP_ROOT, 'qa/app/scenes/ds-gallery.tsx');
const isTest = (f: string) => /\.(test|spec)\.[tj]sx?$/.test(f);

function sources(): Array<{ rel: string; text: string }> {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(entry) && !isTest(entry)) out.push(full);
    }
  };
  walk(DS_DIR);
  out.push(SCENE);
  return out.map((f) => ({ rel: path.relative(APP_ROOT, f).split(path.sep).join('/'), text: readFileSync(f, 'utf8') }));
}

const HUES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
/** Each rule: what it forbids, matched on the whole file (comments included: stricter than the guards). */
export const RULES: Array<{ name: string; re: RegExp }> = [
  { name: 'hex colour literal', re: /#[0-9a-fA-F]{3,8}\b/g },
  { name: 'local cx', re: /\b(?:const|let|var|function)\s+cx\b|import\s*\{[^}]*\bcx\b[^}]*\}/g },
  { name: 'raw z-index class (use the Z recipe)', re: /(?<![\w-])-?z-(?:\[|\d)/g },
  { name: 'legacy kit', re: /border-black|shadow-comic|font-comic|(?<![A-Za-z0-9_])brand-(?:yellow|blue|red|black)\b|font-display/g },
  { name: 'raw hue text colour', re: new RegExp(String.raw`(?<![\w-])(?:[\w\-[\]&:()>.*]+:)?text-(?:${HUES})-\d{2,3}`, 'g') },
  { name: 'spelled duration or delay', re: /(?<![\w-])(?:[\w-]+:)*(?:duration|delay)-(?:\d|\[\d)|(?<![\w-])animate-\[/g }
];

export function violations(text: string): string[] {
  const hits: string[] = [];
  const lines = text.split('\n');
  for (const { name, re } of RULES) {
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push(`${name}: "${m[0]}" (line ${line}: ${lines[line - 1].trim().slice(0, 80)})`);
    }
  }
  return hits;
}

describe('components/ds hygiene (DS-0 guards pass at integration)', () => {
  const files = sources();

  it('scans the primitives and the gallery scene', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.map((f) => f.rel)).toEqual(expect.arrayContaining(['components/ds/Button.tsx', 'components/ds/index.ts', 'qa/app/scenes/ds-gallery.tsx']));
  });

  it('the scanner catches each forbidden spelling (planted samples)', () => {
    const planted = [
      'bg-[#D97757]/10',
      "const cx = (...a) => a.join(' ')",
      'fixed z-[85]',
      'coarse:z-50',
      'shadow-comic',
      'border-2 border-black',
      'font-comic',
      'bg-brand-yellow',
      'font-display',
      'var(--ds-font-display)',
      'text-amber-700',
      'dark:text-red-300',
      'duration-200',
      'hover:delay-[300ms]',
      'animate-[spin_1s]'
    ];
    for (const p of planted) expect(violations(`<div className="${p}" />`), p).not.toEqual([]);
    for (const ok of ['size-4', 'gap-2 px-3', 'duration-[var(--ds-motion-medium)]', 'text-[var(--ds-ink)]', 'Z.toast', 'FONT_DISPLAY', 'bg-transparent']) {
      expect(violations(`<div className="${ok}" />`), ok).toEqual([]);
    }
  });

  it.each(sources().map((f) => [f.rel, f.text] as const))('%s: no hex, local cx, raw z, legacy kit, hue ink or spelled duration', (_rel, text) => {
    expect(violations(text)).toEqual([]);
  });

  it.each(sources().map((f) => [f.rel, f.text] as const))('%s: no stacked text colours, no hand-rolled eyebrow', (_rel, text) => {
    expect(findCompetingInks(text, design as unknown as Record<string, unknown>)).toEqual([]);
    expect(findHandRolledOverlines(text)).toEqual([]);
  });

  it('composes classes with cn from lib/utils.ts', () => {
    const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const { rel, text } of files) {
      if (!/\bcn\(/.test(code(text))) continue;
      expect(text, rel).toMatch(/import \{ cn \} from '\.\.\/\.\.\/(?:\.\.\/)?lib\/utils'/);
    }
  });

  it('every --ds-* token it reads is defined in index.css', () => {
    const { ROOT_TOKENS } = tokenBlocks(parseRules(indexCss));
    const recipes = Object.values(design).flatMap((v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).map(String) : []));
    const used = new Set<string>();
    for (const text of [...files.map((f) => f.text), ...recipes]) for (const m of text.matchAll(/var\((--ds-[\w-]+)\)/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(30);
    expect([...used].filter((t) => !ROOT_TOKENS.has(t))).toEqual([]);
  });

  it('no overlay here yet (Dialog, Menu, Popover, Tooltip and the Toast host wait for DS-1c)', () => {
    for (const { rel, text } of files) expect(text, rel).not.toMatch(/aria-modal|role="dialog"|role="menu"|role="tooltip"/);
  });
});

/**
 * Every class the primitives export must be one this app's Tailwind (3.4, tailwind.config.cjs) can
 * generate. A class-presence test only proves a string is on the element; a Tailwind 4 idiom such as a
 * bare `aria-invalid:` variant (3.4's `theme.aria` has no `invalid`) sits there and compiles to no CSS.
 * So each class of each exported SCREAMING_CASE string (or record of strings) in components/ds/*.ts(x),
 * the studioDesign recipes that recipes.ts re-exports among them, must get a Tailwind sort order.
 */
const twRequire = createRequire(import.meta.url);
/** Hand-written classes in index.css or styles/ds-motion.css (no Tailwind utility behind them). */
export const HAND_WRITTEN_CLASSES: readonly string[] = ['studio-shimmer', 'ds-font-display', 'ds-press', 'ds-rise-in', 'ds-making-sweep', 'ds-benday', 'ds-shimmer-text'];
/** A named group or peer (`group/checkbox`) only anchors `group-…/checkbox:` variants; it has no CSS of its own. */
const NAMED_MARKER = /^(?:group|peer)\/[\w-]+$/;

/** [where, class string] for every exported class-string constant of a module. */
export function exportedClassStrings(moduleName: string, mod: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const visit = (value: unknown, at: string) => {
    if (typeof value === 'string') out.push([at, value]);
    else if (value && typeof value === 'object' && !Array.isArray(value) && !('$$typeof' in value)) {
      for (const [k, v] of Object.entries(value)) visit(v, `${at}.${k}`);
    }
  };
  for (const [name, value] of Object.entries(mod)) if (/^[A-Z][A-Z0-9_]*$/.test(name)) visit(value, `${moduleName}:${name}`);
  return out;
}

/** The classes of `classStrings` Tailwind cannot generate (each as `where: class`). */
let tailwindContext: { getClassOrder(classes: string[]): Array<[string, bigint | null]> } | undefined;
export function ungeneratedClasses(classStrings: Array<[string, string]>, allow: readonly string[] = HAND_WRITTEN_CLASSES): string[] {
  if (!tailwindContext) {
    const resolveConfig = twRequire('tailwindcss/resolveConfig');
    const { createContext } = twRequire('tailwindcss/lib/lib/setupContextUtils');
    tailwindContext = createContext(resolveConfig(twRequire(path.join(APP_ROOT, 'tailwind.config.cjs'))));
  }
  const where = new Map<string, string>();
  for (const [at, s] of classStrings) for (const c of s.split(/\s+/)) if (c && !allow.includes(c) && !NAMED_MARKER.test(c) && !where.has(c)) where.set(c, at);
  const order = tailwindContext!.getClassOrder([...where.keys()]);
  return order.filter(([, o]) => o === null).map(([c]) => `${where.get(c)}: ${c}`);
}

describe('components/ds classes compile under this app’s Tailwind', () => {
  it('every class of every exported class-string constant generates CSS', async () => {
    const strings: Array<[string, string]> = [];
    for (const entry of readdirSync(DS_DIR).sort()) {
      if (!/\.tsx?$/.test(entry) || isTest(entry)) continue;
      strings.push(...exportedClassStrings(entry, await import(path.join(DS_DIR, entry))));
    }
    const owners = new Set(strings.map(([at]) => at.split(':')[0]));
    expect([...owners]).toEqual(expect.arrayContaining(['Button.tsx', 'Input.tsx', 'Select.tsx', 'Switch.tsx', 'Checkbox.tsx', 'recipes.ts', 'stateParts.tsx']));
    expect(strings.length).toBeGreaterThan(100);
    expect(ungeneratedClasses(strings)).toEqual([]);
  });

  it('flags a Tailwind 4 idiom and keeps the 3.4 spelling (planted samples)', () => {
    const planted: Array<[string, string]> = [['planted', 'aria-invalid:border-[var(--ds-danger-mark)] peer-aria-invalid:border-[var(--ds-danger-mark)] size-4']];
    expect(ungeneratedClasses(planted)).toEqual(['planted: aria-invalid:border-[var(--ds-danger-mark)]', 'planted: peer-aria-invalid:border-[var(--ds-danger-mark)]']);
    expect(ungeneratedClasses([['ok', 'aria-[invalid=true]:border-[var(--ds-danger-mark)] peer-aria-[invalid=true]:border-[var(--ds-danger-mark)] coarse:min-h-11']])).toEqual([]);
  });

  it('the hand-written allowlist names real rules (index.css or the motion classes it imports)', () => {
    const motionCss = readFileSync(path.join(APP_ROOT, 'styles/ds-motion.css'), 'utf8');
    for (const c of HAND_WRITTEN_CLASSES) expect(`${indexCss}\n${motionCss}`, c).toMatch(new RegExp(`\\.${c}[\\s,{:]`));
  });
});
