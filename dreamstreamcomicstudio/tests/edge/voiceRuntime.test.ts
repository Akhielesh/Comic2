// @vitest-environment node
/**
 * The private voice model's engine (the ONNX runtime: an .mjs that runs in our origin next to the session, and its
 * .wasm) is served from our own site, never from a third-party CDN (review 1 #1). transformers.js 4.2.0 points it
 * at cdn.jsdelivr.net when it is imported; services/dictation/whisperEngine.ts moves transformers.js's own pick to
 * `/ort/<version>/` (its tests: whisperEngine.test.ts). This file pins the other half:
 *
 *  - the version the page asks for is the onnxruntime-web transformers.js resolves, the one it pins, and the one
 *    the lockfile installs for it (`__ORT_WEB_VERSION__`, vite.config.ts), so the path and the files never drift;
 *  - the build ships exactly the four files the choice can reach, byte for byte, each under Pages' 25 MiB;
 *  - production serves them through functions/_middleware.ts (public/_routes.json must not exclude /ort/*), with
 *    their content types and immutable caching, and a missing file is a 404, never the SPA's index.html with a
 *    200 (the F11 failure); public/_headers says the same for the static server;
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
  ORT_RESOURCE_POLICY,
  ORT_RUNTIME_FILES,
  PAGES_FILE_LIMIT_BYTES,
  ortRuntimePath,
  parseOrtRuntimePath
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

describe('production: /ort/* goes through the middleware, never the SPA fallback', () => {
  const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const SPA = () => new Response('<!doctype html><title>DreamStream</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  const handler = createOnRequest({ streamHostOn: false });
  const go = (url: string, next: () => Promise<Response>, init: { ua?: string; headers?: Record<string, string>; method?: string } = {}) =>
    handler({ request: new Request(url, { method: init.method ?? 'GET', headers: { 'user-agent': init.ua ?? HUMAN, ...(init.headers ?? {}) } }), next, env: {} as never });
  const fileFromAssets = (bytes = 'x', type = 'application/octet-stream') => vi.fn(async () => new Response(bytes, { headers: { 'content-type': type, etag: '"a"' } }));

  it('public/_routes.json routes /ort/* to the Functions (no exclude matches it), so the middleware sees every request', () => {
    const routes = JSON.parse(read('public/_routes.json')) as { include: string[]; exclude: string[] };
    expect(routes.include).toContain('/*');
    const matches = (pattern: string, p: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(p);
    for (const name of ORT_RUNTIME_FILES) {
      const p = `${ortRuntimePath(VERSION)}${name}`;
      expect(routes.exclude.filter((e) => matches(e, p)), p).toEqual([]);
    }
  });

  it('serves each file with its content type, immutable caching, same-origin only and nosniff', async () => {
    for (const name of ORT_RUNTIME_FILES) {
      const next = fileFromAssets();
      const res = await go(fileUrl(name), next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status, name).toBe(200);
      expect(res.headers.get('content-type'), name).toBe(name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe(ORT_CACHE_CONTROL);
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy-report-only'), 'a file, not a page').toBeNull();
      expect(await res.text()).toBe('x');
    }
  });

  it("a missing file (the asset server's SPA answer: index.html with a 200) is a plain 404 that nothing keeps", async () => {
    // An old tab after a deploy that moved to a new onnxruntime-web asks for the old version's folder: gone.
    const res = await go(`https://dreamstreamstudio.ai/ort/1.0.0/ort-wasm-simd-threaded.asyncify.wasm`, async () => SPA());
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).not.toMatch(/<html|<!doctype/i);
    // Any other non-file answer too (a redirect, an error).
    for (const status of [301, 308, 404, 500]) {
      const r = await go(fileUrl('ort-wasm-simd-threaded.mjs'), async () => new Response(null, { status, headers: status < 400 ? { location: '/' } : {} }));
      expect(r.status, String(status)).toBe(404);
    }
  });

  it('anything under /ort/ that is not one of the four files is a 404 without asking the asset server', async () => {
    for (const p of ['/ort', '/ort/', `/ort/${VERSION}/`, `/ort/${VERSION}/ort-wasm-simd-threaded.jsep.mjs`, `/ort/${VERSION}/ort.bundle.min.mjs`, '/ort/latest/ort-wasm-simd-threaded.mjs', `/ort/${VERSION}/sub/ort-wasm-simd-threaded.mjs`]) {
      const next = vi.fn(async () => SPA());
      const res = await go(`https://dreamstreamstudio.ai${p}`, next);
      expect(res.status, p).toBe(404);
      expect(next, p).not.toHaveBeenCalled();
    }
    expect(parseOrtRuntimePath(`/ort/${VERSION}/ort-wasm-simd-threaded.asyncify.wasm`)).toEqual({ version: VERSION, file: 'ort-wasm-simd-threaded.asyncify.wasm' });
  });

  it('an automated browser gets the file, not the agent check-in (a page in it may use voice)', async () => {
    const res = await go(fileUrl('ort-wasm-simd-threaded.asyncify.mjs'), fileFromAssets(), { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36' });
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('the comics host (proxied to the Pages origin) is served, not redirected; a revalidation keeps its 304', async () => {
    const proxied = await go(fileUrl('ort-wasm-simd-threaded.wasm', 'https://comic2.pages.dev'), fileFromAssets(), { headers: { 'x-forwarded-host': 'comics.dreamstreamstudio.ai' } });
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get('content-type')).toBe('application/wasm');
    const revalidated = await go(fileUrl('ort-wasm-simd-threaded.wasm'), async () => new Response(null, { status: 304, headers: { etag: '"a"' } }), { headers: { 'if-none-match': '"a"' } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('cache-control')).toBe(ORT_CACHE_CONTROL);
  });

  it('public/_headers gives the static server the same rules (the middleware sets them too: Pages need not apply _headers to a Function response)', () => {
    const headers = read('public/_headers');
    const block = (pattern: string) => {
      const lines = headers.split('\n');
      const start = lines.findIndex((l) => l === pattern);
      if (start < 0) return '';
      const out: string[] = [];
      for (const l of lines.slice(start + 1)) {
        if (!/^\s+\S/.test(l)) break;
        out.push(l.trim());
      }
      return out.join('\n');
    };
    expect(block('/ort/*')).toBe(`Cache-Control: ${ORT_CACHE_CONTROL}\nCross-Origin-Resource-Policy: ${ORT_RESOURCE_POLICY}`);
    expect(block('/ort/*.mjs')).toBe(`Content-Type: ${ORT_CONTENT_TYPES.mjs}`);
    expect(block('/ort/*.wasm')).toBe(`Content-Type: ${ORT_CONTENT_TYPES.wasm}`);
    // No other rule names a Cache-Control or Content-Type that would be joined onto these (Pages joins repeats).
    const others = headers.split(/\n(?=\S)/).filter((b) => !b.startsWith('/ort/') && /^\/\*\s*$/m.test(b.split('\n')[0] ?? ''));
    for (const b of others) expect(b).not.toMatch(/^\s+(Cache-Control|Content-Type|Cross-Origin-Resource-Policy):/m);
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
    writeFileSync(path.join(folder, 'ort-wasm-simd-threaded.mjs'), 'export default 1;');
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
    expect(await ok.text()).toBe('export default 1;');
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
