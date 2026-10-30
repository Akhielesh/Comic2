// @vitest-environment node
//
// platform-render stays a renderer and nothing more (plan §5.1, §9, W1.7):
// - every relative import names its `.js` file (the backend's Node16 rule; platform-core's purity test checks it too);
// - the shipped sources import only their own files, the platform-core contract and kernel, `docx`, `unified`,
//   `remark-parse`, `remark-gfm` and the vendored PptxGenJS;
// - they touch no network, file, DOM or process global (`fetch`, `XMLHttpRequest`, `window`, `document`, `process`,
//   `Buffer`, `require`, `globalThis`, `eval`, `Function`, timers) and make no dynamic `import()`;
// - they compile against the ES2017 library alone (no DOM, no Node types), so the same files run in the browser chunk
//   and, from wave 4, in the light engine.
// The scanners read the TypeScript AST and are tried on planted snippets first, so a scanner that finds nothing fails.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { here } from './render.testkit.js';

const SRC = here('.');
const PKG = here('..');

const shippedFiles = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (name !== 'vendor' && name !== 'node_modules') shippedFiles(abs, out);
    } else if (/\.ts$/.test(name) && !/\.(test|testkit)\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(abs);
  }
  return out;
};

const ALLOWED_BARE = ['docx', 'unified', 'remark-parse', 'remark-gfm'];
const ALLOWED_RELATIVE = [/^\.\/[a-z][A-Za-z]*\.js$/, /^\.\/vendor\/pptxgenjs\/pptxgen\.es\.js$/, /^\.\.\/\.\.\/platform-core\/src\/(contract|schema)\/[a-z][A-Za-z]*\.js$/, /^\.\.\/\.\.\/platform-core\/src\/schema\/index\.js$/];
const BANNED = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'window', 'document', 'navigator', 'process', 'Buffer', 'require', 'globalThis', 'self', 'eval', 'Function', 'setTimeout', 'setInterval', 'importScripts', 'localStorage', 'indexedDB'];

interface Finding {
  kind: 'import' | 'global' | 'dynamic-import';
  what: string;
}

const scan = (source: string, fileName = 'x.ts'): Finding[] => {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: Finding[] = [];
  const declared = new Set<string>();
  const collect = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node) || ts.isClassDeclaration(node)) && node.name && ts.isIdentifier(node.name)) declared.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const ok = spec.charAt(0) === '.' ? ALLOWED_RELATIVE.some((re) => re.test(spec)) : ALLOWED_BARE.indexOf(spec) !== -1;
      if (!ok) out.push({ kind: 'import', what: spec });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      out.push({ kind: 'dynamic-import', what: node.getText(sf).slice(0, 60) });
    } else if (ts.isIdentifier(node) && BANNED.indexOf(node.text) !== -1 && !declared.has(node.text)) {
      const p = node.parent;
      const isName = (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || (ts.isPropertySignature(p) && p.name === node) || ts.isTypeReferenceNode(p) || (ts.isQualifiedName(p) && p.right === node);
      if (!isName) out.push({ kind: 'global', what: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
};

describe('platform-render purity', () => {
  it('the scanner sees planted violations (and not names that only look like them)', () => {
    expect(scan("import x from 'node:fs';")).toEqual([{ kind: 'import', what: 'node:fs' }]);
    expect(scan("import { a } from './a';")).toEqual([{ kind: 'import', what: './a' }]);
    expect(scan("import { a } from '../../platform-core/src/wire/index.js';")).toEqual([{ kind: 'import', what: '../../platform-core/src/wire/index.js' }]);
    expect(scan("export * from 'jszip';")).toEqual([{ kind: 'import', what: 'jszip' }]);
    expect(scan("const m = await import('docx');").map((f) => f.kind)).toEqual(['dynamic-import']);
    expect(scan("fetch('https://x');")).toEqual([{ kind: 'global', what: 'fetch' }]);
    expect(scan('new XMLHttpRequest();')).toEqual([{ kind: 'global', what: 'XMLHttpRequest' }]);
    expect(scan('const b = Buffer.from("x");')).toEqual([{ kind: 'global', what: 'Buffer' }]);
    expect(scan('setTimeout(() => 1, 5);')).toEqual([{ kind: 'global', what: 'setTimeout' }]);
    expect(scan('const o = { fetch: 1 }; o.fetch; const document = 2; document;')).toEqual([]);
    expect(scan("import { x } from './images.js'; import y from 'docx';")).toEqual([]);
  });

  it('shipped sources import only the contract, the kernel, docx, unified/remark and the vendored PptxGenJS, and touch no global', () => {
    const files = shippedFiles(SRC);
    expect(files.map((f) => relative(SRC, f)).sort()).toEqual(['docx.ts', 'errors.ts', 'images.ts', 'index.ts', 'markdown.ts', 'pptx.ts', 'style.ts']);
    const findings: string[] = [];
    for (const f of files) for (const x of scan(readFileSync(f, 'utf8'), f)) findings.push(`${relative(SRC, f)}: ${x.kind} ${x.what}`);
    expect(findings).toEqual([]);
  });

  it('every relative import in the package (tests included) names its .js file', () => {
    const all: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) {
          if (name !== 'vendor' && name !== 'node_modules') walk(abs);
        } else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name)) all.push(abs);
      }
    };
    walk(SRC);
    const bad: string[] = [];
    for (const f of all) {
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
      sf.forEachChild((n) => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
          const spec = n.moduleSpecifier.text;
          if (spec.charAt(0) === '.' && !/\.js$/.test(spec)) bad.push(`${relative(SRC, f)}: ${spec}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it('compiles against ES2017 alone, with no DOM and no Node types (tsconfig.json)', () => {
    const tsc = join(PKG, '../../node_modules/typescript/bin/tsc');
    expect(existsSync(tsc)).toBe(true);
    const r = spawnSync(process.execPath, [tsc, '-p', join(PKG, 'tsconfig.json')], { encoding: 'utf8' });
    expect(`${r.stdout}${r.stderr}`.trim()).toBe('');
    expect(r.status).toBe(0);
  }, 180_000);
});
