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
  seenAtPipeline: [] as Array<{ allowLocalModels: unknown; cacheKeysLeft: string[]; wasmPaths?: unknown }>,
  progress: null as null | ((info: { status?: string; file?: string; progress?: number }) => void),
  cacheKeys: () => [] as string[]
}));

vi.mock('@huggingface/transformers', () => ({
  env: tf.env,
  pipeline: vi.fn(async (_task: string, _id: string, opts: { progress_callback?: (info: unknown) => void }) => {
    tf.seenAtPipeline.push({ allowLocalModels: tf.env.allowLocalModels, cacheKeysLeft: tf.cacheKeys(), wasmPaths: JSON.parse(JSON.stringify((tf.env as any).backends?.onnx?.wasm?.wasmPaths ?? null)) });
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

beforeEach(() => {
  vi.resetModules();
  for (const k of Object.keys(tf.env)) delete tf.env[k];
  // transformers.js's own defaults that matter here.
  Object.assign(tf.env, { allowLocalModels: false, localModelPath: '/models/', cacheKey: 'transformers-cache', useBrowserCache: true });
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

  it('forgets the index.html an older build cached under /models/onnx-community/, and only that', async () => {
    const origin = window.location.origin;
    const poisoned = [`${origin}/models/onnx-community/whisper-base/config.json`, `${origin}/models/onnx-community/whisper-base/generation_config.json`];
    const kept = [
      'https://huggingface.co/onnx-community/whisper-base/resolve/main/config.json',
      `${origin}/models/yamnet/yamnet-v1.onnx`,
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

// Guard (passes before and after): the copy says the first use downloads "from Hugging Face and jsDelivr"
// (DictationButton, docs/features/voice-dictation.md). That is true only while transformers.js 4.2.0 points the
// ONNX runtime at cdn.jsdelivr.net when the page leaves it unset, and loadWhisper leaves it unset. Serving the
// runtime from our own origin is VOICE-A commit 3 (spike-gated on iPhone Safari): when it lands, this guard
// fails, and the copy and docs drop jsDelivr in the same change.
describe('whisperEngine: the hosts the copy names are the hosts the first use contacts', () => {
  it('transformers.js defaults the runtime to cdn.jsdelivr.net, and loadWhisper does not change it', async () => {
    const web = readFileSync(join(process.cwd(), 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.web.js'), 'utf8');
    expect(web).toMatch(/https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@/);
    expect(web).toMatch(/!ONNX_ENV\.wasm\.wasmPaths/);

    fakeCaches([]);
    const jsdelivr = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev/dist/';
    const paths = { mjs: `${jsdelivr}ort-wasm-simd-threaded.asyncify.mjs`, wasm: `${jsdelivr}ort-wasm-simd-threaded.asyncify.wasm` };
    (tf.env as any).backends = { onnx: { wasm: { wasmPaths: { ...paths } } } }; // what its import leaves on env
    const { loadWhisper } = await engine();
    await loadWhisper('base');
    expect(tf.seenAtPipeline[0].wasmPaths).toEqual(paths);
  });
});
