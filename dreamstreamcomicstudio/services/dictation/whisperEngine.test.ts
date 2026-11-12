// The private voice model must load on the live site (F11). Before the fix the app turned transformers.js's
// local models on, so it asked our own origin for its files under /models/onnx-community/ first. The
// site answers any missing path with index.html (HTTP 200, text/html), transformers.js parsed that as JSON and
// the load failed, and it cached the page under the local path, which it reads before the Hugging Face URL on
// every later load. These tests fail on the old engine: local models were on, and nothing was cleaned up.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tf = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  seenAtPipeline: [] as Array<{ allowLocalModels: unknown; cacheKeysLeft: string[]; wasmPaths?: unknown; useWasmCache?: unknown }>,
  progress: null as null | ((info: { status?: string; file?: string; progress?: number }) => void),
  cacheKeys: () => [] as string[]
}));

vi.mock('@huggingface/transformers', () => ({
  env: tf.env,
  pipeline: vi.fn(async (_task: string, _id: string, opts: { progress_callback?: (info: unknown) => void }) => {
    tf.seenAtPipeline.push({
      allowLocalModels: tf.env.allowLocalModels,
      cacheKeysLeft: tf.cacheKeys(),
      wasmPaths: JSON.parse(JSON.stringify((tf.env as any).backends?.onnx?.wasm?.wasmPaths ?? null)),
      useWasmCache: tf.env.useWasmCache
    });
    tf.progress = opts.progress_callback as typeof tf.progress;
    tf.progress?.({ status: 'progress', file: 'onnx/encoder_model_quantized.onnx', progress: 50 });
    return async () => ({ text: ' hello ' });
  })
}));

/** A browser Cache API with one `transformers-cache` holding the given URLs. */
const fakeCaches = (urls: string[]) => {
  const store = new Set(urls);
  const cache = {
    keys: vi.fn(async () => [...store].map((url) => ({ url }))),
    delete: vi.fn(async (req: { url: string } | string) => store.delete(typeof req === 'string' ? req : req.url)),
    match: vi.fn(async () => undefined)
  };
  const storage = {
    has: vi.fn(async (name: string) => name === 'transformers-cache'),
    open: vi.fn(async () => cache)
  };
  vi.stubGlobal('caches', storage);
  tf.cacheKeys = () => [...store];
  return { store, cache, storage };
};

const engine = () => import('./whisperEngine');

/** What transformers.js 4.2.0 leaves on `env.backends.onnx.wasm.wasmPaths` when it is imported (its own pick). */
const JSDELIVR = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${__ORT_WEB_VERSION__}/dist/`;
const pickOf = (build: 'asyncify' | 'plain') => {
  const stem = build === 'asyncify' ? 'ort-wasm-simd-threaded.asyncify' : 'ort-wasm-simd-threaded';
  return { mjs: `${JSDELIVR}${stem}.mjs`, wasm: `${JSDELIVR}${stem}.wasm` };
};
const setPick = (wasmPaths: unknown, web: string | undefined = __ORT_WEB_VERSION__) => {
  (tf.env as any).backends = { onnx: { wasm: { wasmPaths, proxy: false }, versions: { web } } };
};

beforeEach(() => {
  vi.resetModules();
  for (const k of Object.keys(tf.env)) delete tf.env[k];
  // transformers.js's own defaults that matter here, including the runtime it picks on import (not Safari).
  Object.assign(tf.env, { allowLocalModels: false, localModelPath: '/models/', cacheKey: 'transformers-cache', useBrowserCache: true, useWasmCache: true });
  setPick(pickOf('asyncify'));
  tf.seenAtPipeline = [];
  tf.cacheKeys = () => [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('whisperEngine: the private model loads on the live site (F11)', () => {
  it('never asks our origin for model files: local models are off before the first pipeline()', async () => {
    fakeCaches([]);
    // A browser that once ran the old build: transformers.js keeps whatever the page set last.
    tf.env.allowLocalModels = true;
    const { loadWhisper } = await engine();
    await loadWhisper('base');
    expect(tf.seenAtPipeline).toHaveLength(1);
    expect(tf.seenAtPipeline[0].allowLocalModels).toBe(false);
  });

  it('forgets the index.html an older build cached under /models/onnx-community/ and the jsDelivr engines, and only those', async () => {
    const origin = window.location.origin;
    const poisoned = [
      `${origin}/models/onnx-community/whisper-base/config.json`,
      `${origin}/models/onnx-community/whisper-base/generation_config.json`,
      // An older build let transformers.js keep the jsDelivr engine (code) in this cache; it is never read again.
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort-wasm-simd-threaded.asyncify.wasm',
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort-wasm-simd-threaded.asyncify.mjs'
    ];
    const kept = [
      'https://huggingface.co/onnx-community/whisper-base/resolve/main/config.json',
      `${origin}/models/yamnet/yamnet-v1.onnx`,
      `${origin}/ort/${__ORT_WEB_VERSION__}/ort-wasm-simd-threaded.asyncify.wasm`,
      'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/pyodide.js',
      'https://elsewhere.example/models/onnx-community/whisper-base/config.json'
    ];
    const { store } = fakeCaches([...poisoned, ...kept]);
    const { loadWhisper } = await engine();
    await loadWhisper('base');
    // The clean-up ran BEFORE transformers.js read the cache, so the poisoned answers can never be read again.
    expect(tf.seenAtPipeline[0].cacheKeysLeft.sort()).toEqual([...kept].sort());
    expect([...store].sort()).toEqual([...kept].sort());
  });

  it('cleans up once per page, and a load still works with no Cache API at all', async () => {
    const { storage } = fakeCaches([]);
    const { loadWhisper } = await engine();
    await loadWhisper('tiny');
    await loadWhisper('base');
    expect(storage.has).toHaveBeenCalledTimes(1);

    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal('caches', undefined);
    const fresh = await engine();
    await expect(fresh.loadWhisper('small')).resolves.toBeTypeOf('function');
  });

  it('a take that joins a shared in-flight load hears its progress too', async () => {
    fakeCaches([]);
    const { loadWhisper } = await engine();
    const first = vi.fn();
    const second = vi.fn();
    const a = loadWhisper('base', first);
    const b = loadWhisper('base', second);
    expect(b).toBe(a);
    await a;
    expect(first).toHaveBeenCalledWith({ progress: 0.5, status: 'downloading' });
    expect(second).toHaveBeenCalledWith({ progress: 0.5, status: 'downloading' });
    expect(second).toHaveBeenLastCalledWith({ progress: 1, status: 'ready' });
  });
});

describe('whisperEngine: true download sizes', () => {
  it('model plus runtime, rounded to 5 MB, for each size on each device', async () => {
    const { downloadMb } = await engine();
    expect([downloadMb('tiny', 'wasm'), downloadMb('base', 'wasm'), downloadMb('small', 'wasm')]).toEqual([65, 100, 275]);
    expect([downloadMb('tiny', 'webgpu'), downloadMb('base', 'webgpu'), downloadMb('small', 'webgpu')]).toEqual([120, 165, 325]);
  });
});

// The voice engine (the ONNX runtime, code that runs in our origin next to the session) comes from our own site
// (review 1 #1). transformers.js 4.2.0 sets `wasmPaths` to cdn.jsdelivr.net when it is imported; before the fix
// loadWhisper left it there, so these fail on the old engine: the pair at pipeline() was off-origin.
describe('whisperEngine: the voice engine comes from our own origin, never a third-party CDN', () => {
  const ownPrefix = () => `${window.location.origin}/ort/${__ORT_WEB_VERSION__}/`;
  const expectOwn = (paths: unknown) => {
    expect(paths, 'wasmPaths is set when the pipeline is created').toEqual({ mjs: expect.any(String), wasm: expect.any(String) });
    for (const u of Object.values(paths as Record<string, string>)) {
      const url = new URL(u);
      expect(url.origin, `${u} is on our origin`).toBe(window.location.origin);
      expect(url.pathname.startsWith(`/ort/${__ORT_WEB_VERSION__}/`), `${u} is in this build's versioned folder`).toBe(true);
    }
  };

  it("keeps transformers.js's own pick (asyncify off Safari) and moves only its folder, before the first pipeline()", async () => {
    fakeCaches([]);
    const { loadWhisper } = await engine();
    await loadWhisper('base');
    expect(tf.seenAtPipeline).toHaveLength(1);
    expectOwn(tf.seenAtPipeline[0].wasmPaths);
    expect(tf.seenAtPipeline[0].wasmPaths).toEqual({ mjs: `${ownPrefix()}ort-wasm-simd-threaded.asyncify.mjs`, wasm: `${ownPrefix()}ort-wasm-simd-threaded.asyncify.wasm` });
    // The browser loads the engine itself: transformers.js keeps no copy of the code and makes no blob: script.
    expect(tf.seenAtPipeline[0].useWasmCache).toBe(false);
  });

  it('on Safari (transformers.js picks the plain build) the plain build is what loads, from our origin', async () => {
    fakeCaches([]);
    setPick(pickOf('plain'));
    const { loadWhisper } = await engine();
    await loadWhisper('tiny');
    expect(tf.seenAtPipeline[0].wasmPaths).toEqual({ mjs: `${ownPrefix()}ort-wasm-simd-threaded.mjs`, wasm: `${ownPrefix()}ort-wasm-simd-threaded.wasm` });
  });

  it('a second load (another size) keeps the same same-origin pair', async () => {
    fakeCaches([]);
    const { loadWhisper } = await engine();
    await loadWhisper('tiny');
    await loadWhisper('small');
    expect(tf.seenAtPipeline).toHaveLength(2);
    expect(tf.seenAtPipeline[1].wasmPaths).toEqual(tf.seenAtPipeline[0].wasmPaths);
    expectOwn(tf.seenAtPipeline[1].wasmPaths);
  });

  it.each([
    ['no pick at all (wasmPaths unset)', undefined, undefined],
    ['a string prefix (ORT would choose the file itself)', JSDELIVR, undefined],
    ['a build this site does not serve', { mjs: `${JSDELIVR}ort-wasm-simd-threaded.jsep.mjs`, wasm: `${JSDELIVR}ort-wasm-simd-threaded.jsep.wasm` }, undefined],
    ['halves of two different builds', { mjs: pickOf('plain').mjs, wasm: pickOf('asyncify').wasm }, undefined],
    ['an engine of another version', pickOf('asyncify'), '1.0.0']
  ])('fails closed on %s: the calm download error, and no pipeline (nothing is fetched)', async (_what, wasmPaths, web) => {
    fakeCaches([]);
    setPick(wasmPaths, web ?? __ORT_WEB_VERSION__);
    const { loadWhisper } = await engine();
    await expect(loadWhisper('base')).rejects.toMatchObject({ name: 'DictationError', code: 'model-download' });
    expect(tf.seenAtPipeline).toEqual([]);
  });
});

describe('whisperEngine: the selection the engine keeps is the one transformers.js makes', () => {
  // The code that picks the engine, from the transformers.js the app resolves (its browser build).
  const web = readFileSync(join(process.cwd(), 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.web.js'), 'utf8');
  const start = web.indexOf('const wasmPathPrefix = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNX_ENV.versions.web}/dist/`;');
  const block = start < 0 ? '' : web.slice(start, web.indexOf('ONNX_ENV.wasm.proxy = false;', start));

  it('is a { mjs, wasm } pair chosen by IS_SAFARI, only when the page has not set one', () => {
    expect(block, 'the selection code is where 4.2.0 keeps it').not.toBe('');
    expect(web).toMatch(/ONNX_ENV\.versions\?\.web && !ONNX_ENV\.wasm\.wasmPaths\s*\)\s*\{\s*const wasmPathPrefix/);
    expect(block).toMatch(/ONNX_ENV\.wasm\.wasmPaths = apis\.IS_SAFARI \? \{\s*mjs: `\$\{wasmPathPrefix\}ort-wasm-simd-threaded\.mjs`,\s*wasm: `\$\{wasmPathPrefix\}ort-wasm-simd-threaded\.wasm`\s*\} : \{\s*mjs: `\$\{wasmPathPrefix\}ort-wasm-simd-threaded\.asyncify\.mjs`,\s*wasm: `\$\{wasmPathPrefix\}ort-wasm-simd-threaded\.asyncify\.wasm`\s*\};/);
  });

  it('names exactly the four files the build ships (a new variant fails here before it can 404 in production)', async () => {
    const { ORT_RUNTIME_FILES } = await import('./ortRuntime');
    const named = [...new Set([...block.matchAll(/ort-wasm-[A-Za-z0-9.-]+?\.(?:mjs|wasm)/g)].map((m) => m[0]))];
    expect(named.sort()).toEqual([...ORT_RUNTIME_FILES].sort());
  });

  it('with useWasmCache off transformers.js leaves the pair alone (no Cache API copy, no blob: script)', () => {
    expect(web).toMatch(/const shouldUseWasmCache = env\.useWasmCache && typeof ONNX_ENV\?\.wasm\?\.wasmPaths === "object"/);
  });
});
