// The page editor's Easy path never loads the Pro inspector (PE-INSPECT; master plan §2.8: at most 5 KB gz added to the
// page editor's chunk; PE-SHELL's lazy mount contract, collisions B-16). The page editor imports the lettering
// inspector statically, and the Pro shell imports the inspector and Layers part barrels on the Easy path; from those
// files, no STATIC import may reach the Pro inspector's modules or the B9 scene engine they read. They load through
// dynamic imports only (lettering/pro/proExtras.ts, the parts' loadPanel). A static import added back fails here.
//
// Also pinned: a module namespace read on that path is a static member read (`ns.NAME`, or `(ns as T).NAME`), never the
// namespace passed around as a value, which would keep every export of the module (style.ts: about 6.7 KB) in the chunk.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = path.resolve(__dirname, '../../../..');
const rel = (abs: string) => path.relative(APP, abs).split(path.sep).join('/');

/** The Easy path's entries into this package's files. */
const ENTRIES = [
  'components/comicstudio/lettering/LetteringInspector.tsx',
  'components/comicstudio/editor/inspector/index.ts',
  'components/comicstudio/editor/layers/index.ts',
  // The canvas reads the Layers eye's store directly (waveNote 3).
  'components/comicstudio/editor/layers/viewHidden.ts'
];

/** What must only ever load lazily. */
const LAZY_ONLY = [
  'components/comicstudio/lettering/pro/ProInspectorExtras.tsx',
  'components/comicstudio/lettering/TransformSection.tsx',
  'components/comicstudio/lettering/NumberField.tsx',
  'components/comicstudio/lettering/NamedStyles.tsx',
  'components/comicstudio/lettering/proStyleOps.ts',
  'components/comicstudio/editor/inspector/InspectorPanel.tsx',
  'components/comicstudio/editor/inspector/proGate.ts',
  'components/comicstudio/editor/inspector/keys.ts',
  'components/comicstudio/editor/inspector/styleClipboard.ts',
  'components/comicstudio/editor/inspector/units.ts',
  'components/comicstudio/editor/layers/LayersPanel.tsx',
  'components/comicstudio/editor/layers/layersModel.ts',
  'shared/comic/editor/scene.ts',
  'shared/comic/editor/align.ts',
  'shared/comic/editor/transform.ts'
];

/** This package's own files (the namespace-read rule is checked on these). */
const OWN = /^components\/comicstudio\/(lettering\/|editor\/(inspector|layers)\/)/;

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

interface Import {
  spec: string;
  /** Every binding is a type (`import type …`, `export type …`, or `{ type A, type B }`): erased at build. */
  typeOnly: boolean;
  /** `import * as N` */
  namespace?: string;
}

/** The static imports and re-exports of a source file (dynamic `import()` and `typeof import()` are not static). */
function staticImports(src: string): Import[] {
  const code = stripComments(src);
  const out: Import[] = [];
  const re = /(^|[;\n])\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const clause = m[4];
    const braces = /\{([\s\S]*)\}/.exec(clause);
    const onlyTypes = !!braces && !/^[\s\w$]+,/.test(clause.split('{')[0]) && braces[1].split(',').map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith('type '));
    const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
    out.push({ spec: m[5], typeOnly: !!m[3] || onlyTypes, ...(ns && m[2] === 'import' ? { namespace: ns[1] } : {}) });
  }
  const bare = /(^|[;\n])\s*import\s*['"]([^'"]+)['"]/g;
  for (let m = bare.exec(code); m; m = bare.exec(code)) out.push({ spec: m[2], typeOnly: false });
  return out;
}

const resolveFile = (fromAbs: string, spec: string): string | undefined => {
  if (!spec.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(fromAbs), spec.replace(/\.js$/, ''));
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(cand) && /\.(ts|tsx)$/.test(cand)) return cand;
  }
  return undefined;
};

/** Every file the entries reach through static, value imports (with the chain that reached each). */
function easyPath(entries: readonly string[]): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: [string, string[]][] = entries.map((e) => [path.join(APP, e), [e]]);
  while (queue.length) {
    const [abs, chain] = queue.shift()!;
    const key = rel(abs);
    if (seen.has(key)) continue;
    seen.set(key, chain);
    for (const imp of staticImports(readFileSync(abs, 'utf8'))) {
      if (imp.typeOnly) continue;
      const next = resolveFile(abs, imp.spec);
      if (next && !seen.has(rel(next))) queue.push([next, [...chain, rel(next)]]);
    }
  }
  return seen;
}

/** Uses of namespace `ns` in `code` that are not static member reads. */
const valueUses = (code: string, ns: string): string[] => {
  const bad: string[] = [];
  const re = new RegExp(`\\b${ns.replace(/\$/g, '\\$')}\\b`, 'g');
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const after = code.slice(m.index + ns.length, m.index + ns.length + 120);
    const before = code.slice(Math.max(0, m.index - 1), m.index);
    if (/^\s*\./.test(after)) continue;
    if (before === '(' && /^\s+as\s+[^()]*\)\s*\./.test(after)) continue;
    bad.push(code.slice(Math.max(0, m.index - 30), m.index + ns.length + 30).replace(/\s+/g, ' '));
  }
  return bad;
};

describe('the Easy path (the page editor without Pro Edit)', () => {
  const reached = easyPath(ENTRIES);

  it('reaches the lettering inspector and its panels (the walk itself works)', () => {
    for (const f of ['components/comicstudio/lettering/ProLetteringPanel.tsx', 'components/comicstudio/lettering/styleOps.ts', 'components/comicstudio/lettering/pro/proExtras.ts', 'shared/comic/lettering/style.ts']) {
      expect(reached.has(f), f).toBe(true);
    }
  });

  it('never statically imports the Pro inspector, Layers, the typed fields or the scene engine', () => {
    const leaks = LAZY_ONLY.filter((f) => reached.has(f)).map((f) => `${f} via ${reached.get(f)!.join(' → ')}`);
    expect(leaks).toEqual([]);
  });

  it('reads module namespaces by static member only (the namespace is never a value)', () => {
    const bad: string[] = [];
    for (const file of reached.keys()) {
      if (!OWN.test(file)) continue;
      const src = stripComments(readFileSync(path.join(APP, file), 'utf8'));
      for (const imp of staticImports(src)) {
        if (!imp.namespace) continue;
        const body = src.replace(/import\s+\*\s+as\s+[\w$]+\s+from\s+['"][^'"]+['"];?/g, '');
        for (const use of valueUses(body, imp.namespace)) bad.push(`${file}: ${use}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the checker sees what it must: a static value import, type-only imports, namespaces and dynamic imports', () => {
    const imps = staticImports(
      [
        "import { TransformSection } from './TransformSection';",
        "import type { NumberCommit } from './NumberField';",
        "import { type A, type B } from './typesOnly';",
        "import * as ns from './ns';",
        "export { x } from './reexport';",
        "const lazy = () => import('./ProInspectorExtras');",
        "type T = typeof import('./ProInspectorExtras');"
      ].join('\n')
    );
    expect(imps.map((i) => [i.spec, i.typeOnly])).toEqual([
      ['./TransformSection', false],
      ['./NumberField', true],
      ['./typesOnly', true],
      ['./ns', false],
      ['./reexport', false]
    ]);
    expect(imps[3].namespace).toBe('ns');
    expect(valueUses('const a = ns.A; const b = (ns as unknown as T).B; f(ns);', 'ns')).toHaveLength(1);
  });
});
