// @vitest-environment node
/**
 * The DS-1c overlay sources (components/ds/{Dialog,AlertDialog,Menu,Popover,Tooltip,Toast}.tsx, overlayLayer.ts) and their QA scene
 * (qa/app/scenes/ds-overlays.tsx) hold the design-system rules, so DS-0's app-wide guards find nothing at integration:
 * no hex, no raw z-index (layers come from Z), no local cx, no legacy kit, no raw hue ink, no spelled duration, no
 * stacked inks, no hand-rolled eyebrow; every --ds-* token they read exists; and every motion, ease and radius token
 * they spell keeps a var() fallback (lead note).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as design from '../chat/studioDesign';
import { findCompetingInks, findHandRolledOverlines } from '../../tests/config/classLists';
import { APP_ROOT } from '../../tests/config/cssTokens';

const FILES = ['Dialog', 'AlertDialog', 'Menu', 'Popover', 'Tooltip', 'Toast']
  .map((n) => `components/ds/${n}.tsx`)
  .concat('components/ds/overlayLayer.ts', 'qa/app/scenes/ds-overlays.tsx');
const source = (rel: string) => readFileSync(path.join(APP_ROOT, rel), 'utf8');

describe('the overlay sources hold the design-system rules', () => {
  const HUES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
  const RULES: Array<[string, RegExp]> = [
    ['hex colour literal', /#[0-9a-fA-F]{3,8}\b/g],
    ['local cx', /\b(?:const|let|var|function)\s+cx\b|import\s*\{[^}]*\bcx\b[^}]*\}/g],
    ['raw z-index class', /(?<![\w-])-?z-(?:\[|\d)/g],
    ['legacy kit', /border-black|shadow-comic|font-comic|(?<![A-Za-z0-9_])brand-(?:yellow|blue|red|black)\b|font-display/g],
    ['raw hue text colour', new RegExp(String.raw`(?<![\w-])(?:[\w\-[\]&:()>.*]+:)?text-(?:${HUES})-\d{2,3}`, 'g')],
    ['spelled duration or delay', /(?<![\w-])(?:[\w-]+:)*(?:duration|delay)-(?:\d|\[\d)|(?<![\w-])animate-\[/g],
    ['a motion, ease or radius token read without a var() fallback', /var\(--ds-(?:motion|ease|radius)[\w-]*\)/g]
  ];

  it.each(FILES)('%s', (rel) => {
    const text = source(rel);
    const hits = RULES.flatMap(([name, re]) => [...text.matchAll(re)].map((m) => `${name}: ${m[0]}`));
    expect(hits).toEqual([]);
    expect(findCompetingInks(text, design as unknown as Record<string, unknown>, rel)).toEqual([]);
    expect(findHandRolledOverlines(text, rel)).toEqual([]);
  });

  it('the fallback rule catches a bare read and passes a guarded one (planted)', () => {
    const rule = RULES.at(-1)![1];
    expect('duration-[var(--ds-motion-fast)]'.match(rule)).not.toBeNull();
    expect('rounded-[var(--ds-radius-control)]'.match(rule)).not.toBeNull();
    expect('duration-[var(--ds-motion-fast,120ms)] ease-[var(--ds-ease,ease)] rounded-[var(--ds-radius-control,8px)]'.match(rule)).toBeNull();
  });

  it('every --ds-* token they read exists in index.css', () => {
    const css = source('index.css');
    const used = new Set<string>();
    for (const rel of FILES) for (const m of source(rel).matchAll(/var\((--ds-[\w-]+)[,)]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(8);
    expect([...used].filter((token) => !new RegExp(`${token}\\s*:`).test(css))).toEqual([]);
  });
});

/**
 * Bundle cost (master plan §1.6 risk 6: components/ds adds at most 25 KB gz to the first load). The Radix overlays are
 * about 42 KB gz together, so they must cost nothing to a chunk that does not use them, also once the components/ds
 * barrel re-exports them (a wave note): their top-level forwardRef / createContext calls are marked pure and the Radix
 * roots are plain re-exports, so importing an unrelated primitive through such a barrel drops every overlay. The Toast
 * host (mounted at the App root, so on the first load) uses no Radix and stays small.
 */
describe('the overlays cost nothing where they are not used', () => {
  const ALREADY_LOADED = /^(react|react-dom|lucide-react|tailwind-merge|clsx)(\/|$)/;
  const OVERLAYS = ['Dialog', 'AlertDialog', 'Menu', 'Popover', 'Tooltip', 'Toast'];
  /** Bundles `modules.entry` (virtual modules import each other as `virtual:<name>`); returns the inputs kept and the gz size. */
  async function bundle(modules: Record<string, string>, alsoExternal: RegExp | null = null) {
    const { build } = await import('esbuild');
    const { gzipSync } = await import('node:zlib');
    const result = await build({
      entryPoints: ['virtual:entry'],
      bundle: true,
      minify: true,
      write: false,
      format: 'esm',
      jsx: 'automatic',
      metafile: true,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [
        {
          name: 'virtual-and-externals',
          setup(b) {
            b.onResolve({ filter: ALREADY_LOADED }, (a) => ({ path: a.path, external: true }));
            if (alsoExternal) b.onResolve({ filter: alsoExternal }, (a) => ({ path: a.path, external: true }));
            b.onResolve({ filter: /^virtual:/ }, (a) => ({ path: a.path.slice('virtual:'.length), namespace: 'virtual' }));
            b.onLoad({ filter: /.*/, namespace: 'virtual' }, (a) => ({ contents: modules[a.path], resolveDir: path.join(APP_ROOT, 'components/ds'), loader: 'tsx' }));
          }
        }
      ]
    });
    const out = Object.values(result.metafile!.outputs)[0];
    const bytes = Object.fromEntries(Object.entries(out.inputs).map(([f, v]) => [f, v.bytesInOutput]));
    return { kept: Object.keys(bytes).filter((f) => bytes[f] > 0), bytes, gz: gzipSync(result.outputFiles[0].contents).length };
  }
  const radixIn = (kept: string[]) => kept.filter((f) => /@radix-ui|@floating-ui|react-remove-scroll|aria-hidden/.test(f));

  it('a Button imported through a barrel that re-exports every overlay carries no Radix, and almost nothing else', { timeout: 30_000 }, async () => {
    const entry = "import { Button } from 'virtual:barrel';\nconsole.log(Button);";
    const barrel = [...OVERLAYS.map((m) => `export * from './${m}';`), "export { Button } from './Button';"].join('\n');
    const { kept, bytes, gz } = await bundle({ barrel, entry });
    expect(kept.some((f) => f.endsWith('components/ds/Button.tsx'))).toBe(true);
    expect(radixIn(kept)).toEqual([]);
    // The overlay layer and what it joins (the sheets' stack, the back stack) leave only their module-level lines
    // (a token string, a load id, import lines esbuild keeps; Rollup drops most of them).
    const layer = Object.entries(bytes).filter(([f]) => /overlayLayer|PopSheet|backStack|conversation\/ui/.test(f));
    expect(layer.reduce((sum, [, n]) => sum + n, 0)).toBeLessThan(1024);
    // In all, an unused overlay set costs a Button-only chunk under 1.5 KB gz (minified, esbuild).
    const alone = await bundle({ barrel: "export { Button } from './Button';", entry });
    expect(gz - alone.gz).toBeLessThan(1536);
  });

  it('the probe is real: a used Dialog does bring Radix', { timeout: 30_000 }, async () => {
    const { kept } = await bundle({ entry: "import { DialogContent } from './Dialog';\nconsole.log(DialogContent);" });
    expect(radixIn(kept).length).toBeGreaterThan(5);
  });

  it('the Toast host (first load) uses no Radix and stays under 4 KB gz', { timeout: 30_000 }, async () => {
    // Button, IconButton, the recipes and cn are on the first load already: only the Toast module itself is measured.
    const { kept, gz } = await bundle(
      { entry: "import { ToastHost, toast } from './Toast';\nconsole.log(ToastHost, toast);" },
      /^\.{1,2}\/(?:\.\.\/)*(?:chat\/studioDesign|recipes|Button|IconButton|useReducedMotion|lib\/utils)$/
    );
    expect(radixIn(kept)).toEqual([]);
    expect(gz).toBeLessThan(4 * 1024);
  });
});
