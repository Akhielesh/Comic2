#!/usr/bin/env node
// The package must compile for every consumer (plan §5.1, W1.1). Each target compiles every shipped source
// (src/**/*.ts except tests) the way that consumer does:
//
//   pure                       tsconfig.json: the ES2017 library alone, no types, Node16, strict — the no-DOM /
//                              no-Node / ES2017-only guard (Object.fromEntries, .flat, .replaceAll, .at and
//                              structuredClone all fail here)
//   comic2-web                 the Comic2 web app: ES2022 + DOM, React 19 and Node types, bundler resolution, strict
//   atlas                      an external Next.js-style consumer (scripts/tsconfig.atlas.json): lib dom,
//                              dom.iterable, es2017; bundler resolution; isolatedModules; strict
//   atlas-bundler-flavour      the same options over the bundler flavour export.mjs ships (.js suffixes stripped)
//   dreamstream-server         the backend's build:server: Node16 module and resolution, Node types, strict OFF
//   dreamstream-server-strict  the same with strict on
//
//   node packages/platform-core/scripts/check-consumers.mjs [--root <package dir>] [--only name,name] [--list]
//
// --root checks another copy of the package (a test plants code in one); tsc always comes from this app.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsSuffixes } from './export.mjs';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = resolve(here, '../..');
const tsc = join(app, 'node_modules/typescript/bin/tsc');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const pkg = resolve(opt('--root') ?? here);

const sources = (dir, out = []) => {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) sources(abs, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(abs);
  }
  return out;
};
const files = sources(join(pkg, 'src'));

const SERVER = ['--noEmit', '--target', 'ES2022', '--module', 'Node16', '--moduleResolution', 'Node16', '--types', 'node', '--esModuleInterop', '--skipLibCheck', '--resolveJsonModule', '--forceConsistentCasingInFileNames'];
const WEB = [
  '--noEmit', '--strict', '--target', 'ES2022', '--lib', 'ES2022,DOM,DOM.Iterable', '--module', 'ESNext', '--moduleResolution', 'bundler',
  '--isolatedModules', '--moduleDetection', 'force', '--jsx', 'react-jsx', '--allowImportingTsExtensions', '--types', 'node,react', '--skipLibCheck',
];

/** A copy of the package with the bundler flavour's sources (what export.mjs ships in platform-core-bundler-*.tgz). */
const bundlerCopy = () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-core-bundler-'));
  mkdirSync(join(dir, 'scripts'));
  cpSync(join(pkg, 'scripts/tsconfig.atlas.json'), join(dir, 'scripts/tsconfig.atlas.json'));
  for (const abs of files) {
    const rel = relative(pkg, abs).split(sep).join('/');
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), stripJsSuffixes(readFileSync(abs, 'utf8')));
  }
  return dir;
};

const targets = [
  { name: 'pure', args: () => ['-p', join(pkg, 'tsconfig.json')] },
  { name: 'comic2-web', args: () => [...WEB, ...files] },
  { name: 'atlas', args: () => ['-p', join(pkg, 'scripts/tsconfig.atlas.json')] },
  { name: 'atlas-bundler-flavour', setup: bundlerCopy, args: (dir) => ['-p', join(dir, 'scripts/tsconfig.atlas.json')] },
  { name: 'dreamstream-server', args: () => [...SERVER, '--strict', 'false', ...files] },
  { name: 'dreamstream-server-strict', args: () => [...SERVER, '--strict', ...files] },
];

if (args.includes('--list')) {
  for (const t of targets) console.log(t.name);
  process.exit(0);
}
const only = opt('--only')?.split(',');
if (only) for (const name of only) if (!targets.some((t) => t.name === name)) throw new Error(`check-consumers: unknown target ${name}`);
if (!existsSync(tsc)) throw new Error(`check-consumers: no TypeScript at ${tsc}`);

let failed = 0;
for (const t of targets) {
  if (only && !only.includes(t.name)) continue;
  const dir = t.setup?.();
  try {
    const r = spawnSync(process.execPath, [tsc, ...t.args(dir)], { cwd: app, encoding: 'utf8' });
    if (r.status === 0) console.log(`ok   ${t.name}`);
    else {
      failed++;
      console.log(`FAIL ${t.name}`);
      process.stdout.write(`${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`.replace(/^/gm, '     '));
      console.log('');
    }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
