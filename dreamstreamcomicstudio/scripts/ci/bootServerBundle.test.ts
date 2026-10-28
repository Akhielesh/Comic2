// @vitest-environment node
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundleCommand, main, readDockerfile, splitAndList } from './bootServerBundle.mjs';

const APP = fileURLToPath(new URL('../..', import.meta.url));
const DOCKERFILE = readFileSync(path.join(APP, 'Dockerfile.cloudflare'), 'utf8');

/** A minimal image file in the real one's shape, with the parts a test changes. */
const image = ({ build = 'node:22-slim', run = 'node:22-slim', target = 'node22', externals = ['sharp'], installs = ['sharp'] } = {}) => `
FROM ${build} AS build
RUN npm ci --ignore-scripts && node_modules/.bin/esbuild --version
RUN node_modules/.bin/esbuild server/src/index.ts \\
      --bundle --platform=node --format=esm --target=${target} \\
      ${externals.map((x) => `--external:${x}`).join(' ')} \\
      --outfile=/out/server.mjs \\
      "--banner:js=const a = 1 && 2; const b = 'x';" \\
 && node -e "require('fs').writeFileSync('/out/package.json',JSON.stringify({dependencies:{${installs.map((x) => `'${x}':v('${x}')`).join(',')}}}))"
FROM ${run}
ENV NODE_ENV=production \\
    PORT=8080 \\
    NODE_OPTIONS=--max-old-space-size=512
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
CMD ["node", "server.mjs"]
`;

afterEach(() => vi.restoreAllMocks());

describe('reading Dockerfile.cloudflare', () => {
  it('finds one Node major, the esbuild command and what the runtime stage installs', () => {
    const d = readDockerfile(DOCKERFILE);
    expect(d.problems).toEqual([]);
    expect(d.stages.map((s) => s.nodeMajor)).toEqual([d.nodeMajor, d.nodeMajor]);
    expect(d.esbuildTargetMajor).toBe(d.nodeMajor);
    expect(d.esbuild).toMatch(/^node_modules\/\.bin\/esbuild server\/src\/index\.ts /);
    expect(d.esbuild).toContain('--banner:js=import { createRequire as __cr }');
    expect(d.esbuild).not.toContain('node -e'); // stops at the && that starts the package.json step
    expect(d.outfile).toBe('/out/server.mjs');
    expect([...d.externals].sort()).toEqual(['pyodide', 'sharp', 'sql.js']);
    expect([...d.runtimePackages].sort()).toEqual([...d.externals].sort());
    expect(d.env).toMatchObject({ NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=512' });
    expect(d.env).not.toHaveProperty('GIT_SHA'); // ARG-fed values are build metadata, not runtime config
  });

  it('refuses an image whose stages, or whose esbuild target, disagree on Node', () => {
    expect(readDockerfile(image()).problems).toEqual([]);
    expect(readDockerfile(image({ run: 'node:20-slim' })).problems.join()).toMatch(/different Node majors: 22, 20/);
    expect(readDockerfile(image({ target: 'node20' })).problems.join()).toMatch(/esbuild targets node20 but the image runs Node 22/);
    expect(readDockerfile(image({ run: 'debian:bookworm-slim' })).problems.join()).toMatch(/not node:<major>/);
  });

  it('refuses a bundle that leaves a package external which the runtime stage never installs', () => {
    expect(readDockerfile(image({ externals: ['sharp', 'canvas'] })).problems.join()).toMatch(/leaves canvas external/);
  });

  it('splits a RUN on top-level && only, never inside quotes', () => {
    expect(splitAndList(`a "x && y" && b 'p && q' && c`)).toEqual([`a "x && y"`, `b 'p && q'`, 'c']);
    expect(() => splitAndList('a "open')).toThrow(/unterminated/);
  });

  it('redirects only the output file, quoted for the shell', () => {
    const d = readDockerfile(DOCKERFILE);
    const cmd = bundleCommand(d.esbuild, d.outfile, "/tmp/it's here/server.mjs");
    expect(cmd).toContain(`--outfile='/tmp/it'\\''s here/server.mjs'`);
    expect(cmd.replace(`--outfile='/tmp/it'\\''s here/server.mjs'`, '--outfile=/out/server.mjs')).toBe(d.esbuild);
  });
});

describe('the boot', () => {
  it('will not boot on a Node that is not the image\'s major (CI must read it from the Dockerfile)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fake-node-'));
    try {
      const fake = path.join(dir, 'node');
      // A Node one major behind the image (Node 20 under a Node 22 image was the outage).
      const imageMajor = readDockerfile(DOCKERFILE).nodeMajor as number;
      const behind = `${imageMajor - 1}.9.0`;
      writeFileSync(fake, `#!/bin/sh\necho ${behind}\n`);
      chmodSync(fake, 0o755);
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((m: string) => void errors.push(m));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await main([`--node=${fake}`])).toBe(1);
      expect(errors.join('\n')).toContain(`would boot on Node ${behind}, but the image runs Node ${imageMajor}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
