// @vitest-environment node
/**
 * ADR 0006 WS-1 — supply chain, kept that way: SHA-pinned workflow actions with least-privilege
 * tokens, no install scripts or @latest tools next to deploy secrets, Dependabot with a cooldown,
 * code owners on the risky paths, SRI on third-party scripts, a lockfile that only names the
 * npm registry, the dependency floors this phase set, and a security.txt that hasn't expired.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO = path.join(ROOT, '..');
const GITHUB = path.join(REPO, '.github');
const read = (abs: string) => readFileSync(abs, 'utf8');
const app = (rel: string) => read(path.join(ROOT, rel));

/** Lines that aren't comments (a trailing `# vX.Y.Z` stays on its line). */
const codeLines = (text: string) => text.split('\n').filter((l) => !/^\s*#/.test(l));

const HAS_GITHUB = existsSync(path.join(GITHUB, 'workflows'));

describe.skipIf(!HAS_GITHUB)('GitHub workflows (repo root .github/)', () => {
  const workflows = HAS_GITHUB
    ? readdirSync(path.join(GITHUB, 'workflows')).filter((f) => /\.ya?ml$/.test(f)).map((f) => ({ name: f, text: read(path.join(GITHUB, 'workflows', f)) }))
    : [];

  it('pins every action by commit SHA, with the version it stands for', () => {
    const loose: string[] = [];
    for (const { name, text } of workflows) {
      for (const line of codeLines(text)) {
        const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
        if (!m || m[1].startsWith('./')) continue;
        if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(m[1]) || !/#\s*v\d+(\.\d+)*/.test(m[2])) loose.push(`${name}: ${line.trim()}`);
      }
    }
    expect(loose).toEqual([]);
  });

  it('defaults every workflow token to read-only; writes are granted per job', () => {
    for (const { name, text } of workflows) {
      const lines = text.split('\n');
      const start = lines.findIndex((l) => /^permissions:/.test(l));
      expect(start, `${name} has top-level permissions`).toBeGreaterThanOrEqual(0);
      const block: string[] = [];
      for (const l of lines.slice(start + 1)) {
        if (/^\S/.test(l)) break;
        block.push(l);
      }
      expect(block.join('\n'), name).toMatch(/contents:\s*read/);
      expect(block.join('\n'), `${name}: no top-level write`).not.toMatch(/:\s*write/);
      expect(lines[start], name).not.toMatch(/write-all/);
    }
  });

  it('checks out without persisting the token, installs without scripts, never runs @latest tools', () => {
    for (const { name, text } of workflows) {
      const lines = codeLines(text);
      lines.forEach((line, i) => {
        if (/uses:\s*actions\/checkout@/.test(line)) {
          expect(lines.slice(i + 1, i + 4).join('\n'), `${name}: checkout persist-credentials`).toMatch(/persist-credentials:\s*false/);
        }
        if (/\bnpm ci\b/.test(line)) expect(line, `${name}: ${line.trim()}`).toMatch(/--ignore-scripts/);
        expect(line, `${name}: ${line.trim()}`).not.toMatch(/@latest\b/);
      });
    }
  });

  it('runs every job that holds the Cloudflare deploy token in the production-deploy Environment', () => {
    for (const { name, text } of workflows) {
      if (!/secrets\.CLOUDFLARE_API_TOKEN/.test(text)) continue;
      expect(text, name).toMatch(/^\s+environment:\s*production-deploy\s*$/m);
    }
  });

  it('has Dependabot (npm + actions) with a cooldown of at least 7 days', () => {
    const cfg = read(path.join(GITHUB, 'dependabot.yml'));
    for (const eco of ['npm', 'github-actions']) {
      const section = cfg.split(/\n\s*- package-ecosystem:/).find((s) => s.trimStart().startsWith(eco) || s.includes(`package-ecosystem: ${eco}`));
      expect(section, eco).toBeTruthy();
      const days = Number(/cooldown:\s*\n\s*default-days:\s*(\d+)/.exec(section!)?.[1]);
      expect(days, `${eco} cooldown`).toBeGreaterThanOrEqual(7);
    }
    expect(cfg).toContain('/dreamstreamcomicstudio');
  });

  it('puts the workflows and the edge security files behind code owners, and publishes a policy', () => {
    const owners = read(path.join(GITHUB, 'CODEOWNERS'));
    for (const p of ['/.github/', '/dreamstreamcomicstudio/functions/', '/dreamstreamcomicstudio/public/_headers', '/dreamstreamcomicstudio/package-lock.json']) {
      expect(owners).toMatch(new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s+@\\w`, 'm'));
    }
    expect(existsSync(path.join(GITHUB, 'SECURITY.md'))).toBe(true);
    expect(workflows.some((w) => /ossf\/scorecard-action@/.test(w.text))).toBe(true);
  });
});

describe('dependencies', () => {
  const pkg = JSON.parse(app('package.json')) as {
    dependencies: Record<string, string>; devDependencies: Record<string, string>; overrides?: Record<string, unknown>;
  };
  const lock = JSON.parse(app('package-lock.json')) as { lockfileVersion: number; packages: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }> };
  const semver = (v: string) => v.replace(/^[\^~]/, '').split('.').map((n) => parseInt(n, 10));
  const atLeast = (v: string, min: string) => {
    const [a, b] = [semver(v), semver(min)];
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return true;
  };

  it('runs the sound model on a stable ONNX Runtime and the auth client new enough for MFA', () => {
    expect(pkg.dependencies['onnxruntime-web']).toMatch(/^\d+\.\d+\.\d+$/); // exact, and no -dev build
    expect(atLeast(pkg.dependencies['onnxruntime-web'], '1.30.0')).toBe(true);
    expect(lock.packages['node_modules/onnxruntime-web'].version).toBe(pkg.dependencies['onnxruntime-web']);
    expect(atLeast(pkg.dependencies['@supabase/supabase-js'], '2.118.0')).toBe(true);
    expect(atLeast(lock.packages['node_modules/@supabase/supabase-js'].version!, '2.118.0')).toBe(true);
  });

  it('keeps the dictation model runtime under Pages’ 25 MiB file limit (transformers held, native deps patched)', () => {
    // @huggingface/transformers 4.3.x bundles an ONNX Runtime whose asyncify .wasm is 25.6 MiB —
    // over the Pages per-file limit, so the site would not deploy. It stays on 4.2.0 until that
    // changes (liveCsp.built.test.ts checks every built file); its Node-only native deps, which
    // the browser never loads, are lifted past their advisories by overrides.
    expect(pkg.dependencies['@huggingface/transformers']).toBe('4.2.0');
    expect(pkg.overrides).toEqual({ '@huggingface/transformers': { sharp: '$sharp', 'onnxruntime-node': expect.stringMatching(/^\d+\.\d+\.\d+$/) } });
  });

  it('never asks for "latest" or "*"', () => {
    for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(spec, name).not.toMatch(/^(latest|\*|x)$/i);
    }
  });

  it('resolves every package from the npm registry, with an integrity hash', () => {
    expect(lock.lockfileVersion).toBe(3);
    const odd = Object.entries(lock.packages)
      .filter(([k, v]) => k && !v.link && (!v.resolved?.startsWith('https://registry.npmjs.org/') || !/^sha512-/.test(v.integrity ?? '')))
      .map(([k]) => k);
    expect(odd).toEqual([]);
  });
});

describe('third-party code in the pages', () => {
  it('index.html pins every external script with Subresource Integrity', () => {
    const doc = new JSDOM(app('index.html')).window.document;
    const external = [...doc.querySelectorAll('script[src]')].filter((s) => /^https?:/i.test(s.getAttribute('src') ?? ''));
    expect(external.length).toBeGreaterThan(0);
    for (const s of external) {
      expect(s.getAttribute('integrity'), s.getAttribute('src')!).toMatch(/^sha(384|512)-[A-Za-z0-9+/]+=*$/);
      expect(s.getAttribute('crossorigin'), s.getAttribute('src')!).toBe('anonymous');
    }
    expect(new JSDOM(app('live.html')).window.document.querySelectorAll('script[src^="http"]').length).toBe(0);
  });

  it('the YAMNet worker fetches nothing but our own hash-checked model', () => {
    const src = app('live/monitor/yamnet.worker.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/https?:\/\//);
    expect(code).toMatch(/const MODEL_URL = '\/models\/yamnet\/yamnet-v1\.onnx'/);
    expect(code).toMatch(/MODEL_SHA256 = '[0-9a-f]{64}'/);
  });
});

describe('security.txt (RFC 9116)', () => {
  const txt = app('public/.well-known/security.txt');
  const field = (name: string) => [...txt.matchAll(new RegExp(`^${name}:\\s*(.+)$`, 'gmi'))].map((m) => m[1].trim());

  it('has a contact, a policy and both canonical addresses', () => {
    expect(field('Contact').length).toBeGreaterThan(0);
    for (const c of field('Contact')) expect(c).toMatch(/^(mailto:|https:\/\/)/);
    expect(field('Policy')[0]).toMatch(/^https:\/\//);
    expect(field('Canonical')).toEqual(expect.arrayContaining([
      'https://dreamstreamstudio.ai/.well-known/security.txt',
      'https://stream.dreamstreamstudio.ai/.well-known/security.txt',
    ]));
  });

  it('has not expired, and expires within about a year (refresh it before then)', () => {
    const [expires] = field('Expires');
    const t = Date.parse(expires);
    expect(Number.isFinite(t)).toBe(true);
    expect(t, 'security.txt has expired — set a new Expires (≤ 1 year ahead)').toBeGreaterThan(Date.now());
    expect(t - Date.now()).toBeLessThan(400 * 24 * 3600 * 1000);
  });
});
