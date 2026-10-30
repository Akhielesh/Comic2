// @vitest-environment node
//
// platform-core stays pure and shippable (plan §5.1, §4.4, W1.1):
// - no import reaches outside the package; no `window`, `document`, `fetch`, `process` or `Buffer`;
// - every relative import names its `.js` file (in platform-core and, once it exists, platform-render), because the
//   backend compiles these files under Node16;
// - scripts/check-consumers.mjs compiles the sources for every consumer (pure ES2017, Comic2 web, the Atlas-shaped
//   tsconfig over both flavours, the backend with strict off and on), and a planted Object.fromEntries / .flat /
//   .replaceAll / .at / structuredClone (or an extensionless import) makes it fail;
// - scripts/export.mjs gives byte-identical output for both flavours on every run.
//
// The scanners read the TypeScript AST (comments and strings never count) and are tested on planted snippets first,
// so a scanner that silently finds nothing fails here too.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const PKG = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const RENDER = resolve(PKG, '../platform-render');
const SLOW = 180_000;

const tsFiles = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (name !== 'node_modules' && name !== 'vendor') tsFiles(abs, out);
    } else if (/\.tsx?$/.test(name)) out.push(abs);
  }
  return out;
};

const temps: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// ── AST scanners ────────────────────────────────────────────────────────────────────────────────────────────────

/** Every module specifier a file names: static and side-effect imports, re-exports, `import()`, `import('x').T`, `require()`. */
const specifiers = (source: string, fileName = 'x.ts'): string[] => {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const e = node.moduleReference.expression;
      if (ts.isStringLiteral(e)) out.push(e.text);
    } else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) out.push(node.arguments[0].text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      out.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
};

const BANNED_GLOBALS = ['window', 'document', 'fetch', 'process', 'Buffer'];

/** Free references to a banned global: an identifier that is not a property name (`x.process`, `{ fetch: f }`). */
const bannedGlobals = (source: string, fileName = 'x.ts'): string[] => {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && BANNED_GLOBALS.indexOf(node.text) !== -1) {
      const p = node.parent;
      const isName =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p)) &&
          p.name === node) ||
        (ts.isQualifiedName(p) && p.right === node);
      if (!isName) out.push(`${node.text} (line ${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
};

const isRelative = (spec: string): boolean => spec.startsWith('./') || spec.startsWith('../');

describe('the scanners find what they look for', () => {
  it('specifiers: static, re-export, side-effect, dynamic, type-level and require', () => {
    const src = [
      "import { a } from './a.js';",
      "export * from '../b';",
      "import './c.js';",
      "const d = await import('./d');",
      "type E = import('./e.js').E;",
      "const f = require('node:fs');",
      "// import { g } from './commented';",
      "const s = \"from './in-a-string'\";",
    ].join('\n');
    expect(specifiers(src)).toEqual(['./a.js', '../b', './c.js', './d', './e.js', 'node:fs']);
  });

  it('bannedGlobals: references, calls and typeof, but not property names, comments or strings', () => {
    const src = [
      'const w = window.innerWidth;',
      'fetch("/x");',
      'if (typeof process !== "undefined") {}',
      'const b = Buffer.from("x");',
      'const doc = document;',
      'deps.fetch("/x"); const o = { fetch: 1, process: 2 }; interface P { window: string }',
      '// window document fetch process Buffer',
      'const t = "window.fetch(process)";',
    ].join('\n');
    expect(bannedGlobals(src).map((x) => x.split(' ')[0])).toEqual(['window', 'fetch', 'process', 'Buffer', 'document']);
  });
});

// ── Purity of the real sources ──────────────────────────────────────────────────────────────────────────────────

describe('platform-core purity', () => {
  const shipped = tsFiles(join(PKG, 'src')).filter((f) => !f.endsWith('.test.ts'));

  it('has sources to check', () => {
    expect(shipped.length).toBeGreaterThanOrEqual(10);
  });

  it('imports nothing outside the package', () => {
    const bad: string[] = [];
    for (const file of shipped) {
      for (const spec of specifiers(readFileSync(file, 'utf8'), file)) {
        const target = resolve(dirname(file), spec);
        if (!isRelative(spec) || !(target + sep).startsWith(join(PKG, 'src') + sep)) bad.push(`${relative(PKG, file)} → ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('uses no window, document, fetch, process or Buffer', () => {
    const bad: string[] = [];
    for (const file of shipped) for (const hit of bannedGlobals(readFileSync(file, 'utf8'), file)) bad.push(`${relative(PKG, file)}: ${hit}`);
    expect(bad).toEqual([]);
  });

  it('every relative import in platform-core and platform-render ends in .js', () => {
    const files = [...tsFiles(join(PKG, 'src')), ...tsFiles(join(PKG, 'conformance')), ...tsFiles(join(RENDER, 'src'))];
    const bad: string[] = [];
    for (const file of files) {
      for (const spec of specifiers(readFileSync(file, 'utf8'), file)) if (isRelative(spec) && !spec.endsWith('.js')) bad.push(`${relative(resolve(PKG, '..'), file)} → ${spec}`);
    }
    expect(bad).toEqual([]);
  });
});

// ── check-consumers ─────────────────────────────────────────────────────────────────────────────────────────────

const runConsumers = (...args: string[]) =>
  spawnSync(process.execPath, [join(PKG, 'scripts/check-consumers.mjs'), ...args], { encoding: 'utf8', timeout: SLOW });

/** Each target's block of output: `ok   name` or `FAIL name` followed by its indented diagnostics. */
const sections = (stdout: string): Record<string, { ok: boolean; text: string }> => {
  const out: Record<string, { ok: boolean; text: string }> = {};
  let current: { ok: boolean; text: string } | undefined;
  for (const line of stdout.split('\n')) {
    const m = /^(ok  |FAIL) (\S+)$/.exec(line);
    if (m) out[m[2]] = current = { ok: m[1] === 'ok  ', text: '' };
    else if (current) current.text += `${line}\n`;
  }
  return out;
};

/** A copy of the package (sources, configs) a test may plant code in. */
const packageCopy = (): string => {
  const dir = tempDir('platform-core-plant-');
  for (const entry of ['src', 'tsconfig.json', 'package.json', 'scripts/tsconfig.atlas.json']) {
    mkdirSync(dirname(join(dir, entry)), { recursive: true });
    cpSync(join(PKG, entry), join(dir, entry), { recursive: true });
  }
  return dir;
};

describe('check-consumers', () => {
  const TARGETS = ['pure', 'comic2-web', 'atlas', 'atlas-bundler-flavour', 'dreamstream-server', 'dreamstream-server-strict'];

  it(
    'compiles for every consumer: pure ES2017, Comic2 (DOM, React 19), Atlas-shaped (both flavours), the backend (strict off and on)',
    () => {
      expect(runConsumers('--list').stdout.trim().split('\n')).toEqual(TARGETS);
      const r = runConsumers();
      const got = sections(r.stdout);
      expect(Object.keys(got)).toEqual(TARGETS);
      for (const name of TARGETS) expect(got[name], `${name}\n${got[name]?.text}`).toMatchObject({ ok: true });
      expect(r.status).toBe(0);
    },
    SLOW,
  );

  it(
    'a planted Object.fromEntries, .flat, .replaceAll, .at or structuredClone fails (ES2017 only)',
    () => {
      const dir = packageCopy();
      const planted: Record<string, string> = {
        'planted-fromEntries.ts': "export const a = Object.fromEntries([['a', 1]]);\n",
        'planted-flat.ts': 'export const b = [[1], [2]].flat();\n',
        'planted-replaceAll.ts': "export const c = 'aa'.replaceAll('a', 'b');\n",
        'planted-at.ts': 'export const d = [1, 2].at(-1);\n',
        'planted-structuredClone.ts': 'export const e = structuredClone({ a: 1 });\n',
      };
      for (const [name, code] of Object.entries(planted)) writeFileSync(join(dir, 'src', name), code);
      const r = runConsumers('--root', dir, '--only', 'pure,atlas');
      expect(r.status).toBe(1);
      const got = sections(r.stdout);
      expect(got.pure.ok).toBe(false);
      for (const name of Object.keys(planted)) expect(got.pure.text, name).toContain(name);
      // The external consumer has the DOM (so structuredClone exists there) but only the ES2017 library.
      expect(got.atlas.ok).toBe(false);
      for (const name of ['planted-fromEntries.ts', 'planted-flat.ts', 'planted-replaceAll.ts', 'planted-at.ts']) expect(got.atlas.text, name).toContain(name);
    },
    SLOW,
  );

  it(
    'a planted extensionless relative import fails the backend (Node16) target',
    () => {
      const dir = packageCopy();
      writeFileSync(join(dir, 'src', 'planted-ext.ts'), "export { s } from './schema/s';\n");
      const r = runConsumers('--root', dir, '--only', 'dreamstream-server');
      expect(r.status).toBe(1);
      expect(sections(r.stdout)['dreamstream-server'].text).toMatch(/planted-ext\.ts.*TS2835/);
    },
    SLOW,
  );
});

// ── export.mjs ──────────────────────────────────────────────────────────────────────────────────────────────────

interface TarEntry {
  name: string;
  data: Buffer;
  /** The raw 512-byte ustar header, for the fixed-field checks. */
  header: Buffer;
  /** A NUL-terminated header field as text. */
  field: (offset: number, length: number) => string;
}

const untar = (buf: Buffer): TarEntry[] => {
  const out: TarEntry[] = [];
  for (let at = 0; at + 512 <= buf.length; ) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const field = (o: number, n: number) => h.subarray(o, o + n).toString('ascii').replace(/\0.*$/s, '');
    const prefix = field(345, 155);
    const name = (prefix ? `${prefix}/` : '') + field(0, 100);
    const size = parseInt(field(124, 12), 8);
    out.push({ name, data: buf.subarray(at + 512, at + 512 + size), header: h, field });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
};

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** npm's fixed tarball time, 1985-10-26T08:15:00Z: never the clock. */
const TAR_MTIME = 499162500;

/**
 * Files that must never ship: tests (except the conformance kit's, which W1.4 ships for hosts to run), scripts and
 * tsconfig files.
 */
const unshippable = (files: string[]): string[] =>
  files.filter((f) => (f.endsWith('.test.ts') && !f.startsWith('conformance/')) || f.startsWith('scripts/') || f.includes('tsconfig'));

describe('export.mjs', () => {
  const run = (out: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(PKG, 'scripts/export.mjs'), '--out', out, ...args], { encoding: 'utf8', timeout: SLOW });

  it(
    'writes both flavours, MANIFEST.json and SHA256SUMS, byte-identical on a second run',
    () => {
      const a = tempDir('platform-core-export-a-');
      const b = tempDir('platform-core-export-b-');
      expect(run(a).status).toBe(0);
      expect(run(b).status).toBe(0);
      const version = (JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { version: string }).version;
      const names = ['MANIFEST.json', 'SHA256SUMS', `platform-core-${version}.tgz`, `platform-core-bundler-${version}.tgz`];
      expect(readdirSync(a).sort()).toEqual(names);
      for (const name of names) expect(readFileSync(join(a, name)).equals(readFileSync(join(b, name))), name).toBe(true);

      // SHA256SUMS verifies, in `sha256sum -c` format.
      const sums = readFileSync(join(a, 'SHA256SUMS'), 'utf8').trim().split('\n');
      expect(sums.map((l) => l.split('  ')[1])).toEqual(names.filter((n) => n !== 'SHA256SUMS'));
      for (const line of sums) {
        const [hash, name] = line.split('  ');
        expect(sha256(readFileSync(join(a, name))), name).toBe(hash);
      }

      const manifest = JSON.parse(readFileSync(join(a, 'MANIFEST.json'), 'utf8')) as {
        name: string;
        version: string;
        gitSha: string;
        flavours: Record<string, { file: string; sha256: string; bytes: number; files: Record<string, string> }>;
      };
      expect(manifest).toMatchObject({ name: '@dreamstream/platform-core', version });
      expect(manifest.gitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(Object.keys(manifest.flavours)).toEqual(['node16', 'bundler']);

      for (const [flavour, info] of Object.entries(manifest.flavours)) {
        const tgz = readFileSync(join(a, info.file));
        expect(sha256(tgz)).toBe(info.sha256);
        expect(tgz.length).toBe(info.bytes);
        // gzip with stored deflate blocks (BTYPE 00): no dependence on the zlib build.
        expect([tgz[0], tgz[1], tgz[2]]).toEqual([0x1f, 0x8b, 8]);
        expect(tgz[10] & 0b110).toBe(0);
        // No clock anywhere: the gzip MTIME (bytes 4-7) is 0, and every tar header is fixed (two runs a few
        // milliseconds apart would not notice a clock rounded to the minute; these checks do).
        expect([...tgz.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
        const entries = untar(gunzipSync(tgz));
        expect(entries.map((e) => e.name)).toEqual(Object.keys(info.files).map((f) => `package/${f}`));
        for (const e of entries) {
          expect(sha256(e.data), e.name).toBe(info.files[e.name.slice('package/'.length)]);
          expect(e.field(136, 12), `${e.name} mtime`).toBe(TAR_MTIME.toString(8).padStart(11, '0'));
          expect(parseInt(e.field(136, 12), 8)).toBe(TAR_MTIME);
          expect(e.field(100, 8), `${e.name} mode`).toBe('0000644');
          expect([e.field(108, 8), e.field(116, 8)], `${e.name} uid/gid`).toEqual(['0000000', '0000000']);
          expect([e.field(265, 32), e.field(297, 32)], `${e.name} uname/gname`).toEqual(['', '']);
          expect(e.field(156, 1), `${e.name} type`).toBe('0');
        }

        const files = Object.keys(info.files);
        expect(files).toContain('package.json');
        expect(files).toContain('src/index.ts');
        expect(files).toContain('src/contract/email.ts');
        expect(files).toContain('fixtures/contract/richdoc/full.json');
        expect(unshippable(files)).toEqual([]);
        expect(files.filter((f) => f.startsWith('src/') && f.endsWith('.test.ts'))).toEqual([]);

        const index = entries.find((e) => e.name === 'package/src/index.ts')!.data.toString('utf8');
        const relativeSpecs = specifiers(index).filter(isRelative);
        expect(relativeSpecs.length).toBeGreaterThan(3);
        if (flavour === 'node16') expect(relativeSpecs.every((sp) => sp.endsWith('.js'))).toBe(true);
        else expect(relativeSpecs.some((sp) => sp.endsWith('.js'))).toBe(false);
      }
    },
    SLOW,
  );

  it(
    'MANIFEST.json does not depend on how the SHA was given: --git-sha <HEAD> and a plain run write the same bytes',
    () => {
      const plain = tempDir('platform-core-export-plain-');
      expect(run(plain).status).toBe(0);
      const manifest = JSON.parse(readFileSync(join(plain, 'MANIFEST.json'), 'utf8')) as { gitSha: string; clean: unknown };
      expect(Object.keys(manifest)).toContain('clean');
      expect([true, false, null]).toContain(manifest.clean);
      const pinned = tempDir('platform-core-export-pinned-');
      expect(run(pinned, '--git-sha', manifest.gitSha).status).toBe(0);
      for (const name of readdirSync(plain)) expect(readFileSync(join(pinned, name)).equals(readFileSync(join(plain, name))), name).toBe(true);
    },
    SLOW,
  );

  it(
    'ships the conformance kit, tests included (W1.4), and still no src/ test',
    () => {
      const dir = packageCopy();
      for (const entry of ['scripts/export.mjs', 'fixtures', 'README.md', 'CHANGELOG.md']) cpSync(join(PKG, entry), join(dir, entry), { recursive: true });
      mkdirSync(join(dir, 'conformance'), { recursive: true });
      writeFileSync(join(dir, 'conformance', 'ports.test.ts'), "import { s } from '../src/index.js';\nexport const kit = s;\n");
      const out = tempDir('platform-core-export-conformance-');
      const r = spawnSync(process.execPath, [join(dir, 'scripts/export.mjs'), '--out', out], { encoding: 'utf8', timeout: SLOW });
      expect(r.status, r.stderr).toBe(0);
      const manifest = JSON.parse(readFileSync(join(out, 'MANIFEST.json'), 'utf8')) as { flavours: Record<string, { files: Record<string, string> }> };
      for (const info of Object.values(manifest.flavours)) {
        const files = Object.keys(info.files);
        expect(files).toContain('conformance/ports.test.ts');
        expect(files).toContain('src/index.ts');
        expect(unshippable(files)).toEqual([]);
        expect(files.filter((f) => f.startsWith('src/') && f.endsWith('.test.ts'))).toEqual([]);
      }
    },
    SLOW,
  );
});
