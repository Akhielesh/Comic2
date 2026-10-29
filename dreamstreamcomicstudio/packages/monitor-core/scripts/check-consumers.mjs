#!/usr/bin/env node
// The package must compile for every consumer, by relative path (ADR 0006 WS-2 "done when"):
//   1. on its own, against the ECMAScript library only — the no-DOM / no-Node guard;
//   2. as the live Worker compiles it (strict, Workers types, no DOM);
//   3. as the web app compiles it (strict here, DOM).
// Run from anywhere: node packages/monitor-core/scripts/check-consumers.mjs
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = resolve(pkg, '../..');
const entry = join(pkg, 'src/index.ts');
const tsc = (dir) => {
  const local = join(dir, 'node_modules/.bin/tsc');
  return existsSync(local) ? local : join(app, 'node_modules/.bin/tsc');
};
const common = ['--noEmit', '--strict', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'bundler', '--isolatedModules', '--skipLibCheck'];

const checks = [
  { name: 'pure (ES2022 only)', cwd: pkg, args: ['-p', join(pkg, 'tsconfig.json')] },
  { name: 'live-worker', cwd: join(app, 'live-worker'), args: [...common, '--lib', 'ES2022', '--types', '@cloudflare/workers-types', entry] },
  { name: 'web (live/)', cwd: app, args: [...common, '--lib', 'ES2022,DOM,DOM.Iterable', '--types', 'node', '--allowImportingTsExtensions', entry] },
];

let failed = 0;
for (const c of checks) {
  try {
    execFileSync(tsc(c.cwd), c.args, { cwd: c.cwd, stdio: 'inherit' });
    console.log(`ok   ${c.name}`);
  } catch {
    failed++;
    console.error(`FAIL ${c.name}`);
  }
}
process.exit(failed ? 1 : 0);
