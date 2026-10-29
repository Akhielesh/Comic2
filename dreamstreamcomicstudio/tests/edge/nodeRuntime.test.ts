// @vitest-environment node
/**
 * ADR 0006 WS-1 — one Node for the backend everywhere it runs.
 *
 * @supabase/supabase-js 2.118 (and its auth / realtime / postgrest / storage / functions
 * packages) requires Node >= 22: realtime-js throws "Node.js detected but native WebSocket not
 * found" from the RealtimeClient constructor, and server/src/services/supabase.ts creates its
 * client at module load, so on Node 20 the bundled server exits at import and every container
 * instance crash-loops; the hourly / daily `tsx` jobs die the same way. Typecheck and the unit
 * tests ran on Node 22 and could not see it.
 *
 * So: the container image (both stages, and esbuild's target), the Railway fallback image,
 * .nvmrc / .node-version (Cloudflare Pages and local tooling), package.json engines and every
 * GitHub workflow run one Node major; that Node satisfies the `engines` of every package in the
 * lockfile; and CI boots the bundled server on the image's Node (job `server-boot`).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readDockerfile } from '../../scripts/ci/bootServerBundle.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO = path.join(ROOT, '..');
const WORKFLOWS = path.join(REPO, '.github', 'workflows');
const app = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

type Version = [number, number, number];
const parseVersion = (v: string): Version => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`not a full version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const cmp = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Does `version` satisfy an npm `engines.node` range? Covers the grammar the lockfile uses
 * (`||`, space-joined comparators, >= > <= < = ^ ~, partial and x / * versions) and throws on
 * anything else, so an unfamiliar range fails loudly instead of passing.
 */
function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  return range.split('||').some((set) => {
    const comparators = set.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return true;
    return comparators.every((c) => {
      if (c === '*' || c === 'x') return true;
      const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(c);
      if (!m) throw new Error(`unsupported engines range "${range}" (comparator "${c}")`);
      const op = m[1] ?? '';
      const parts = [m[2], m[3], m[4]].map((p) => (p === undefined || p === 'x' || p === '*' ? null : Number(p)));
      const precision = parts.findIndex((p) => p === null) === -1 ? 3 : parts.findIndex((p) => p === null);
      const lo: Version = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
      // The first version past a partial: 20 → 21.0.0, 20.19 → 20.20.0.
      const next = (p: number): Version => (p === 1 ? [lo[0] + 1, 0, 0] : p === 2 ? [lo[0], lo[1] + 1, 0] : [lo[0], lo[1], lo[2] + 1]);
      switch (op) {
        case '>=': return cmp(v, lo) >= 0;
        case '>': return precision === 3 ? cmp(v, lo) > 0 : cmp(v, next(precision)) >= 0;
        case '<': return cmp(v, lo) < 0;
        case '<=': return precision === 3 ? cmp(v, lo) <= 0 : cmp(v, next(precision)) < 0;
        case '^': {
          const p = lo[0] > 0 || precision === 1 ? 1 : lo[1] > 0 || precision === 2 ? 2 : 3;
          return cmp(v, lo) >= 0 && cmp(v, next(p)) < 0;
        }
        case '~': return cmp(v, lo) >= 0 && cmp(v, next(Math.min(precision, 2))) < 0;
        default: return precision === 3 ? cmp(v, lo) === 0 : cmp(v, lo) >= 0 && cmp(v, next(precision)) < 0;
      }
    });
  });
}

const image = readDockerfile(app('Dockerfile.cloudflare'));
const RUNTIME_MAJOR = image.nodeMajor as number;
const NVMRC = app('.nvmrc').trim();
const major = (v: string) => Number(/^v?(\d+)/.exec(v.trim())?.[1]);

describe('engines range check (the helper below)', () => {
  it('reads the ranges the lockfile uses the way npm does', () => {
    expect(satisfiesRange('20.18.1', '>=22.0.0')).toBe(false);
    expect(satisfiesRange('22.22.0', '>=22.0.0')).toBe(true);
    expect(satisfiesRange('22.12.0', '>=22.13.0 || >=24')).toBe(false);
    expect(satisfiesRange('22.22.0', '^20.19.0 || ^22.12.0 || >=24.0.0')).toBe(true);
    expect(satisfiesRange('23.1.0', '^20.19.0 || ^22.12.0 || >=24.0.0')).toBe(false);
    expect(satisfiesRange('22.22.0', '^20.9.0')).toBe(false);
    expect(satisfiesRange('22.22.0', '20 || >=22')).toBe(true);
    expect(satisfiesRange('21.0.0', '20 || >=22')).toBe(false);
    expect(satisfiesRange('14.18.0', '>=16 || 14 >=14.17')).toBe(true);
    expect(satisfiesRange('14.16.0', '>=16 || 14 >=14.17')).toBe(false);
    expect(satisfiesRange('22.22.0', '6.* || 8.* || >= 10.*')).toBe(true);
    expect(satisfiesRange('22.22.0', '>=v12.22.7')).toBe(true);
    expect(() => satisfiesRange('22.22.0', '>=22 <banana')).toThrow(/unsupported/);
  });
});

describe('the backend runs one Node major everywhere', () => {
  it('Dockerfile.cloudflare: every stage on one node:<major> image, and esbuild targets that major', () => {
    expect(image.problems).toEqual([]);
    expect(image.stages.length).toBeGreaterThanOrEqual(2);
    expect(image.esbuildTargetMajor).toBe(RUNTIME_MAJOR);
    expect(RUNTIME_MAJOR).toBeGreaterThanOrEqual(22);
  });

  it('the Railway fallback image runs the same Node', () => {
    const froms = [...app('Dockerfile').matchAll(/^FROM\s+node:(\d+)\b/gm)].map((m) => Number(m[1]));
    expect(froms.length).toBeGreaterThan(0);
    for (const f of froms) expect(f, 'Dockerfile (Railway) FROM node:<major>').toBe(RUNTIME_MAJOR);
  });

  it('.nvmrc and .node-version (Cloudflare Pages, nvm, local tooling) name one exact version of that major', () => {
    expect(NVMRC).toMatch(/^\d+\.\d+\.\d+$/);
    expect(app('.node-version').trim()).toBe(NVMRC);
    expect(major(NVMRC)).toBe(RUNTIME_MAJOR);
  });

  it('package.json engines (and the lockfile root) start at that major and admit .nvmrc', () => {
    const pkg = JSON.parse(app('package.json')) as { engines: { node: string } };
    const lock = JSON.parse(app('package-lock.json')) as { packages: Record<string, { engines?: { node?: string } }> };
    expect(pkg.engines.node).toMatch(/^>=\d+(\.\d+){0,2}$/);
    expect(major(pkg.engines.node.slice(2))).toBe(RUNTIME_MAJOR);
    expect(satisfiesRange(NVMRC, pkg.engines.node)).toBe(true);
    expect(lock.packages[''].engines?.node).toBe(pkg.engines.node);
  });

  it('every locked package accepts that Node (supabase-js ≥ 2.118 needs 22)', () => {
    const lock = JSON.parse(app('package-lock.json')) as {
      packages: Record<string, { engines?: { node?: string } | string[]; os?: string[] }>;
    };
    const refused: string[] = [];
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key || Array.isArray(entry.engines)) continue;
      const range = entry.engines?.node;
      if (!range) continue;
      // Prebuilt binaries for other operating systems never install where this Node runs
      // (the container, CI and Pages are Linux): @img/sharp-win32-ia32 pins ^20.9.0.
      if (entry.os && !entry.os.includes('linux')) continue;
      if (!satisfiesRange(NVMRC, range)) refused.push(`${key.replace(/^.*node_modules\//, '')} wants node ${range}`);
    }
    expect(refused, `Node ${NVMRC} (the image's major, per .nvmrc) is refused by`).toEqual([]);
  });
});

describe.skipIf(!existsSync(WORKFLOWS))('GitHub workflows run the backend\'s Node', () => {
  const workflows = existsSync(WORKFLOWS)
    ? readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).map((f) => ({ name: f, text: readFileSync(path.join(WORKFLOWS, f), 'utf8') }))
    : [];

  it('every setup-node is on the image\'s major (the catalog and NVIDIA jobs import the server\'s Supabase client)', () => {
    const wrong: string[] = [];
    for (const { name, text } of workflows) {
      for (const line of text.split('\n')) {
        const m = /^\s*node-version:\s*(.+?)\s*$/.exec(line);
        if (!m) continue;
        const value = m[1].replace(/^['"]|['"]$/g, '');
        if (value === '${{ steps.image.outputs.node }}' && name === 'server-boot.yml') continue; // read from the Dockerfile
        if (major(value) !== RUNTIME_MAJOR) wrong.push(`${name}: node-version ${m[1]}`);
      }
    }
    expect(wrong, `every workflow runs Node ${RUNTIME_MAJOR}, the backend image's`).toEqual([]);
  });

  it('CI and the backend deploy boot the bundled server on the Node read from Dockerfile.cloudflare', () => {
    const text = (name: string) => workflows.find((w) => w.name === name)?.text ?? '';
    const boot = text('server-boot.yml');
    expect(boot).toMatch(/^on:\s*\n\s+workflow_call:/m);
    expect(boot).toMatch(/sed -nE 's\/\^FROM\[\[:space:\]\]\+node:\(\[0-9\]\+\)\.\*\/\\1\/p' Dockerfile\.cloudflare/);
    expect(boot).toMatch(/node-version: \$\{\{ steps\.image\.outputs\.node \}\}/);
    expect(boot).toMatch(/run: npm ci --ignore-scripts/);
    expect(boot).toMatch(/run: node scripts\/ci\/bootServerBundle\.mjs\s*$/m);
    expect(boot, 'the boot holds no secrets').not.toMatch(/secrets\.|environment:/);

    const calls = /^ {2}server-boot:\s*\n {4}uses: \.\/\.github\/workflows\/server-boot\.yml\s*$/m;
    expect(text('ci.yml')).toMatch(calls);
    const deploy = text('deploy-api-proxy.yml');
    expect(deploy).toMatch(calls);
    // The rollout waits for the boot: a server that can't start never reaches the containers.
    expect(deploy).toMatch(/^ {2}deploy-worker:\s*\n {4}needs: server-boot\s*$/m);
  });
});
