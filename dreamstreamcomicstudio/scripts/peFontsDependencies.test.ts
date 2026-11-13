// PE-FONTS owns package.json and the lockfile in S2 (lead decision D6). The approved additions are pinned exactly and
// licence-clean, the denied packages never enter the lockfile, lottie-react is gone, and the licence gate passes.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { name?: string; version?: string; license?: string; dependencies?: Record<string, string> }>;
};
const nameOf = (key: string) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
const RADIX = ['@radix-ui/react-dialog', '@radix-ui/react-alert-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-popover', '@radix-ui/react-tooltip', '@radix-ui/react-toast'];
/** Master plan §2.6 licence-gate record 3 (graft 16) and lead decision D6. */
const DENIED = [/^gsap$/, /^tldraw$/, /^@tldraw\//, /^polotno$/, /^@pqina\//, /^tui-image-editor$/];

describe('PE-FONTS dependencies', () => {
  it('no denied package anywhere in the lockfile (by installed path or own name)', () => {
    const hits = Object.entries(lock.packages)
      .filter(([key]) => key)
      .flatMap(([key, v]) => [nameOf(key), v.name ?? ''])
      .filter((n) => DENIED.some((re) => re.test(n)));
    expect(hits).toEqual([]);
  });

  it('lottie-react (unused; its lottie-web needs eval, which the CSP blocks) left package.json and the lockfile', () => {
    expect(pkg.dependencies['lottie-react']).toBeUndefined();
    expect(Object.keys(lock.packages).filter((k) => /node_modules\/lottie-(react|web)$/.test(k))).toEqual([]);
  });

  it('the six Radix overlay packages DS-1c needs are exact pins, MIT, and locked at the pinned version', () => {
    for (const name of RADIX) {
      expect(pkg.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
      const entry = lock.packages[`node_modules/${name}`];
      expect(entry?.version, name).toBe(pkg.dependencies[name]);
      expect(entry?.license, name).toBe('MIT');
      expect(lock.packages[''].dependencies?.[name], name).toBe(pkg.dependencies[name]);
    }
    // Everything they pull in is permissive too.
    const radixTree = Object.entries(lock.packages).filter(([k]) => /node_modules\/(@radix-ui|@floating-ui)\//.test(k));
    expect(radixTree.length).toBeGreaterThan(RADIX.length);
    for (const [k, v] of radixTree) expect(v.license, k).toBe('MIT');
  });

  it('every @fontsource face is an exact pin under OFL-1.1 or Apache-2.0', () => {
    const faces = Object.keys(pkg.dependencies).filter((d) => d.startsWith('@fontsource/'));
    expect(faces.length).toBe(54);
    for (const name of faces) {
      expect(pkg.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
      const entry = lock.packages[`node_modules/${name}`];
      expect(entry?.version, name).toBe(pkg.dependencies[name]);
      expect(['OFL-1.1', 'Apache-2.0'], name).toContain(entry?.license);
    }
  });

  it('the read-only licence gate (node scripts/licence-check.mjs) passes', () => {
    const run = spawnSync(process.execPath, ['scripts/licence-check.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/licence gate: PASS/);
  }, 130_000);
});
