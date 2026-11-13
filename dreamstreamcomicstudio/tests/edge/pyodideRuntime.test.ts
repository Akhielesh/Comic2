// @vitest-environment node
/**
 * The browser's Python runtime (Pyodide) comes from our own origin, pinned by hash — and stays that way.
 *
 * The owner's rule: no unpinned third-party script may run in our origin. The chat's Python playground used
 * to `importScripts('https://cdn.jsdelivr.net/pyodide/…')` inside a same-origin blob: worker. Now the runtime
 * is the `pyodide` npm package's own files (the backend sandbox's dependency), held to PYODIDE_RUNTIME_PIN
 * (services/pyodideRuntime.ts), copied to /pyodide/<version>/ by the build and served by the Pages Function.
 *
 *   the pin            is the installed package, byte for byte; one exact version for browser and backend
 *   the build          stops on a version or byte that is not pinned; emits exactly the pinned files; the
 *                      licence gate sees them as browser code and the notices list them
 *   dev / preview      serve the same files under the same contract as the Function
 *   the Pages Function serves only the pinned files (first bytes checked, own headers, no CORS grant) and
 *                      answers everything else under the folder with a 404 — never the SPA's index.html;
 *                      it is the voice engine's own serving code (/ort/, tests/edge/voiceRuntime.test.ts)
 *   _headers/_routes   hold nothing that would serve or label the folder behind the Function's back (nor _redirects)
 *   the runner         is a same-origin module worker with no other origin in it; the page CSP needs nothing new
 *   the built site     (after `npm run build`; CI builds before it tests) carries exactly the pinned bytes
 *
 * tests/e2e/python.runtime.spec.ts runs real Python in a browser and watches every request.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin, type Rollup } from 'vite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createOnRequest, mainCsp } from '../../functions/_middleware';
import { buildCsp } from '../../functions/_shared/csp';
import * as gate from '../../scripts/licence-check.mjs';
import { ORT_CACHE_CONTROL, ORT_RESOURCE_POLICY, ORT_RUNTIME_PIN, PAGES_FILE_LIMIT_BYTES } from '../../services/dictation/ortRuntime';
import {
  PYODIDE_FIRST_BYTES,
  PYODIDE_RUNTIME_BASE,
  PYODIDE_RUNTIME_CACHE_CONTROL,
  PYODIDE_RUNTIME_FILES,
  PYODIDE_RUNTIME_PIN,
  PYODIDE_RUNTIME_RESOURCE_POLICY,
  PYODIDE_RUNTIME_ROOT,
  hasPyodideFirstBytes,
  isPyodideRuntimePath,
  looksLikePyodideRuntimeFile,
  pyodideContentType,
  pyodideRuntimeFileAt,
  pyodideRuntimePath,
  type PyodideRuntimeFileName,
} from '../../services/pyodideRuntime';
import viteConfig, { licenceModules, pyodideRuntime, pyodideRuntimeMiddleware, readPinnedPyodide } from '../../vite.config';
import { allowsUrl, parsePolicy } from './cspEval';

const APP = fileURLToPath(new URL('../..', import.meta.url));
const PKG_DIR = path.join(APP, 'node_modules/pyodide');
const DIST = path.join(APP, 'dist');
const PIN = PYODIDE_RUNTIME_PIN;
const VERSION = PIN.version;
const app = (rel: string) => readFileSync(path.join(APP, rel), 'utf8');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const installed = (file: string) => readFileSync(path.join(PKG_DIR, file));
/** Source code without comments (a comment may name the CDN the runtime left). */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
/** A URL on another host whose PATH names Pyodide — a runtime location (…/pyodide/v0.26.4/full/), not a link to pyodide.org. */
const PYODIDE_ELSEWHERE = /https?:\/\/[^\s'"`/]+\/[^\s'"`]*pyodide/i;

const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const INDEX_HTML = '<!DOCTYPE html><html><head><title>DreamStream Studio</title></head><body><div id="root"></div></body></html>';

describe('the pin (services/pyodideRuntime.ts)', () => {
  it('is the installed pyodide package: the version, and every file by SHA-256, size and first bytes', () => {
    expect(JSON.parse(installed('package.json').toString('utf8')).version).toBe(VERSION);
    for (const file of PYODIDE_RUNTIME_FILES) {
      const bytes = installed(file);
      const pin = PIN.files[file];
      expect(sha256(bytes), `${file} sha256`).toBe(pin.sha256);
      expect(bytes.length, `${file} bytes`).toBe(pin.bytes);
      expect(bytes.subarray(0, pin.starts.length).toString('latin1'), `${file} first bytes`).toBe(pin.starts);
      expect(hasPyodideFirstBytes(file, bytes)).toBe(true);
    }
    // The build's own reader agrees, and returns exactly these files.
    expect(readPinnedPyodide().map((f) => f.name)).toEqual(PYODIDE_RUNTIME_FILES);
  });

  it('pins exactly what the browser loads: the module loader, its glue, the WebAssembly module, the standard library and the lock file', () => {
    expect([...PYODIDE_RUNTIME_FILES].sort()).toEqual(['pyodide-lock.json', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'pyodide.mjs', 'python_stdlib.zip']);
    expect(PIN.package).toBe('pyodide');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PYODIDE_RUNTIME_BASE).toBe(`/pyodide/${VERSION}/`);
    // The loader imports the glue and fetches the rest by these names, from the folder it is given.
    const loader = installed('pyodide.mjs').toString('utf8');
    for (const name of ['pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) expect(loader, name).toContain(name);
    for (const file of PYODIDE_RUNTIME_FILES) {
      const pin = PIN.files[file];
      expect(pin.sha256, file).toMatch(/^[0-9a-f]{64}$/);
      // Cloudflare Pages refuses a file of 25 MiB or more (the largest here is the 9.6 MB WebAssembly module).
      expect(pin.bytes, `${file} fits Pages`).toBeLessThan(PAGES_FILE_LIMIT_BYTES);
      expect(pin.starts.length, `${file} first bytes`).toBeGreaterThanOrEqual(4);
      expect(pin.starts.length).toBeLessThanOrEqual(PYODIDE_FIRST_BYTES);
      expect([...pin.starts].every((c) => c.charCodeAt(0) < 256), `${file}: one byte per character`).toBe(true);
      // Never something a browser would render or sniff as a page.
      expect(pin.starts.trimStart().startsWith('<'), file).toBe(false);
    }
    expect(PIN.files['pyodide.asm.wasm'].type).toBe('application/wasm'); // WebAssembly.instantiateStreaming needs it
    expect(PIN.files['pyodide.mjs'].type).toMatch(/^text\/javascript\b/); // a module script needs a JavaScript type
    expect(PIN.files['pyodide.asm.mjs'].type).toMatch(/^text\/javascript\b/);
    expect(PIN.files['pyodide-lock.json'].type).toMatch(/^application\/json\b/);
    expect(PIN.files['python_stdlib.zip'].type).toBe('application/zip');
  });

  it('is one exact version for the browser and the backend, locked to the npm registry with an integrity hash', () => {
    const pkg = JSON.parse(app('package.json')) as { dependencies: Record<string, string> };
    const lock = JSON.parse(app('package-lock.json')) as { packages: Record<string, { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string> }> };
    // Exact, so `npm install` can never drift past the pin; a bump is a reviewed change to the pin itself.
    expect(pkg.dependencies.pyodide).toBe(VERSION);
    expect(lock.packages[''].dependencies?.pyodide).toBe(VERSION);
    const locked = lock.packages['node_modules/pyodide'];
    expect(locked.version).toBe(VERSION);
    expect(locked.resolved).toBe(`https://registry.npmjs.org/pyodide/-/pyodide-${VERSION}.tgz`);
    expect(locked.integrity).toMatch(/^sha512-/);
    // The backend image installs the lockfile's version of the same package (server/src/services/pyodideRunner.ts).
    expect(app('Dockerfile.cloudflare')).toContain("pyodide:v('pyodide')");
  });

  it('the pinned lock file names every package by a relative file name, so nothing in it points at another host', () => {
    const lock = JSON.parse(installed('pyodide-lock.json').toString('utf8')) as { info: { python: string }; packages: Record<string, { file_name: string; sha256: string }> };
    const entries = Object.values(lock.packages);
    expect(entries.length).toBeGreaterThan(100);
    expect(entries.filter((p) => /^[a-z][a-z0-9+.-]*:|^\/\//i.test(p.file_name)).map((p) => p.file_name)).toEqual([]);
    for (const p of entries) expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the loader names one other origin, its default package host, which the worker overrides', () => {
    const origins = (file: string) => [...new Set([...installed(file).toString('utf8').matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]))];
    // pyodide.mjs: `cdnUrl = packageBaseUrl ?? 'https://cdn.jsdelivr.net/pyodide/v…/full/'` — read in Node only, and the
    // worker passes packageBaseUrl (below). A NEW origin in a pinned file fails here until someone has read why.
    expect(origins('pyodide.mjs')).toEqual(['https://cdn.jsdelivr.net']);
    expect(installed('pyodide.mjs').toString('utf8')).toMatch(/packageBaseUrl\?\?`https:\/\/cdn\.jsdelivr\.net\/pyodide\//);
    expect(origins('pyodide.asm.mjs')).toEqual([]);
  });
});

describe('paths and first bytes', () => {
  it('only the pinned version’s files are runtime files', () => {
    for (const file of PYODIDE_RUNTIME_FILES) {
      expect(pyodideRuntimePath(file)).toBe(`/pyodide/${VERSION}/${file}`);
      expect(pyodideRuntimeFileAt(pyodideRuntimePath(file))).toBe(file);
    }
    for (const path of [
      '/pyodide',
      '/pyodide/',
      `/pyodide/${VERSION}`,
      `/pyodide/${VERSION}/`,
      `/pyodide/${VERSION}/pyodide.js`,
      `/pyodide/${VERSION}/pyodide.mjs/`,
      `/pyodide/${VERSION}/pyodide.mjs.map`,
      `/pyodide/${VERSION}/sub/pyodide.mjs`,
      `/pyodide/${VERSION}//pyodide.mjs`,
      `/pyodide/${VERSION}/PYODIDE.MJS`,
      `/pyodide/${VERSION}/pyodide%2Emjs`,
      `/PYODIDE/${VERSION}/pyodide.mjs`,
      '/pyodide/0.26.4/pyodide.mjs',
      '/pyodide/v0.26.4/full/pyodide.js',
      '/pyodide/latest/pyodide.mjs',
      `/pyodide/${VERSION}/constructor`,
      `/pyodide/${VERSION}/__proto__`,
      `/assets/pyodide/${VERSION}/pyodide.mjs`,
      `/x${pyodideRuntimePath('pyodide.mjs')}`,
    ]) {
      expect(pyodideRuntimeFileAt(path), path).toBeNull();
    }
  });

  it('the folder check is a wide net: any case, encoding or slashes a static server might fold onto it', () => {
    for (const path of ['/pyodide', '/pyodide/', '/pyodide/x', `/pyodide/${VERSION}/pyodide.mjs`, '/PYODIDE/x', '/Pyodide', '/%70yodide/x', '/pyodide%2F314/x', '//pyodide/x', '/pyodide//x', '/pyodide\\x', '/pyodide/%E0%A4%A']) {
      expect(isPyodideRuntimePath(path), path).toBe(true);
    }
    for (const path of ['/', '/pyodidex', '/pyodide.js', '/pyodide-lock.json', '/assets/pyodide/x', '/api/pyodide', '/c/pyodide', '/models/pyodide']) {
      expect(isPyodideRuntimePath(path), path).toBe(false);
    }
    expect(PYODIDE_RUNTIME_ROOT).toBe('/pyodide');
  });

  it('the byte check answers as soon as it can: no at the first wrong byte, yes at the last pinned one, "more" in between', () => {
    for (const file of PYODIDE_RUNTIME_FILES) {
      const { starts } = PIN.files[file];
      const real = installed(file);
      expect(looksLikePyodideRuntimeFile(file, new Uint8Array(0)), `${file}: nothing yet`).toBeNull();
      expect(looksLikePyodideRuntimeFile(file, new Uint8Array(0), true), `${file}: nothing at all`).toBe(false);
      for (let n = 1; n < starts.length; n++) expect(looksLikePyodideRuntimeFile(file, real.subarray(0, n)), `${file}: ${n} right bytes`).toBeNull();
      expect(looksLikePyodideRuntimeFile(file, real.subarray(0, starts.length - 1), true), `${file}: ends early`).toBe(false);
      expect(looksLikePyodideRuntimeFile(file, real.subarray(0, starts.length)), `${file}: all of them`).toBe(true);
      expect(looksLikePyodideRuntimeFile(file, real.subarray(0, PYODIDE_FIRST_BYTES)), file).toBe(true);
      // One wrong byte decides at once, wherever it is, without waiting for more.
      for (const at of [0, starts.length - 1]) {
        const wrong = new Uint8Array(real.subarray(0, at + 1));
        wrong[at] ^= 0xff;
        expect(looksLikePyodideRuntimeFile(file, wrong), `${file}: wrong byte ${at}`).toBe(false);
      }
      expect(looksLikePyodideRuntimeFile(file, new TextEncoder().encode('<')), `${file}: a page`).toBe(false);
      expect(pyodideContentType(file)).toBe(PIN.files[file].type);
    }
  });

  it('the first bytes tell the real file from an HTML page, an empty body, or another file under its name', () => {
    const html = new TextEncoder().encode(INDEX_HTML);
    for (const file of PYODIDE_RUNTIME_FILES) {
      const real = installed(file);
      expect(hasPyodideFirstBytes(file, real.subarray(0, PYODIDE_FIRST_BYTES)), file).toBe(true);
      expect(hasPyodideFirstBytes(file, html), `${file}: an HTML page`).toBe(false);
      expect(hasPyodideFirstBytes(file, new Uint8Array(0)), `${file}: empty`).toBe(false);
      expect(hasPyodideFirstBytes(file, real.subarray(0, PIN.files[file].starts.length - 1)), `${file}: cut short`).toBe(false);
      for (const other of PYODIDE_RUNTIME_FILES) {
        if (other !== file) expect(hasPyodideFirstBytes(file, installed(other)), `${other} served as ${file}`).toBe(false);
      }
    }
  });
});

describe('the build stops unless the runtime is the pinned bytes (vite.config.ts pyodideRuntime)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pyodide-pin-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** A project root whose node_modules/pyodide is a copy of the installed one, then changed by `mutate`. */
  const rootWith = (name: string, mutate: (dir: string) => void): string => {
    const root = path.join(tmp, name);
    const dir = path.join(root, 'node_modules/pyodide');
    mkdirSync(dir, { recursive: true });
    for (const f of ['package.json', ...PYODIDE_RUNTIME_FILES]) cpSync(path.join(PKG_DIR, f), path.join(dir, f));
    mutate(dir);
    return root;
  };
  const flipLastByte = (file: string) => (dir: string) => {
    const bytes = readFileSync(path.join(dir, file));
    bytes[bytes.length - 1] ^= 0x01;
    writeFileSync(path.join(dir, file), bytes);
  };
  const entry: Plugin = {
    name: 'fixture-entry',
    resolveId: (id) => (id === 'virtual:pyodide-fixture' ? '\0virtual:pyodide-fixture' : null),
    load: (id) => (id === '\0virtual:pyodide-fixture' ? 'export const ok = 1;\n' : null),
  };
  const viteBuild = (plugins: Plugin[]) =>
    build({ configFile: false, root: APP, logLevel: 'silent', publicDir: false, plugins: [entry, ...plugins], build: { write: false, minify: false, rollupOptions: { input: 'virtual:pyodide-fixture' } } }) as Promise<Rollup.RollupOutput>;

  it('an untouched copy of the installed package passes (control)', () => {
    expect(readPinnedPyodide({ root: rootWith('control', () => {}) }).map((f) => [f.name, sha256(f.source)])).toEqual(PYODIDE_RUNTIME_FILES.map((f) => [f, PIN.files[f].sha256]));
  });

  it('one changed byte in any pinned file stops it, naming the file and both hashes', () => {
    for (const file of PYODIDE_RUNTIME_FILES) {
      const root = rootWith(`flip-${file}`, flipLastByte(file));
      const changed = sha256(readFileSync(path.join(root, 'node_modules/pyodide', file)));
      let message = '';
      try {
        readPinnedPyodide({ root });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, file).toContain('The Python runtime is not the pinned one');
      expect(message, file).toContain(`- ${file}: sha256 ${changed}, pinned ${PIN.files[file].sha256}`);
      expect(message, file).toContain('Nothing was built.');
    }
  });

  it('another version stops it even with every byte unchanged; so do a missing file, a truncated one and no package at all', () => {
    const versioned = rootWith('version', (dir) => {
      const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pj, version: '314.0.1' }));
    });
    expect(() => readPinnedPyodide({ root: versioned })).toThrow(`installed pyodide@314.0.1, pinned ${VERSION}`);

    const missing = rootWith('missing', (dir) => rmSync(path.join(dir, 'python_stdlib.zip')));
    expect(() => readPinnedPyodide({ root: missing })).toThrow(`python_stdlib.zip: missing from pyodide@${VERSION}`);

    const truncated = rootWith('truncated', (dir) => writeFileSync(path.join(dir, 'pyodide.asm.wasm'), readFileSync(path.join(dir, 'pyodide.asm.wasm')).subarray(0, 1024)));
    expect(() => readPinnedPyodide({ root: truncated })).toThrow(`pyodide.asm.wasm: 1024 bytes, pinned ${PIN.files['pyodide.asm.wasm'].bytes}`);

    // An HTML page under the loader's name (what a broken mirror or proxy hands out).
    const html = rootWith('html', (dir) => writeFileSync(path.join(dir, 'pyodide.mjs'), INDEX_HTML));
    expect(() => readPinnedPyodide({ root: html })).toThrow('pyodide.mjs: does not start with the pinned first bytes');

    expect(() => readPinnedPyodide({ root: path.join(tmp, 'nothing-here') })).toThrow(/pyodide is not installed .*run npm ci/);
  });

  it('the failure prints what IS installed, so a reviewed update is a copy into the pin', () => {
    const root = rootWith('print', flipLastByte('pyodide-lock.json'));
    const changed = readFileSync(path.join(root, 'node_modules/pyodide/pyodide-lock.json'));
    let message = '';
    try {
      readPinnedPyodide({ root });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`Installed (pyodide@${VERSION}):`);
    expect(message).toContain(`  pyodide-lock.json: sha256 ${sha256(changed)}, ${changed.length} bytes, starts "{\\"info\\":"`);
    expect(message).toContain(`  pyodide.asm.wasm: sha256 ${PIN.files['pyodide.asm.wasm'].sha256}, ${PIN.files['pyodide.asm.wasm'].bytes} bytes`);
  });

  it('a real Vite build emits exactly the pinned files at /pyodide/<version>/, and the licence gate sees them as browser code', async () => {
    const reportFile = path.join(tmp, 'report.json');
    const out = await viteBuild([pyodideRuntime(), licenceModules({ root: APP, reportFile })]);
    const emitted = out.output.filter((o): o is Rollup.OutputAsset => o.type === 'asset' && o.fileName.startsWith('pyodide/'));
    expect(emitted.map((o) => o.fileName).sort()).toEqual(PYODIDE_RUNTIME_FILES.map((f) => `pyodide/${VERSION}/${f}`).sort());
    for (const o of emitted) {
      const file = path.basename(o.fileName) as PyodideRuntimeFileName;
      expect(sha256(o.source as Uint8Array), o.fileName).toBe(PIN.files[file].sha256);
      // Where each came from: this is what makes licenceModules() count the package.
      expect(o.originalFileNames, o.fileName).toEqual([path.join(PKG_DIR, file)]);
    }
    // The module report (what CI hands to scripts/licence-check.mjs) names pyodide, and the notices list it.
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { packages: { key: string; name: string; version: string; licence: string; modules: number }[] };
    expect(report.packages).toEqual([{ key: 'node_modules/pyodide', name: 'pyodide', version: VERSION, licence: 'MPL-2.0', modules: PYODIDE_RUNTIME_FILES.length }]);
    const notices = String((out.output.find((o) => o.fileName === 'THIRD-PARTY-NOTICES.txt') as Rollup.OutputAsset).source);
    expect(notices).toMatch(new RegExp(`^pyodide@${VERSION.replace(/\./g, '\\.')} — MPL-2\\.0`, 'm'));
    // Judged by the browser rules (MPL-2.0 is on the browser list), with the notices check on.
    const policy = gate.loadPolicy(path.join(APP, 'scripts/licence-policy.json'));
    policy.dataAssets.records = [];
    const g = gate.runGate({
      root: '/nonexistent/pyodide-fixture',
      policy,
      lockfiles: { 'package-lock.json': JSON.parse(app('package-lock.json')) },
      engines: {},
      dataAssetFiles: [],
      vendoredDirs: [],
      htmlPages: [],
      exists: () => true,
      browserModules: { ...report, firstPartyModules: 1 },
      noticesText: notices,
    });
    const judged = g.results.find((r) => r.name === 'pyodide');
    expect([judged?.scope, judged?.status, judged?.effective]).toEqual(['browser', 'ok', 'MPL-2.0']);
    expect(g.failures.filter((r) => r.name === 'pyodide' || r.name === 'THIRD-PARTY-NOTICES.txt')).toEqual([]);
  }, 60_000);

  it('a real Vite build fails, and emits nothing, when one byte of the runtime is not the pinned one', async () => {
    const root = rootWith('build-flip', flipLastByte('pyodide.asm.wasm'));
    await expect(viteBuild([pyodideRuntime({ root })])).rejects.toThrow(/The Python runtime is not the pinned one[\s\S]*pyodide\.asm\.wasm: sha256 [0-9a-f]{64}, pinned/);
  }, 60_000);

  it('the app build uses it, in the main bundle only (worker bundles emit nothing)', () => {
    const config = (viteConfig as unknown as (env: { mode: string; command: string }) => { plugins: { name?: string }[]; worker: { plugins: () => { name?: string }[] } })({ mode: 'production', command: 'build' });
    expect(config.plugins.flat().map((p) => p?.name)).toContain('pyodide-runtime');
    expect(config.worker.plugins().map((p) => p?.name)).not.toContain('pyodide-runtime');
  });
});

describe('vite dev / vite preview serve the folder under the same contract', () => {
  type Reader = (file: PyodideRuntimeFileName) => Buffer | Error | null;
  interface Answer {
    status: number;
    headers: Record<string, string>;
    body: Buffer | string | undefined;
    passed: boolean;
  }
  /** Run a connect middleware on one request and record what it answered (or that it passed the request on). */
  const run = (mw: (req: IncomingMessage, res: ServerResponse, next: () => void) => void, url: string, method = 'GET'): Answer => {
    const out: Answer = { status: 0, headers: {}, body: undefined, passed: false };
    const res = {
      set statusCode(v: number) {
        out.status = v;
      },
      setHeader: (name: string, value: string) => {
        out.headers[name.toLowerCase()] = value;
      },
      end: (body?: Buffer | string) => {
        out.body = body;
      },
    } as unknown as ServerResponse;
    mw({ url, method } as IncomingMessage, res, () => {
      out.passed = true;
    });
    return out;
  };
  const call = (read: Reader, url: string, method = 'GET') => run(pyodideRuntimeMiddleware(read), url, method);
  const fromPackage: Reader = (file) => installed(file);
  /** The middleware a plugin hook registers, with the plugin resolved for `root` / `outDir`. */
  const hooked = (hook: 'configureServer' | 'configurePreviewServer', opts: { root: string; outDir: string; pluginRoot?: string }) => {
    const plugin = pyodideRuntime({ root: opts.pluginRoot ?? APP });
    const errors: string[] = [];
    (plugin.configResolved as (c: unknown) => void)({ command: 'serve', root: opts.root, base: '/', build: { outDir: opts.outDir }, logger: { error: (m: string) => errors.push(m) } });
    let mw: Parameters<typeof run>[0] | null = null;
    (plugin[hook] as (s: unknown) => void)({ middlewares: { use: (fn: typeof mw) => (mw = fn) } });
    return { get: (url: string, method = 'GET') => run(mw!, url, method), errors };
  };
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pyodide-serve-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('a pinned file: 200, its content type, immutable, our origin only (no CORS grant)', () => {
    for (const file of PYODIDE_RUNTIME_FILES) {
      const res = call(fromPackage, `${pyodideRuntimePath(file)}?t=1`);
      expect(res.status, file).toBe(200);
      expect(res.headers).toEqual({
        'content-type': PIN.files[file].type,
        'cache-control': PYODIDE_RUNTIME_CACHE_CONTROL,
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
        'content-length': String(PIN.files[file].bytes),
      });
      expect(sha256(res.body as Buffer), file).toBe(PIN.files[file].sha256);
      expect(res.passed).toBe(false);
    }
    const head = call(fromPackage, pyodideRuntimePath('pyodide.asm.wasm'), 'HEAD');
    expect([head.status, head.body, head.headers['content-length']]).toEqual([200, undefined, String(PIN.files['pyodide.asm.wasm'].bytes)]);
  });

  it('anything else under the folder is a 404 here too — never passed on to the SPA fallback', () => {
    for (const url of ['/pyodide', '/pyodide/', `/pyodide/${VERSION}/pyodide.js`, '/pyodide/0.26.4/pyodide.mjs', `/PYODIDE/${VERSION}/pyodide.mjs`, `/pyodide/${VERSION}/numpy.whl`]) {
      const res = call(fromPackage, url);
      expect([res.status, res.headers['content-type'], res.headers['cache-control'], res.body, res.passed], url).toEqual([404, 'text/plain; charset=utf-8', 'no-store', 'Not found', false]);
    }
    // A pinned file the folder does not hold.
    expect(call(() => null, pyodideRuntimePath('pyodide.mjs')).status).toBe(404);
  });

  it('a file whose bytes are not the pinned ones is never served: a 500 that carries none of them', () => {
    for (const read of [() => new Error('integrity check failed'), () => Buffer.from(INDEX_HTML), () => Buffer.from('export default 666;')] as Reader[]) {
      const res = call(read, pyodideRuntimePath('pyodide.mjs'));
      expect([res.status, res.headers['content-type'], res.headers['cache-control']]).toEqual([500, 'text/plain; charset=utf-8', 'no-store']);
      expect(String(res.body)).toBe('The Python runtime failed its integrity check and was not served. See the server log.');
    }
  });

  it('every other path goes on to Vite untouched', () => {
    for (const url of ['/', '/index.html', '/assets/pyRunner.worker-abc.js', '/qa/comic-qa.html?surface=kit&kit=python', '/pyodide.js', `/ort/${VERSION}/pyodide.mjs`]) {
      const res = call(fromPackage, url);
      expect([res.passed, res.status], url).toEqual([true, 0]);
    }
  });

  it('dev serves the files straight from the package, and none of them once one byte is not pinned', () => {
    const dev = hooked('configureServer', { root: APP, outDir: 'dist' });
    for (const file of PYODIDE_RUNTIME_FILES) {
      const res = dev.get(pyodideRuntimePath(file));
      expect(res.status, file).toBe(200);
      expect(sha256(res.body as Buffer), file).toBe(PIN.files[file].sha256);
    }
    expect(dev.errors).toEqual([]);

    const root = path.join(tmp, 'dev-flip');
    const dir = path.join(root, 'node_modules/pyodide');
    mkdirSync(dir, { recursive: true });
    for (const f of ['package.json', ...PYODIDE_RUNTIME_FILES]) cpSync(path.join(PKG_DIR, f), path.join(dir, f));
    writeFileSync(path.join(dir, 'pyodide.mjs'), 'export const loadPyodide = () => 666;');
    const bad = hooked('configureServer', { root, outDir: 'dist', pluginRoot: root });
    for (const file of PYODIDE_RUNTIME_FILES) {
      const res = bad.get(pyodideRuntimePath(file));
      expect(res.status, file).toBe(500);
      expect(String(res.body), file).not.toContain('666');
    }
    // Said once, in the server log, with what to do.
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]).toContain('The Python runtime is not the pinned one');
    expect(bad.get('/pyodide/0.26.4/pyodide.mjs').status, 'an unpinned path is still a 404').toBe(404);
  });

  it('preview serves the built files, each held to its pinned hash; a missing one is a 404, a changed one a 500', () => {
    const out = path.join(tmp, 'preview');
    const folder = path.join(out, 'pyodide', VERSION);
    mkdirSync(folder, { recursive: true });
    cpSync(path.join(PKG_DIR, 'pyodide-lock.json'), path.join(folder, 'pyodide-lock.json'));
    writeFileSync(path.join(folder, 'pyodide.mjs'), 'export default 1;');
    const preview = hooked('configurePreviewServer', { root: tmp, outDir: 'preview' });
    const ok = preview.get(pyodideRuntimePath('pyodide-lock.json'));
    expect([ok.status, ok.headers['content-type'], ok.headers['cache-control'], ok.headers['access-control-allow-origin']]).toEqual([200, PIN.files['pyodide-lock.json'].type, PYODIDE_RUNTIME_CACHE_CONTROL, undefined]);
    expect(sha256(ok.body as Buffer)).toBe(PIN.files['pyodide-lock.json'].sha256);
    const tampered = preview.get(pyodideRuntimePath('pyodide.mjs'));
    expect(tampered.status, 'a file that is not the pinned runtime is never served').toBe(500);
    expect(String(tampered.body)).not.toContain('export default 1;');
    expect(preview.errors.join('\n')).toContain('integrity check failed');
    const missing = preview.get(pyodideRuntimePath('pyodide.asm.wasm'));
    expect([missing.status, missing.headers['content-type']]).toEqual([404, 'text/plain; charset=utf-8']);
    expect(preview.get('/pyodide/0.26.4/pyodide.mjs').status).toBe(404);
    expect(preview.get('/index.html').passed, 'other paths are passed on').toBe(true);
  });
});

describe('production: /pyodide/* goes through the middleware, never the SPA fallback (servePyodideRuntime)', () => {
  const handler = createOnRequest({ streamHostOn: false });
  const go = (url: string, next: () => Promise<Response>, init: { ua?: string; headers?: Record<string, string>; method?: string } = {}) =>
    handler({ request: new Request(url, { method: init.method ?? 'GET', headers: { 'user-agent': init.ua ?? HUMAN, ...(init.headers ?? {}) } }), next, env: {} as never });
  const fileUrl = (file: PyodideRuntimeFileName, origin = 'https://dreamstreamstudio.ai') => `${origin}${pyodideRuntimePath(file)}`;
  const REAL = (file: PyodideRuntimeFileName) => new Uint8Array(installed(file));
  /**
   * What the Pages asset server answers for a real file (seen with `wrangler pages dev`): its own content type (the
   * .mjs as application/javascript), an ETag, revalidate-every-time caching, and the CORS grant it adds to every asset.
   */
  const assetHeaders = (file: string): Record<string, string> => ({
    'content-type': file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.mjs') ? 'application/javascript' : file.endsWith('.json') ? 'application/json' : 'application/zip',
    'cache-control': 'public, max-age=0, must-revalidate',
    etag: '"a"',
    'access-control-allow-origin': '*',
  });
  const fileFromAssets = (file: PyodideRuntimeFileName, init: { status?: number; headers?: Record<string, string>; body?: string | Uint8Array | null } = {}) =>
    vi.fn(async () => new Response(init.body === undefined ? REAL(file) : init.body, { status: init.status ?? 200, headers: { ...assetHeaders(file), ...(init.headers ?? {}) } }));
  /** What the Pages asset server answers for a path with NO file: the SPA's index.html with a 200 (`extra`: what a _headers rule might add). */
  const spaFallback = (extra: Record<string, string> = {}) =>
    vi.fn(async () => new Response(INDEX_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate', etag: '"index"', 'access-control-allow-origin': '*', ...extra } }));
  const bodyHash = async (res: Response) => sha256(new Uint8Array(await res.arrayBuffer()));
  const expectNotFound = async (res: Response, what: string) => {
    const body = await res.text();
    expect({ status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), html: /<!doctype html|<html/i.test(body) }, what).toEqual({
      status: 404,
      type: 'text/plain; charset=utf-8',
      cache: 'no-store',
      html: false,
    });
  };

  it('serves each pinned file, whole, with its content type, immutable caching and nosniff', async () => {
    for (const file of PYODIDE_RUNTIME_FILES) {
      const next = fileFromAssets(file);
      const res = await go(fileUrl(file), next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status, file).toBe(200);
      expect(res.headers.get('content-type'), file).toBe(PIN.files[file].type);
      expect(res.headers.get('cache-control'), file).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('cross-origin-resource-policy'), file).toBe('same-origin');
      expect(res.headers.get('x-content-type-options'), file).toBe('nosniff');
      expect(res.headers.get('strict-transport-security'), file).toMatch(/max-age=63072000/);
      expect(res.headers.get('etag'), 'the validator is kept').toBe('"a"');
      // A file, not a page: no page CSP, no page Permissions-Policy.
      for (const name of ['content-security-policy', 'content-security-policy-report-only', 'permissions-policy']) expect(res.headers.get(name), `${file} ${name}`).toBeNull();
      // Looking at the first bytes does not eat them: the browser gets the whole file (9.6 MB for the WebAssembly module).
      expect(await bodyHash(res), file).toBe(PIN.files[file].sha256);
    }
  });

  it('goes out to our own origin only: no CORS grant from the asset server is passed on', async () => {
    for (const file of PYODIDE_RUNTIME_FILES) {
      const next = fileFromAssets(file, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'access-control-expose-headers': 'etag', 'access-control-allow-credentials': 'true' } });
      const res = await go(fileUrl(file), next, { headers: { origin: 'https://elsewhere.example' } });
      expect(res.status, file).toBe(200);
      expect([...res.headers.keys()].filter((k) => k.startsWith('access-control-')), `${file}: no other site may import or fetch the runtime through CORS`).toEqual([]);
      void res.body?.cancel();
    }
    const revalidated = await go(fileUrl('pyodide.mjs'), fileFromAssets('pyodide.mjs', { status: 304, body: null }), { headers: { 'if-none-match': '"a"' } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('access-control-allow-origin')).toBeNull();
    expect(revalidated.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('only the pinned files reach the asset server: anything else under the folder is a 404 without asking it', async () => {
    for (const p of [
      '/pyodide',
      '/pyodide/',
      `/pyodide/${VERSION}`,
      `/pyodide/${VERSION}/`,
      `/pyodide/${VERSION}/pyodide.js`,
      `/pyodide/${VERSION}/pyodide.mjs.map`,
      `/pyodide/${VERSION}/index.html`,
      // One of Pyodide's optional packages (the lock file names them; none is shipped).
      `/pyodide/${VERSION}/numpy-2.4.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl`,
      `/pyodide/${VERSION}/sub/pyodide.mjs`,
      `/pyodide/${VERSION}/pyodide.mjs/`,
      // An old tab after a deploy that moved to a new Pyodide, and the CDN's own layout.
      '/pyodide/0.26.4/pyodide.mjs',
      '/pyodide/v0.26.4/full/pyodide.js',
      '/pyodide/latest/pyodide.asm.wasm',
      `/pyodide/${VERSION}-next/pyodide.mjs`,
      // Whatever a static server might fold onto the folder.
      `/PYODIDE/${VERSION}/pyodide.mjs`,
      `/Pyodide/${VERSION}/pyodide.mjs`,
      `/%70yodide/${VERSION}/pyodide.mjs`,
      `/pyodide/${VERSION}/pyodide%2Emjs`,
      `//pyodide/${VERSION}/pyodide.mjs`,
    ]) {
      const next = spaFallback();
      await expectNotFound(await go(`https://dreamstreamstudio.ai${p}`, next), p);
      expect(next, p).not.toHaveBeenCalled();
    }
  });

  it("a missing file (the asset server's SPA answer: index.html with a 200) is a plain 404 that nothing keeps", async () => {
    for (const file of PYODIDE_RUNTIME_FILES) {
      const next = spaFallback();
      await expectNotFound(await go(fileUrl(file), next), file);
      expect(next).toHaveBeenCalledTimes(1);
    }
    // Any other non-file answer too (a redirect, an error).
    for (const status of [301, 308, 404, 405, 500]) {
      const r = await go(fileUrl('pyodide.mjs'), async () => new Response(null, { status, headers: status < 400 ? { location: '/' } : {} }));
      expect(r.status, String(status)).toBe(404);
    }
  });

  it('index.html is never the runtime, however the asset server labels it; nor is any other file under a pinned name', async () => {
    for (const file of PYODIDE_RUNTIME_FILES) {
      // A _headers rule can relabel the fallback page as the very type we would send.
      await expectNotFound(await go(fileUrl(file), spaFallback({ 'content-type': PIN.files[file].type, 'cache-control': PYODIDE_RUNTIME_CACHE_CONTROL })), `${file} labelled ${PIN.files[file].type}`);
      await expectNotFound(await go(fileUrl(file), spaFallback({ 'content-type': 'application/octet-stream' })), `${file} labelled application/octet-stream`);
      await expectNotFound(await go(fileUrl(file), fileFromAssets(file, { body: '' })), `${file}: empty`);
      await expectNotFound(await go(fileUrl(file), fileFromAssets(file, { body: REAL(file).subarray(0, PIN.files[file].starts.length - 1) })), `${file}: cut short`);
      // Another pinned file under this one's name.
      for (const other of PYODIDE_RUNTIME_FILES) {
        if (other !== file) await expectNotFound(await go(fileUrl(file), fileFromAssets(file, { body: REAL(other).subarray(0, 4096) })), `${other} served as ${file}`);
      }
    }
    // Stricter than "not a page": a module that is not the pinned loader, JSON that is not the lock file.
    await expectNotFound(await go(fileUrl('pyodide.mjs'), fileFromAssets('pyodide.mjs', { body: 'export const loadPyodide = () => 666;' })), 'another module as the loader');
    await expectNotFound(await go(fileUrl('pyodide-lock.json'), fileFromAssets('pyodide-lock.json', { body: '{"error":"gone"}' })), 'other JSON as the lock file');
    await expectNotFound(await go(fileUrl('pyodide.mjs'), fileFromAssets('pyodide.mjs', { body: `﻿ \n<!doctype html><html></html>` })), 'html after a byte-order mark');
  });

  it('a file split into tiny network chunks is still recognised and still arrives whole', async () => {
    for (const file of ['pyodide.mjs', 'pyodide.asm.wasm'] as const) {
      // One byte at a time for the first kilobyte (the first bytes span many chunks), then the rest.
      const whole = REAL(file);
      const dribble = () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const b of whole.subarray(0, 1024)) c.enqueue(new Uint8Array([b]));
            c.enqueue(whole.subarray(1024));
            c.close();
          },
        });
      const res = await go(fileUrl(file), async () => new Response(dribble(), { headers: assetHeaders(file) }));
      expect(res.status, file).toBe(200);
      expect(await bodyHash(res), file).toBe(PIN.files[file].sha256);
    }
  });

  it('answers that carry no readable start of the file (HEAD, a later byte range, a compressed body) pass on the asset server’s word, never as HTML', async () => {
    const head = await go(fileUrl('pyodide.asm.wasm'), fileFromAssets('pyodide.asm.wasm', { body: null }), { method: 'HEAD' });
    expect([head.status, head.headers.get('content-type'), head.headers.get('cache-control')]).toEqual([200, 'application/wasm', 'public, max-age=31536000, immutable']);
    const htmlHead = await go(fileUrl('pyodide.asm.wasm'), async () => new Response(null, { headers: { 'content-type': 'text/html; charset=utf-8' } }), { method: 'HEAD' });
    expect(htmlHead.status).toBe(404);
    // A resumed download: bytes from the middle of the real file.
    const tail = await go(fileUrl('python_stdlib.zip'), fileFromAssets('python_stdlib.zip', { status: 206, body: new Uint8Array([9, 9, 9, 9]), headers: { 'content-range': 'bytes 4-7/8' } }), { headers: { range: 'bytes=4-' } });
    expect([tail.status, tail.headers.get('content-range'), tail.headers.get('content-type')]).toEqual([206, 'bytes 4-7/8', 'application/zip']);
    // A range from byte 0 does carry the start, so it is checked like a whole file.
    const badStart = await go(fileUrl('python_stdlib.zip'), fileFromAssets('python_stdlib.zip', { status: 206, body: '<!DO', headers: { 'content-range': 'bytes 0-3/1024' } }), { headers: { range: 'bytes=0-3' } });
    expect(badStart.status).toBe(404);
    const goodStart = await go(fileUrl('python_stdlib.zip'), fileFromAssets('python_stdlib.zip', { status: 206, body: REAL('python_stdlib.zip').subarray(0, 64), headers: { 'content-range': `bytes 0-63/${PIN.files['python_stdlib.zip'].bytes}` } }), { headers: { range: 'bytes=0-63' } });
    expect(goodStart.status).toBe(206);
    // Compressed bytes say nothing about the file's own: the status and the label decide, and an HTML label still loses.
    const gz = await go(fileUrl('pyodide.asm.mjs'), fileFromAssets('pyodide.asm.mjs', { body: new Uint8Array([0x1f, 0x8b, 8, 0]), headers: { 'content-encoding': 'gzip' } }));
    expect([gz.status, gz.headers.get('content-encoding')]).toEqual([200, 'gzip']);
    const gzHtml = await go(fileUrl('pyodide.asm.mjs'), async () => new Response(new Uint8Array([0x1f, 0x8b, 8, 0]), { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } }));
    expect(gzHtml.status).toBe(404);
  });

  it('is files, not a page: an automated browser or an AI agent gets the file like /assets/* (no check-in), and the 404 for anything else', async () => {
    for (const ua of ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36', 'Mozilla/5.0 (compatible; GPTBot/1.2)']) {
      const res = await go(fileUrl('pyodide.mjs'), fileFromAssets('pyodide.mjs'), { ua });
      expect(res.status, ua).toBe(200);
      expect(res.headers.get('location'), ua).toBeNull();
      await expectNotFound(await go('https://dreamstreamstudio.ai/pyodide/0.26.4/pyodide.js', spaFallback(), { ua }), ua);
    }
  });

  it('every host that serves the app serves it; the hosts that only redirect still only redirect', async () => {
    const hosts: [string, Record<string, string>][] = [
      ['https://dreamstreamstudio.ai', {}],
      ['https://stream.dreamstreamstudio.ai', {}],
      ['https://abc123.comic2.pages.dev', {}],
      // The Comic Studio front door proxies to the Pages alias with its own host forwarded.
      ['https://comic2.pages.dev', { 'x-forwarded-host': 'comics.dreamstreamstudio.ai' }],
      ['http://localhost:8788', {}],
    ];
    for (const [origin, headers] of hosts) {
      const res = await go(fileUrl('pyodide-lock.json', origin), fileFromAssets('pyodide-lock.json'), { headers });
      expect(res.status, origin).toBe(200);
      expect(await bodyHash(res), origin).toBe(PIN.files['pyodide-lock.json'].sha256);
      const next = spaFallback();
      await expectNotFound(await go(`${origin}/pyodide/${VERSION}/nope.mjs`, next, { headers }), `${origin} missing`);
      expect(next).not.toHaveBeenCalled();
    }
    // The stream host serves live.html for every PAGE; a runtime path there is never that page.
    await expectNotFound(await go('https://stream.dreamstreamstudio.ai/pyodide/', spaFallback()), 'stream host folder');
    const next = fileFromAssets('pyodide.mjs');
    const www = await go(fileUrl('pyodide.mjs', 'https://www.dreamstreamstudio.ai'), next);
    expect([www.status, www.headers.get('location')]).toEqual([301, fileUrl('pyodide.mjs')]);
    expect(next).not.toHaveBeenCalled();
  });

  it('is served by the same code, with the same caching and resource policy, as the voice engine', async () => {
    expect(PYODIDE_RUNTIME_CACHE_CONTROL).toBe(ORT_CACHE_CONTROL);
    expect(PYODIDE_RUNTIME_RESOURCE_POLICY).toBe(ORT_RESOURCE_POLICY);
    const source = app('functions/_middleware.ts');
    // Both folders end in the one checked passthrough; neither serves a response on its own.
    expect(source.match(/return serveCheckedRuntimeFile\(next, \{/g)).toHaveLength(2);
    expect(source).toMatch(/if \(isOrtRuntimePath\(url\.pathname\)\) return secured\(serveOrtRuntime\(url, next\)\);\s*\n\s*\/\/[^\n]*\n\s*if \(isPyodideRuntimePath\(url\.pathname\)\) return secured\(servePyodideRuntime\(url, next\)\);/);
    // The voice engine still answers (its own suite, tests/edge/voiceRuntime.test.ts, holds the rest).
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const ort = await go(`https://dreamstreamstudio.ai/ort/${ORT_RUNTIME_PIN.version}/ort-wasm-simd-threaded.wasm`, async () => new Response(wasm, { headers: { 'content-type': 'application/wasm', 'access-control-allow-origin': '*' } }));
    expect([ort.status, ort.headers.get('content-type'), ort.headers.get('cache-control'), ort.headers.get('access-control-allow-origin')]).toEqual([200, 'application/wasm', ORT_CACHE_CONTROL, null]);
    // A Python file name under the voice folder, or the other way round, is neither.
    await expectNotFound(await go(`https://dreamstreamstudio.ai/ort/${ORT_RUNTIME_PIN.version}/pyodide.asm.wasm`, spaFallback()), 'pyodide file under /ort');
    await expectNotFound(await go(`https://dreamstreamstudio.ai/pyodide/${VERSION}/ort-wasm-simd-threaded.wasm`, spaFallback()), 'ort file under /pyodide');
  });

  it('pages are untouched: the app still gets its page, its headers and its gate', async () => {
    const next = vi.fn(async () => new Response(INDEX_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const page = await go('https://dreamstreamstudio.ai/', next);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(INDEX_HTML);
    expect(page.headers.get('content-security-policy-report-only')).toContain("default-src 'self'");
    expect(next).toHaveBeenCalledTimes(1);
    const agent = await go('https://dreamstreamstudio.ai/', next, { ua: 'Mozilla/5.0 (compatible; GPTBot/1.2)' });
    expect(agent.status).toBe(302);
  });
});

describe('public/_routes.json and public/_headers leave the folder to the Function', () => {
  /** _headers as rule blocks: a path pattern, then its indented `Name: value` lines. */
  const headerRules = (text: string) => {
    const rules: { pattern: string; headers: string[] }[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      if (/^\s/.test(line)) rules[rules.length - 1]?.headers.push(line.trim());
      else rules.push({ pattern: line.trim(), headers: [] });
    }
    return rules;
  };
  /** Does a _headers / _routes pattern (`*` splat, `:name` placeholder) match this path? */
  const matches = (pattern: string, pathname: string) => {
    const p = pattern.replace(/^https?:\/\/[^/]+/i, '');
    const re = p.split(/(\*|:[A-Za-z]\w*)/).map((part) => (part === '*' ? '.*' : part.startsWith(':') ? '[^/]+' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('');
    return new RegExp(`^${re}$`).test(pathname);
  };
  const SAMPLE = [pyodideRuntimePath('pyodide.mjs'), pyodideRuntimePath('pyodide.asm.wasm'), '/pyodide/', '/pyodide/0.26.4/pyodide.js'];

  it('_routes.json sends /pyodide/* through the Function (an exclude would hand the folder to the asset server, fallback and all)', () => {
    const routes = JSON.parse(app('public/_routes.json')) as { include: string[]; exclude: string[] };
    expect(routes.include).toContain('/*');
    for (const pathname of SAMPLE) expect(routes.exclude.filter((pattern) => matches(pattern, pathname)), pathname).toEqual([]);
    expect(routes.exclude.filter((pattern) => /pyodide/i.test(pattern))).toEqual([]);
    // The worker itself is a hashed build file and stays static.
    expect(routes.exclude).toContain('/assets/*');
  });

  it('_headers has no rule for the folder, and no rule that reaches it sets a content type, caching or a CORS grant', () => {
    const rules = headerRules(app('public/_headers'));
    expect(rules.length).toBeGreaterThan(3);
    expect(rules.filter((r) => /pyodide/i.test(r.pattern)).map((r) => r.pattern)).toEqual([]);
    const reaching = rules.filter((r) => SAMPLE.some((pathname) => matches(r.pattern, pathname)));
    // Only the site-wide baseline reaches it (Pages applies _headers to its index.html fallback too: a
    // Cache-Control here would make a missing runtime file an "immutable" HTML page).
    expect(reaching.map((r) => r.pattern)).toEqual(['/*']);
    for (const rule of reaching) {
      expect(rule.headers.filter((h) => /^(content-type|cache-control|access-control-[a-z-]+|content-security-policy[a-z-]*)\s*:/i.test(h)), rule.pattern).toEqual([]);
    }
  });

  it('_redirects has only the SPA fallback for it: the very rule that makes a missing file come back as index.html', () => {
    const rules = app('public/_redirects').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/));
    expect(rules.filter(([from, to]) => /pyodide/i.test(`${from} ${to}`))).toEqual([]);
    // This is why servePyodideRuntime checks the first bytes: the asset server answers ANY missing path with the app, status 200.
    expect(rules).toContainEqual(['/*', '/index.html', '200']);
  });

  it('the parser reads real rules (a rule for the folder would be caught)', () => {
    const rules = headerRules('# c\n/*\n  X-A: 1\n\n/pyodide/*\n  Cache-Control: public, max-age=31536000, immutable\n  Content-Type: application/wasm\n/models/*\n  Access-Control-Allow-Origin: *\n');
    expect(rules).toEqual([
      { pattern: '/*', headers: ['X-A: 1'] },
      { pattern: '/pyodide/*', headers: ['Cache-Control: public, max-age=31536000, immutable', 'Content-Type: application/wasm'] },
      { pattern: '/models/*', headers: ['Access-Control-Allow-Origin: *'] },
    ]);
    expect(matches('/pyodide/*', pyodideRuntimePath('pyodide.mjs'))).toBe(true);
    expect(matches('/*', '/pyodide/')).toBe(true);
    expect(matches('/models/*', pyodideRuntimePath('pyodide.mjs'))).toBe(false);
    expect(matches('/assets/*', '/assets/pyRunner.worker-abc.js')).toBe(true);
  });
});

describe('the runner: a same-origin module worker with no other origin in it', () => {
  const runner = code(app('services/pyRunner.ts'));
  const worker = code(app('services/pyRunner.worker.ts'));

  it('neither file names another origin, imports a script by URL, or builds a worker from a blob', () => {
    for (const [name, source] of [['services/pyRunner.ts', runner], ['services/pyRunner.worker.ts', worker], ['services/pyodideRuntime.ts', code(app('services/pyodideRuntime.ts'))]] as const) {
      expect(source, name).not.toMatch(/https?:\/\//);
      expect(source, name).not.toMatch(/\bimportScripts\b/);
      expect(source, name).not.toMatch(/createObjectURL|new Blob\b/);
      expect(source, name).not.toMatch(/jsdelivr|unpkg|cdnjs|esm\.sh|skypack/i);
    }
  });

  it('the page starts the worker from its own file, as a module', () => {
    expect(runner).toMatch(/new Worker\(new URL\('\.\/pyRunner\.worker\.ts', import\.meta\.url\), \{ type: 'module' \}\)/);
  });

  it('the worker imports the pinned loader and spells out every URL Pyodide would otherwise default', () => {
    expect(worker).toMatch(/const loaderUrl = here\(pyodideRuntimePath\('pyodide\.mjs'\)\);/);
    expect(worker).toMatch(/await import\(\s*loaderUrl\)/);
    expect(worker).toMatch(/indexURL: base,/);
    expect(worker).toMatch(/lockFileURL: here\(pyodideRuntimePath\('pyodide-lock\.json'\)\),/);
    expect(worker).toMatch(/stdLibURL: here\(pyodideRuntimePath\('python_stdlib\.zip'\)\),/);
    // Without this the loader's package host defaults to a public CDN (the one origin pyodide.mjs names).
    expect(worker).toMatch(/packageBaseUrl: base,/);
    expect(worker).toMatch(/const base = here\(PYODIDE_RUNTIME_BASE\);/);
    // The loader module is never bundled into our code: only its types are imported.
    expect(app('services/pyRunner.worker.ts')).not.toMatch(/^import (?!type\b)[^;]*from 'pyodide'/m);
    expect(worker).toMatch(/py\.version !== PYODIDE_RUNTIME_PIN\.version/);
  });

  it('no client code loads Pyodide from anywhere else', () => {
    const roots = ['components', 'services', 'hooks', 'lib', 'contexts', 'live', 'shared', 'qa', 'App.tsx', 'index.tsx', 'index.html', 'live.html'];
    const offenders: string[] = [];
    const walk = (rel: string) => {
      const abs = path.join(APP, rel);
      if (!existsSync(abs)) return;
      if (statSync(abs).isDirectory()) {
        for (const name of readdirSync(abs)) if (name !== 'node_modules') walk(path.join(rel, name));
      } else if (/\.(?:[cm]?[jt]sx?|html)$/.test(rel) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) {
        const text = code(readFileSync(abs, 'utf8'));
        if (PYODIDE_ELSEWHERE.test(text) || (/\bloadPyodide\b/.test(text) && !/pyRunner\.worker\.ts$/.test(rel))) offenders.push(rel.split(path.sep).join('/'));
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
    // The pattern catches the old loader and its lookalikes, and lets a plain link to the project through.
    for (const bad of ["importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js')", 'const CDN = `https://cdn.jsdelivr.net/pyodide/${V}/full/`', '"https://unpkg.com/pyodide@314.0.0/pyodide.mjs"', "'http://example.test/static/Pyodide/pyodide.asm.wasm'"]) expect(PYODIDE_ELSEWHERE.test(bad), bad).toBe(true);
    for (const fine of ['docsUrl: "https://pyodide.org"', "'/pyodide/314.0.0/pyodide.mjs'", 'new URL(pyodideRuntimePath(file), location.href)']) expect(PYODIDE_ELSEWHERE.test(fine), fine).toBe(false);
  });
});

describe('what the page’s CSP needs for it: nothing new', () => {
  const policies = [
    { name: 'main app, Report-Only (functions/_middleware.ts mainCsp)', policy: parsePolicy(mainCsp({ origin: 'https://dreamstreamstudio.ai' })), self: 'https://dreamstreamstudio.ai/' },
    { name: 'shared comic, enforced (functions/_shared/csp.ts buildCsp)', policy: parsePolicy(buildCsp({ hashes: { scripts: [], handlers: [] }, supabaseOrigin: 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co', embed: false })), self: 'https://comics.dreamstreamstudio.ai/c/Ab3dEf6hIj9kLm2nP' },
  ];

  it("worker-src 'self' already covers the worker file; the old CDN was never allowed and is not added", () => {
    for (const { name, policy, self } of policies) {
      const origin = new URL(self).origin;
      expect(allowsUrl(policy, 'worker-src', `${origin}/assets/pyRunner.worker-CPcfI-V9.js`, self), `${name}: the worker`).toBe(true);
      // A file worker takes its own policy from its response (none on /assets/*), so these are for a page that
      // one day sets one there: the runtime's scripts and fetches are same-origin.
      for (const file of PYODIDE_RUNTIME_FILES) {
        const directive = /\.mjs$/.test(file) ? 'script-src-elem' : 'connect-src';
        expect(allowsUrl(policy, directive, `${origin}${pyodideRuntimePath(file)}`, self), `${name}: ${file}`).toBe(true);
      }
      for (const directive of ['script-src', 'script-src-elem', 'worker-src', 'connect-src']) {
        expect(allowsUrl(policy, directive, 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js', self), `${name}: ${directive} jsDelivr`).toBe(false);
      }
    }
  });
});

const BUILT = existsSync(path.join(DIST, 'index.html'));
if (!BUILT) console.warn('[pyodideRuntime] dist/index.html not found — run `npm run build` first; the built-site checks are skipped.');

describe.skipIf(!BUILT)('the built site (dist/)', () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

  it('carries exactly the pinned files under pyodide/<version>/, byte for byte', () => {
    const files = walk(path.join(DIST, 'pyodide')).map((f) => path.relative(DIST, f).split(path.sep).join('/')).sort();
    expect(files).toEqual(PYODIDE_RUNTIME_FILES.map((f) => `pyodide/${VERSION}/${f}`).sort());
    for (const file of PYODIDE_RUNTIME_FILES) expect(sha256(readFileSync(path.join(DIST, 'pyodide', VERSION, file))), file).toBe(PIN.files[file].sha256);
  });

  it('builds the worker to one same-origin file that names the pinned folder and no other origin', () => {
    const workers = readdirSync(path.join(DIST, 'assets')).filter((f) => /^pyRunner\.worker-[\w-]+\.js$/.test(f));
    expect(workers).toHaveLength(1);
    const text = readFileSync(path.join(DIST, 'assets', workers[0]), 'utf8');
    expect(text).toContain('"/pyodide"');
    expect(text).toContain(`version:"${VERSION}"`);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/importScripts/);
    // The chunk that starts it points at that file.
    const starters = readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.js') && readFileSync(path.join(DIST, 'assets', f), 'utf8').includes(workers[0]));
    expect(starters.length).toBeGreaterThan(0);
  });

  it('no built script or page outside the pinned folder points at a Pyodide runtime on another host', () => {
    const offenders = walk(DIST)
      .filter((f) => /\.(m?js|html)$/.test(f) && !f.startsWith(path.join(DIST, 'pyodide') + path.sep))
      .filter((f) => PYODIDE_ELSEWHERE.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(DIST, f));
    expect(offenders).toEqual([]);
  });

  it('lists pyodide in THIRD-PARTY-NOTICES.txt', () => {
    expect(readFileSync(path.join(DIST, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toMatch(new RegExp(`^pyodide@${VERSION.replace(/\./g, '\\.')} — MPL-2\\.0`, 'm'));
  });

  it('served through the real Function: each pinned file arrives whole; a path the build did not produce is a 404, not index.html', async () => {
    const index = readFileSync(path.join(DIST, 'index.html'));
    /** dist/ as Pages serves it: the file, or index.html for a path that has none. */
    const assets = {
      fetch: async (input: Request | string | URL) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        const file = path.join(DIST, pathname);
        const found = file.startsWith(DIST + path.sep) && existsSync(file) && statSync(file).isFile();
        return new Response(found ? readFileSync(file) : index, { status: 200, headers: { 'content-type': found ? 'application/octet-stream' : 'text/html; charset=utf-8', 'access-control-allow-origin': '*' } });
      },
    };
    const handler = createOnRequest({ streamHostOn: true });
    const get = (pathname: string) => handler({ request: new Request(`https://dreamstreamstudio.ai${pathname}`, { headers: { 'user-agent': HUMAN } }), next: () => assets.fetch(`https://dreamstreamstudio.ai${pathname}`), env: {} as never });
    for (const file of PYODIDE_RUNTIME_FILES) {
      const res = await get(pyodideRuntimePath(file));
      expect(res.status, file).toBe(200);
      expect(res.headers.get('content-type'), file).toBe(PIN.files[file].type);
      expect(res.headers.get('cache-control'), file).toBe(PYODIDE_RUNTIME_CACHE_CONTROL);
      expect(res.headers.get('access-control-allow-origin'), file).toBeNull();
      expect(sha256(new Uint8Array(await res.arrayBuffer())), file).toBe(PIN.files[file].sha256);
    }
    for (const pathname of [`/pyodide/${VERSION}/pyodide.js`, '/pyodide/0.26.4/pyodide.asm.wasm', '/pyodide/']) {
      const res = await get(pathname);
      expect(res.status, pathname).toBe(404);
      expect(await res.text(), pathname).toBe('Not found');
    }
  });
});
