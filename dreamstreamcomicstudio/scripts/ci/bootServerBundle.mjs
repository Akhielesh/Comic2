#!/usr/bin/env node
// Boot the backend the way it ships, before it ships.
//
// The backend runs on Cloudflare Containers from Dockerfile.cloudflare: esbuild bundles
// server/src/index.ts into one server.mjs, and the runtime stage installs only the packages the
// bundle leaves external (sharp, pyodide, sql.js). A dependency that needs a newer Node than the
// image has (supabase-js 2.118 needs Node 22: realtime-js throws at import without a native
// WebSocket) passes typecheck and the unit tests and only fails when the container starts, so every
// instance crash-loops after the deploy. This script catches that class of break in CI:
//
//   1. reads Dockerfile.cloudflare: the image's Node major (every stage must agree), the esbuild
//      command, and the packages the runtime stage installs;
//   2. runs that exact esbuild command, writing server.mjs to a temporary directory;
//   3. gives that directory only the runtime stage's packages (linked from node_modules), so an
//      import the image can't satisfy fails here too;
//   4. starts `node server.mjs` on the image's Node major, with placeholder config and no secrets
//      (Supabase points at 127.0.0.1:9, where nothing listens), and waits for GET /api/health to
//      answer {"status":"ok"};
//   5. sends SIGTERM, as a Container rollout does, and expects a clean exit.
//
// Run from dreamstreamcomicstudio/ after `npm ci`:
//   node scripts/ci/bootServerBundle.mjs [--node=/path/to/node] [--timeout-ms=60000]
// The `server-boot` job (.github/workflows/server-boot.yml; ci.yml runs it on every PR and push to
// Dreamstrream-v1, and deploy-api-proxy.yml's deploy waits for it) sets up Node from the Dockerfile's
// FROM line, so the bundle boots on the same major as production. `--node` boots it on another
// binary (the check that the binary is the image's major still applies).
//
// Exit 0 = the bundle built, listened, answered /api/health and shut down. Anything else exits 1
// with the reason and the tail of the server's output.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Split a shell command list on top-level `&&`, leaving quoted text alone. */
export function splitAndList(cmd) {
  const parts = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < cmd.length) {
        cur += c + cmd[++i];
        continue;
      }
      if (c === quote) quote = '';
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '&' && cmd[i + 1] === '&') {
      parts.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += c;
  }
  if (quote) throw new Error(`unterminated ${quote} quote in: ${cmd.slice(0, 80)}…`);
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

/**
 * What Dockerfile.cloudflare says about the runtime. `problems` lists every way the file
 * disagrees with itself; the boot refuses to run while it is non-empty.
 */
export function readDockerfile(text) {
  const joined = text.replace(/\\\r?\n/g, ' ');
  const lines = joined.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  const problems = [];

  const stages = [];
  for (const l of lines) {
    const m = /^\s*FROM\s+(\S+)/i.exec(l);
    if (!m) continue;
    const node = /^node:(\d+)(?:[.-]\S*)?$/.exec(m[1]);
    stages.push({ image: m[1], nodeMajor: node ? Number(node[1]) : null });
  }
  if (stages.length === 0) problems.push('no FROM line');
  for (const s of stages) if (s.nodeMajor === null) problems.push(`stage image ${s.image} is not node:<major>…`);
  const majors = [...new Set(stages.map((s) => s.nodeMajor).filter((n) => n !== null))];
  if (majors.length > 1) problems.push(`stages run different Node majors: ${majors.join(', ')}`);
  const nodeMajor = majors.length === 1 ? majors[0] : null;

  let esbuild = null;
  let runtimePackages = [];
  for (const l of lines) {
    const run = /^\s*RUN\s+(.*)$/i.exec(l);
    if (!run) continue;
    const cmds = splitAndList(run[1]);
    const found = cmds.find((c) => /^node_modules\/\.bin\/esbuild\s+server\/src\/index\.ts\b/.test(c));
    if (!found) continue;
    esbuild = found;
    // The runtime stage's package.json is generated from the lockfile in the same RUN:
    //   dependencies:{sharp:v('sharp'),pyodide:v('pyodide'),'sql.js':v('sql.js')}
    const gen = cmds.find((c) => /dependencies:\{/.test(c)) ?? '';
    runtimePackages = [...gen.matchAll(/\bv\('([^']+)'\)/g)].map((m) => m[1]);
  }
  if (!esbuild) problems.push('no `RUN node_modules/.bin/esbuild server/src/index.ts …` line');

  const target = esbuild ? /--target=node(\d+)\b/.exec(esbuild) : null;
  const esbuildTargetMajor = target ? Number(target[1]) : null;
  if (esbuild && esbuildTargetMajor === null) problems.push('esbuild has no --target=node<major>');
  if (nodeMajor !== null && esbuildTargetMajor !== null && esbuildTargetMajor !== nodeMajor) {
    problems.push(`esbuild targets node${esbuildTargetMajor} but the image runs Node ${nodeMajor}`);
  }
  const outfile = esbuild ? /--outfile=(\S+)/.exec(esbuild)?.[1] ?? null : null;
  if (esbuild && !outfile) problems.push('esbuild has no --outfile=');
  const externals = esbuild ? [...esbuild.matchAll(/--external:(\S+)/g)].map((m) => m[1]) : [];
  for (const x of externals) {
    if (!runtimePackages.includes(x)) problems.push(`the bundle leaves ${x} external but the runtime stage doesn't install it`);
  }

  // ENV of the last (runtime) stage, literal values only (ARG-fed `$X` values are build metadata).
  const env = {};
  const lastFrom = lines.map((l) => /^\s*FROM\s/i.test(l)).lastIndexOf(true);
  for (const l of lines.slice(lastFrom + 1)) {
    const m = /^\s*ENV\s+(.*)$/i.exec(l);
    if (!m) continue;
    for (const kv of m[1].trim().split(/\s+/)) {
      const eq = kv.indexOf('=');
      if (eq <= 0) continue;
      const value = kv.slice(eq + 1);
      if (!value.includes('$')) env[kv.slice(0, eq)] = value;
    }
  }

  return { stages, nodeMajor, esbuild, esbuildTargetMajor, outfile, externals, runtimePackages, env, problems };
}

/** The Dockerfile's esbuild command with its output redirected to `outfile`. */
export function bundleCommand(esbuild, dockerOutfile, outfile) {
  const flag = `--outfile=${dockerOutfile}`;
  if (!esbuild.includes(flag)) throw new Error(`esbuild command has no ${flag}`);
  return esbuild.replace(flag, `--outfile='${outfile.replace(/'/g, `'\\''`)}'`);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { node: process.execPath, timeoutMs: 60_000 };
  for (const a of argv) {
    const m = /^--([\w-]+)=(.*)$/.exec(a);
    if (m?.[1] === 'node') out.node = m[2];
    else if (m?.[1] === 'timeout-ms') out.timeoutMs = Number(m[2]);
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const log = (msg) => console.log(`[server-boot] ${msg}`);
  const fail = (msg) => {
    console.error(`[server-boot] FAIL: ${msg}`);
    return 1;
  };

  const docker = readDockerfile(readFileSync(path.join(APP, 'Dockerfile.cloudflare'), 'utf8'));
  if (docker.problems.length) return fail(`Dockerfile.cloudflare: ${docker.problems.join('; ')}`);

  const version = execFileSync(args.node, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim();
  const major = Number(version.split('.')[0]);
  if (major !== docker.nodeMajor) {
    return fail(`this would boot on Node ${version}, but the image runs Node ${docker.nodeMajor} (FROM node:${docker.nodeMajor}-…). ` +
      'Set up Node from Dockerfile.cloudflare (see .github/workflows/server-boot.yml).');
  }
  log(`image: Node ${docker.nodeMajor}; booting on Node ${version} (${args.node})`);

  const dir = mkdtempSync(path.join(tmpdir(), 'server-boot-'));
  let child = null;
  try {
    const outfile = path.join(dir, 'server.mjs');
    log(`bundling like Dockerfile.cloudflare → ${outfile}`);
    try {
      execFileSync('/bin/sh', ['-c', bundleCommand(docker.esbuild, docker.outfile, outfile)], { cwd: APP, stdio: 'inherit' });
    } catch {
      return fail('esbuild could not bundle server/src/index.ts');
    }

    // The runtime stage's node_modules: only what its generated package.json installs.
    mkdirSync(path.join(dir, 'node_modules'));
    for (const pkg of docker.runtimePackages) {
      const from = path.join(APP, 'node_modules', pkg);
      if (!existsSync(from)) return fail(`node_modules/${pkg} is missing — run npm ci first`);
      mkdirSync(path.dirname(path.join(dir, 'node_modules', pkg)), { recursive: true });
      symlinkSync(from, path.join(dir, 'node_modules', pkg), 'dir');
    }

    const port = await freePort();
    // No secrets and no developer .env: the image's own ENV, then placeholders for the config the
    // server refuses to start without. Nothing listens on 127.0.0.1:9, so no request leaves the box.
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: dir,
      ...docker.env,
      PORT: String(port),
      CORS_ORIGIN: 'https://dreamstreamstudio.ai',
      VITE_SUPABASE_URL: 'http://127.0.0.1:9',
      VITE_SUPABASE_ANON_KEY: 'placeholder-anon-key',
      BILLING_ENABLED: 'false',
      GIT_SHA: 'ci-boot',
    };
    log(`starting node server.mjs (NODE_ENV=${env.NODE_ENV ?? 'unset'}, NODE_OPTIONS=${env.NODE_OPTIONS ?? 'unset'}, PORT=${port})`);

    const output = [];
    const keep = (chunk) => {
      process.stdout.write(chunk);
      output.push(chunk.toString());
      if (output.length > 400) output.splice(0, output.length - 400);
    };
    child = spawn(args.node, ['server.mjs'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let exited = null;
    const exitedP = new Promise((resolve) => child.once('exit', (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    }));
    const tail = () => output.join('').split('\n').slice(-40).join('\n');

    const started = Date.now();
    let health = null;
    while (Date.now() - started < args.timeoutMs) {
      if (exited) return fail(`the server exited before it answered (code ${exited.code}, signal ${exited.signal}). Last output:\n${tail()}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
        const body = await res.json().catch(() => null);
        if (res.ok && body?.status === 'ok') {
          health = body;
          break;
        }
      } catch {
        // not listening yet
      }
      await sleep(250);
    }
    if (!health) return fail(`GET /api/health did not answer {"status":"ok"} within ${args.timeoutMs} ms. Last output:\n${tail()}`);
    log(`GET /api/health → ${JSON.stringify(health)} after ${Date.now() - started} ms`);

    child.kill('SIGTERM');
    const stop = await Promise.race([exitedP, sleep(30_000).then(() => null)]);
    if (!stop) return fail('the server did not exit within 30 s of SIGTERM');
    if (stop.code !== 0) return fail(`the server exited with code ${stop.code} (signal ${stop.signal}) after SIGTERM. Last output:\n${tail()}`);
    child = null;
    log('SIGTERM → clean exit. The bundle boots on the image\'s Node.');
    return 0;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[server-boot] FAIL: ${err?.stack ?? err}`);
      process.exit(1);
    },
  );
}
