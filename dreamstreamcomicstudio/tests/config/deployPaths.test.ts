// @vitest-environment node
/**
 * S18 — every source file a deploy workflow's Worker (or the backend container image) BUNDLES must
 * match that workflow's `on.push.paths`. Otherwise a fix to it ships to Pages (which deploys on
 * every push) but never to the edge: e.g. api-proxy/src/publicComic.ts bundles
 * functions/_shared/shareHead.ts, so a hardening there would go live on /c/* while
 * /api/comic/public/s/:slug kept serving the old code, with no signal.
 *
 * Bundle inputs come from esbuild's metafile (the same bundler wrangler and Dockerfile.cloudflare
 * use), so only runtime imports count. `x/**` in a workflow means "anything under x/", anything else
 * is an exact file. A new cross-folder import fails here until the workflow watches it.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const APP = fileURLToPath(new URL('../..', import.meta.url));
const REPO = path.resolve(APP, '..');
const WORKFLOWS = path.join(REPO, '.github/workflows');
const PREFIX = 'dreamstreamcomicstudio/';

/** Workflow → the entry points it deploys (Worker `main`s; the container's esbuild entry). */
const DEPLOYS: Record<string, string[]> = {
  'deploy-api-proxy.yml': ['api-proxy/src/index.ts', 'server/src/index.ts'],
  'deploy-comics-edge.yml': ['comics-edge/src/index.ts'],
  'deploy-live-worker.yml': ['live-worker/src/index.ts'],
  'deploy-email-worker.yml': ['email-worker/src/index.ts'],
  'deploy-data-egress.yml': ['data-egress/src/index.ts']
};

/** The app-relative globs under `on.push.paths` (other entries — the workflow file itself — skipped). */
const pushPaths = (yml: string): string[] => {
  const block = /\n {4}paths:\n((?: {6}(?:- '[^']+'|#.*)\n)+)/.exec(yml)?.[1] ?? '';
  return [...block.matchAll(/- '([^']+)'/g)]
    .map((m) => m[1])
    .filter((p) => p.startsWith(PREFIX))
    .map((p) => p.slice(PREFIX.length));
};

const covered = (file: string, globs: string[]): boolean =>
  globs.some((g) => (g.endsWith('/**') ? file.startsWith(g.slice(0, -2)) : file === g));

const bundledSources = async (entry: string): Promise<string[]> => {
  const { metafile } = await build({
    absWorkingDir: APP,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    logLevel: 'silent',
    platform: 'node',
    format: 'esm',
    packages: 'external',
    external: ['cloudflare:*']
  });
  return Object.keys(metafile.inputs).filter((f) => !f.includes('node_modules'));
};

describe('deploy workflows watch every file they bundle (S18)', () => {
  it('the path parser reads the real format', () => {
    const yml = "on:\n  push:\n    branches: [x]\n    paths:\n      - 'dreamstreamcomicstudio/a/**'\n      # comment\n      - 'dreamstreamcomicstudio/b.ts'\n      - '.github/workflows/w.yml'\n  workflow_dispatch:\n";
    expect(pushPaths(yml)).toEqual(['a/**', 'b.ts']);
    expect(covered('a/x/y.ts', ['a/**'])).toBe(true);
    expect(covered('ab/x.ts', ['a/**'])).toBe(false);
    expect(covered('b.ts', ['b.ts'])).toBe(true);
  });

  for (const [workflow, entries] of Object.entries(DEPLOYS)) {
    it(workflow, async () => {
      const file = path.join(WORKFLOWS, workflow);
      expect(existsSync(file), `${workflow} exists`).toBe(true);
      const globs = pushPaths(readFileSync(file, 'utf8'));
      // A YAML reshuffle must fail loudly, not pass with nothing to check.
      expect(globs.length).toBeGreaterThan(0);
      const missing = new Set<string>();
      for (const entry of entries) {
        expect(existsSync(path.join(APP, entry)), entry).toBe(true);
        for (const source of await bundledSources(entry)) if (!covered(source, globs)) missing.add(source);
      }
      expect([...missing].sort()).toEqual([]);
    }, 30_000);
  }
});
