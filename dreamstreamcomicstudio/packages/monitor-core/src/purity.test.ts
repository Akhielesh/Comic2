// @vitest-environment node
//
// The package must stay pure (ADR 0006 D2): the same files run in browsers, the live Worker
// and React Native. Compiling src/ against the ECMAScript library alone (tsconfig.json) is
// the guard — a stray `window`, `Buffer` or `crypto.subtle` type fails it — so CI runs it
// with the unit tests. (scripts/check-consumers.mjs adds the Worker and web builds.)
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const tsc = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));

describe('monitor-core purity', () => {
  it('compiles against ES2022 alone: no DOM, no Node, no Workers types', () => {
    expect(() => execFileSync(process.execPath, [tsc, '-p', `${pkg}tsconfig.json`], { cwd: pkg, stdio: 'pipe' })).not.toThrow();
  }, 60_000);

  it('imports nothing but its own files', () => {
    for (const f of readdirSync(`${pkg}src`).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      // Code only: prose in comments may say "window" or "process".
      const src = readFileSync(`${pkg}src/${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) expect(m[1], `${f} imports ${m[1]}`).toMatch(/^\.\/[a-zA-Z]+$/);
      expect(src, f).not.toMatch(/\b(require\(|process\.|window\.|document\.|navigator\.|Buffer\.)/);
    }
  });
});
