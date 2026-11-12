// The private voice model must load on the live site (F11). Before the fix the app turned transformers.js's
// local models on, so it asked our own origin for its files under /models/onnx-community/ first. The
// site answers any missing path with index.html (HTTP 200, text/html), transformers.js parsed that as JSON and
// the load failed, and it cached the page under the local path, which it reads before the Hugging Face URL on
// every later load. These tests fail on the old engine: local models were on, and nothing was cleaned up.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LoadOptions = { progress_callback?: (info: unknown) => void; device?: unknown; dtype?: unknown; revision?: unknown };

const tf = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  /** One entry per pipeline(): what the engine saw at that moment, and what it was asked for. */
  seenAtPipeline: [] as Array<{ allowLocalModels: unknown; cacheKeysLeft: string[]; wasmPaths?: unknown; useWasmCache?: unknown; id?: string; device?: unknown; dtype?: unknown; revision?: unknown; hasRevision?: boolean; fetch?: unknown }>,
  progress: null as null | ((info: { status?: string; file?: string; progress?: number }) => void),
  cacheKeys: () => [] as string[]
}));

vi.mock('@huggingface/transformers', () => ({
  env: tf.env,
  pipeline: vi.fn(async (_task: string, id: string, opts: LoadOptions) => {
    tf.seenAtPipeline.push({
      allowLocalModels: tf.env.allowLocalModels,
      cacheKeysLeft: tf.cacheKeys(),
      wasmPaths: JSON.parse(JSON.stringify((tf.env as any).backends?.onnx?.wasm?.wasmPaths ?? null)),
      useWasmCache: tf.env.useWasmCache,
      id,
      device: opts.device,
      dtype: opts.dtype,
      revision: opts.revision,
      hasRevision: 'revision' in opts,
      fetch: tf.env.fetch
    });
    tf.progress = opts.progress_callback as typeof tf.progress;
    tf.progress?.({ status: 'progress', file: 'onnx/encoder_model_quantized.onnx', progress: 50 });
    return async () => ({ text: ' hello ' });
  })
}));

/** A browser Cache API with one `transformers-cache` holding the given URLs (and, for a note, its text). */
const fakeCaches = (urls: Array<string | [string, string]>, opts: { putFails?: boolean } = {}) => {
  const store = new Map<string, string>(urls.map((u) => (typeof u === 'string' ? [u, ''] : u)));
  const keyOf = (req: { url: string } | string) => (typeof req === 'string' ? req : req.url);
  const cache = {
    keys: vi.fn(async () => [...store.keys()].map((url) => ({ url }))),
    delete: vi.fn(async (req: { url: string } | string) => store.delete(keyOf(req))),
    match: vi.fn(async (req: { url: string } | string) => (store.has(keyOf(req)) ? new Response(store.get(keyOf(req))) : undefined)),
    put: vi.fn(async (req: { url: string } | string, res: Response) => {
      if (opts.putFails) throw new DOMException('quota', 'QuotaExceededError');
      store.set(keyOf(req), await res.text());
    })
  };
  const storage = {
    has: vi.fn(async (name: string) => name === 'transformers-cache'),
    open: vi.fn(async () => cache)
  };
  vi.stubGlobal('caches', storage);
  tf.cacheKeys = () => [...store.keys()];
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

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
type Gpu = { requestAdapter: () => Promise<unknown> };
const NAV_PROPS = ['vendor', 'userAgent', 'gpu'] as const;
/** Make jsdom's navigator read as a browser: its vendor, its user agent, and its WebGPU (none when `gpu` is left out). */
const asBrowser = (b: { vendor: string; ua: string; gpu?: Gpu }) => {
  Object.defineProperty(navigator, 'vendor', { configurable: true, get: () => b.vendor });
  Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => b.ua });
  if (b.gpu) Object.defineProperty(navigator, 'gpu', { configurable: true, value: b.gpu });
  else delete (navigator as unknown as Record<string, unknown>).gpu;
};
const chrome = (gpu?: Gpu) => asBrowser({ vendor: 'Google Inc.', ua: CHROME_UA, gpu });
const safari = (gpu?: Gpu) => asBrowser({ vendor: 'Apple Computer, Inc.', ua: SAFARI_UA, gpu });
/** A WebGPU that answers `requestAdapter()` with this (an adapter, or null when the device has no usable GPU). */
const gpuWith = (adapter: unknown): Gpu => ({ requestAdapter: vi.fn(async () => adapter) });

beforeEach(() => {
  vi.resetModules();
  for (const k of Object.keys(tf.env)) delete tf.env[k];
  // transformers.js's own defaults that matter here, including the runtime it picks on import (not Safari).
  Object.assign(tf.env, { allowLocalModels: false, localModelPath: '/models/', cacheKey: 'transformers-cache', useBrowserCache: true, useWasmCache: true });
  setPick(pickOf('asyncify'));
  tf.seenAtPipeline = [];
  tf.cacheKeys = () => [];
  chrome(); // a browser without WebGPU, unless a test says otherwise
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of NAV_PROPS) delete (navigator as unknown as Record<string, unknown>)[k];
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
    const { WHISPER_MODELS, pinMarkerUrl } = await engine();
    const notes = Object.values(WHISPER_MODELS).map((m): [string, string] => [pinMarkerUrl(m.id), m.revision]);
    const poisoned = [
      `${origin}/models/onnx-community/whisper-base/config.json`,
      `${origin}/models/onnx-community/whisper-base/generation_config.json`,
      // An older build let transformers.js keep the jsDelivr engine (code) in this cache; it is never read again.
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort-wasm-simd-threaded.asyncify.wasm',
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort-wasm-simd-threaded.asyncify.mjs'
    ];
    const kept = [
      // Real weights, fetched at the pinned commit (the note beside them says so).
      'https://huggingface.co/onnx-community/whisper-base/resolve/main/config.json',
      'https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model_quantized.onnx',
      `${origin}/models/yamnet/yamnet-v1.onnx`,
      `${origin}/ort/${__ORT_WEB_VERSION__}/ort-wasm-simd-threaded.asyncify.wasm`,
      'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/pyodide.js',
      'https://elsewhere.example/models/onnx-community/whisper-base/config.json'
    ];
    vi.resetModules();
    const { store } = fakeCaches([...poisoned, ...kept, ...notes]);
    const { loadWhisper } = await engine();
    await loadWhisper('base');
    const expected = [...kept, ...notes.map(([url]) => url)].sort();
    // The clean-up ran BEFORE transformers.js read the cache, so the poisoned answers can never be read again.
    expect(tf.seenAtPipeline[0].cacheKeysLeft.sort()).toEqual(expected);
    expect([...store.keys()].sort()).toEqual(expected);
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
  const SIZES = ['tiny', 'base', 'small'] as const;

  it('model plus the engine that will run, rounded to 5 MB, for each size', async () => {
    const { downloadMb } = await engine();
    expect(SIZES.map((s) => downloadMb(s, { device: 'wasm', runtime: 'asyncify' }))).toEqual([65, 100, 275]);
    expect(SIZES.map((s) => downloadMb(s, { device: 'webgpu', runtime: 'asyncify' }))).toEqual([120, 165, 325]);
    // Safari: the plain engine (about 13 MB, not 24), and never the WebGPU model files.
    expect(SIZES.map((s) => downloadMb(s, { device: 'wasm', runtime: 'plain' }))).toEqual([55, 90, 260]);
  });

  // Before the fix a Safari with WebGPU (Safari 26) was shown the WebGPU sizes with the larger engine: 165 MB for
  // Balanced, where it really downloads about 90.
  it('the size shown is the one this browser will download: Safari gets the plain engine and the WASM model, WebGPU or not', async () => {
    const { downloadMb, likelyVoiceSetup } = await engine();
    safari(gpuWith({}));
    expect(likelyVoiceSetup()).toEqual({ device: 'wasm', runtime: 'plain' });
    expect(SIZES.map((s) => downloadMb(s))).toEqual([55, 90, 260]);
    safari();
    expect(SIZES.map((s) => downloadMb(s))).toEqual([55, 90, 260]);
    chrome(gpuWith({}));
    expect(likelyVoiceSetup()).toEqual({ device: 'webgpu', runtime: 'asyncify' });
    expect(SIZES.map((s) => downloadMb(s))).toEqual([120, 165, 325]);
    chrome();
    expect(likelyVoiceSetup()).toEqual({ device: 'wasm', runtime: 'asyncify' });
    expect(SIZES.map((s) => downloadMb(s))).toEqual([65, 100, 275]);
  });

  it('other browsers on Apple devices (their own user agents) are not Safari: transformers.js gives them the asyncify engine', async () => {
    const { picksPlainRuntime } = await engine();
    const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    for (const ua of [`${ios} CriOS/140.0.0.0 Mobile/15E148 Safari/604.1`, `${ios} FxiOS/140.0 Mobile/15E148 Safari/605.1.15`, `${ios} EdgiOS/140.0 Mobile/15E148 Safari/605.1.15`, CHROME_UA]) {
      asBrowser({ vendor: 'Apple Computer, Inc.', ua });
      expect(picksPlainRuntime(), ua).toBe(false);
    }
    safari();
    expect(picksPlainRuntime()).toBe(true);
    chrome();
    expect(picksPlainRuntime()).toBe(false);
  });
});

// The WebGPU device is only asked of an engine that has one, on a device that has a usable GPU. Before the fix
// loadWhisper asked for 'webgpu' whenever `navigator.gpu` existed. Safari 26 has it, transformers.js gives Safari
// the plain engine, and the plain engine has no WebGPU entry point: every load failed there with "no available
// backend found. ERR: [webgpu] TypeError: ….webgpuInit is not a function".
describe('whisperEngine: the device follows the engine that will run', () => {
  it('the shipped plain build has no WebGPU entry point; the asyncify build, the one named for WebGPU, has one', async () => {
    const { ORT_WEBGPU_RUNTIME_MJS } = await import('./ortRuntime');
    // The onnxruntime-web transformers.js itself resolves (as vite.config.ts resolveOrtRuntime does).
    const app = createRequire(join(process.cwd(), 'package.json'));
    const dir = dirname(createRequire(app.resolve('@huggingface/transformers')).resolve('onnxruntime-web/webgpu'));
    expect(readFileSync(join(dir, 'ort-wasm-simd-threaded.mjs'), 'utf8')).not.toContain('webgpuInit');
    expect(readFileSync(join(dir, 'ort-wasm-simd-threaded.asyncify.mjs'), 'utf8')).toContain('webgpuInit');
    expect(ORT_WEBGPU_RUNTIME_MJS).toBe('ort-wasm-simd-threaded.asyncify.mjs');
    // The bundle transformers.js imports calls it as soon as a session asks for the 'webgpu' device.
    expect(readFileSync(join(dir, 'ort.webgpu.bundle.min.mjs'), 'utf8')).toMatch(/==="webgpu"&&[A-Za-z_$][\w$]*\(\)\.webgpuInit\(/);
  });

  it("Safari with WebGPU (the plain engine): device wasm and the q8 files, and the GPU is not even asked", async () => {
    fakeCaches([]);
    const gpu = gpuWith({});
    safari(gpu);
    setPick(pickOf('plain'));
    const { loadWhisper } = await engine();
    await loadWhisper('tiny');
    expect(tf.seenAtPipeline.map((p) => [p.device, p.dtype])).toEqual([['wasm', 'q8']]);
    expect(gpu.requestAdapter).not.toHaveBeenCalled();
  });

  it('the asyncify engine with a usable GPU: device webgpu and the q4 files', async () => {
    fakeCaches([]);
    chrome(gpuWith({ features: new Set() }));
    const { loadWhisper } = await engine();
    await loadWhisper('tiny');
    expect(tf.seenAtPipeline.map((p) => [p.device, p.dtype])).toEqual([['webgpu', 'q4']]);
  });

  it.each([
    ['navigator.gpu exists but there is no adapter (a phone or a VM without a usable GPU)', () => gpuWith(null)],
    ['asking for the adapter fails', (): Gpu => ({ requestAdapter: vi.fn(async () => Promise.reject(new Error('gpu process crashed'))) })],
    ['navigator.gpu is not a WebGPU at all', () => ({}) as unknown as Gpu]
  ])('the asyncify engine when %s: device wasm and the q8 files', async (_what, gpu) => {
    fakeCaches([]);
    chrome(gpu());
    const { loadWhisper } = await engine();
    await loadWhisper('base');
    expect(tf.seenAtPipeline.map((p) => [p.device, p.dtype])).toEqual([['wasm', 'q8']]);
  });

  it('a browser that never answers requestAdapter() does not hold the load up: after a short wait it runs on wasm', async () => {
    fakeCaches([]);
    chrome({ requestAdapter: vi.fn(() => new Promise<unknown>(() => undefined)) });
    vi.useFakeTimers();
    try {
      const { loadWhisper, GPU_ADAPTER_WAIT_MS } = await engine();
      const load = loadWhisper('tiny');
      await vi.advanceTimersByTimeAsync(GPU_ADAPTER_WAIT_MS - 1);
      expect(tf.seenAtPipeline, 'still waiting for the GPU').toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await load;
      expect(tf.seenAtPipeline.map((p) => [p.device, p.dtype])).toEqual([['wasm', 'q8']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no WebGPU in the browser: device wasm and the q8 files', async () => {
    fakeCaches([]);
    chrome();
    const { loadWhisper } = await engine();
    await loadWhisper('small');
    expect(tf.seenAtPipeline.map((p) => [p.device, p.dtype])).toEqual([['wasm', 'q8']]);
  });
});

// The engine is pinned (our own copy, by hash). The model it runs is pinned too: each size is asked of Hugging Face
// at one fixed commit. Before the fix nothing pinned it, so transformers.js asked for `<repo>/resolve/main/…`:
// whatever the branch held at each browser's first download.
//
// The pin is applied where the requests leave: transformers.js's own `env.fetch`. Passing `revision` to pipeline()
// is NOT enough in 4.2.0 and makes things worse: its file list, its file sizes and the tokenizer's existence probe
// ignore the revision and ask for `main`, miss the cache on every load, and an offline take fails (the e2e saw the
// `main` requests; see WHISPER_MODELS).
describe('whisperEngine: each voice model is asked of Hugging Face at one fixed commit, never a moving branch', () => {
  const SIZES = ['tiny', 'base', 'small'] as const;

  it('the pin is a 40-hex commit for every size, and no two sizes share one (each is its own repository)', async () => {
    const { WHISPER_MODELS } = await engine();
    expect(SIZES.map((s) => WHISPER_MODELS[s].id)).toEqual(SIZES.map((s) => `onnx-community/whisper-${s}`));
    const revisions = Object.values(WHISPER_MODELS).map((m) => m.revision);
    for (const r of revisions) expect(r).toMatch(/^[0-9a-f]{40}$/);
    expect(new Set(revisions).size).toBe(3);
  });

  it('pinnedModelUrl: any revision of one of our models becomes its pinned commit; nothing else is touched', async () => {
    const { pinnedModelUrl, WHISPER_MODELS } = await engine();
    for (const size of SIZES) {
      const { id, revision } = WHISPER_MODELS[size];
      const at = (rev: string, file: string) => `https://huggingface.co/${id}/resolve/${rev}/${file}`;
      for (const file of ['config.json', 'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_q4.onnx']) {
        expect(pinnedModelUrl(at('main', file))).toBe(at(revision, file));
        expect(pinnedModelUrl(at('refs%2Fpr%2F7', file)), 'a pull-request ref').toBe(at(revision, file));
        expect(pinnedModelUrl(at('0000000000000000000000000000000000000000', file)), 'another commit').toBe(at(revision, file));
        expect(pinnedModelUrl(at(revision, file)), 'already pinned').toBe(at(revision, file));
      }
      expect(pinnedModelUrl(`https://huggingface.co/${id}/resolve/main/config.json?download=true`)).toBe(`https://huggingface.co/${id}/resolve/${revision}/config.json?download=true`);
    }
    for (const other of [
      'https://huggingface.co/onnx-community/another-model/resolve/main/config.json',
      'https://huggingface.co/api/models/onnx-community/whisper-base',
      'https://huggingface.co/onnx-community/whisper-base/tree/main',
      'https://cas-bridge.xethub.hf.co/xet-bridge-us/abc/def',
      'https://evil.example/onnx-community/whisper-base/resolve/main/config.json',
      `${window.location.origin}/ort/${__ORT_WEB_VERSION__}/ort-wasm-simd-threaded.wasm`,
      '/models/onnx-community/whisper-base/config.json',
      'not a url'
    ]) {
      expect(pinnedModelUrl(other), other).toBe(other);
    }
  });

  it("every request transformers.js sends goes through the pin: its env.fetch is wrapped before pipeline(), once", async () => {
    fakeCaches([]);
    const sent: Array<{ url: string; init?: RequestInit }> = [];
    const inner = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init });
      return new Response('{}');
    });
    tf.env.fetch = inner;
    const { loadWhisper, WHISPER_MODELS } = await engine();
    await loadWhisper('base');
    const wrapped = tf.seenAtPipeline[0].fetch as typeof fetch;
    expect(wrapped, 'env.fetch was replaced before pipeline() ran').not.toBe(inner);
    expect(tf.env.fetch).toBe(wrapped);

    const pin = WHISPER_MODELS.base.revision;
    const main = 'https://huggingface.co/onnx-community/whisper-base/resolve/main/';
    const pinned = `https://huggingface.co/onnx-community/whisper-base/resolve/${pin}/`;
    const init = { headers: { Range: 'bytes=0-0' } };
    await wrapped(`${main}tokenizer_config.json`, init); // the tokenizer's existence probe, as transformers.js sends it
    await wrapped(new URL(`${main}onnx/encoder_model_quantized.onnx`));
    await wrapped(new Request(`${main}config.json`, { headers: { 'x-test': '1' } }));
    await wrapped(`${window.location.origin}/assets/app.js`);
    expect(sent.map((s) => s.url)).toEqual([`${pinned}tokenizer_config.json`, `${pinned}onnx/encoder_model_quantized.onnx`, `${pinned}config.json`, `${window.location.origin}/assets/app.js`]);
    expect(sent[0].init, 'the request is otherwise passed on as it was').toBe(init);

    // A second load (another size) does not wrap the wrapper.
    await loadWhisper('tiny');
    expect(tf.env.fetch).toBe(wrapped);
    await wrapped(`${main}config.json`);
    expect(inner).toHaveBeenCalledTimes(5);
  });

  it("transformers.js is not given a revision: with one, its own look-ups (which ignore it) would miss the cache on every load", async () => {
    fakeCaches([]);
    const { loadWhisper } = await engine();
    for (const size of SIZES) await loadWhisper(size);
    expect(tf.seenAtPipeline.map((p) => [p.id, p.hasRevision])).toEqual(SIZES.map((s) => [`onnx-community/whisper-${s}`, false]));
  });

  describe('the cache stays true to the pins (keepPinnedModelCache)', () => {
    const file = (repo: string, f: string) => `https://huggingface.co/onnx-community/${repo}/resolve/main/${f}`;

    it("a browser's first use: the notes are written before anything is downloaded", async () => {
      const { store } = fakeCaches([]);
      const { loadWhisper, WHISPER_MODELS, pinMarkerUrl } = await engine();
      await loadWhisper('tiny');
      const notes = Object.values(WHISPER_MODELS).map((m) => [pinMarkerUrl(m.id), m.revision]);
      expect([...store.entries()].sort()).toEqual(notes.sort());
      expect(tf.seenAtPipeline[0].cacheKeysLeft.sort(), 'before pipeline() fetched a thing').toEqual(notes.map(([u]) => u).sort());
    });

    it('files cached at the pinned commits are kept, load after load', async () => {
      const { WHISPER_MODELS, pinMarkerUrl } = await engine();
      const cached = [file('whisper-base', 'config.json'), file('whisper-base', 'onnx/decoder_model_merged_quantized.onnx'), file('whisper-tiny', 'tokenizer.json')];
      const notes = Object.values(WHISPER_MODELS).map((m): [string, string] => [pinMarkerUrl(m.id), m.revision]);
      vi.resetModules();
      const { store, cache } = fakeCaches([...cached, ...notes]);
      const { loadWhisper } = await engine();
      await loadWhisper('base');
      expect([...store.keys()].sort()).toEqual([...cached, ...notes.map(([u]) => u)].sort());
      expect(cache.delete).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
    });

    it("a moved pin, or files with no note (cached before pins existed): that model's files are dropped and fetched again; other models' are kept", async () => {
      const { WHISPER_MODELS, pinMarkerUrl } = await engine();
      const baseFiles = [file('whisper-base', 'config.json'), file('whisper-base', 'onnx/encoder_model_quantized.onnx')];
      const smallFiles = [file('whisper-small', 'config.json')]; // no note at all
      const tinyFiles = [file('whisper-tiny', 'config.json'), file('whisper-tiny', 'onnx/encoder_model_q4.onnx')];
      vi.resetModules();
      const { store } = fakeCaches([
        ...baseFiles,
        [pinMarkerUrl('onnx-community/whisper-base'), '1846881b6b3a3024392c1eea3ad983695bc23925'], // an older commit
        ...smallFiles,
        ...tinyFiles,
        [pinMarkerUrl('onnx-community/whisper-tiny'), WHISPER_MODELS.tiny.revision],
        'https://huggingface.co/onnx-community/another-model/resolve/main/config.json'
      ]);
      const { loadWhisper } = await engine();
      await loadWhisper('base');
      expect([...store.keys()].sort()).toEqual(
        [...tinyFiles, ...Object.values(WHISPER_MODELS).map((m) => pinMarkerUrl(m.id)), 'https://huggingface.co/onnx-community/another-model/resolve/main/config.json'].sort()
      );
      for (const m of Object.values(WHISPER_MODELS)) expect(store.get(pinMarkerUrl(m.id)), m.id).toBe(m.revision);
    });

    it('where the note cannot be written, nothing is dropped (a cache that cannot be tracked is not emptied on every page)', async () => {
      const cached = [file('whisper-base', 'config.json'), file('whisper-base', 'onnx/encoder_model_quantized.onnx')];
      const { store, cache } = fakeCaches(cached, { putFails: true });
      const { loadWhisper } = await engine();
      await expect(loadWhisper('base')).resolves.toBeTypeOf('function');
      expect([...store.keys()].sort()).toEqual([...cached].sort());
      expect(cache.delete).not.toHaveBeenCalled();
    });
  });

  describe('what this relies on in transformers.js (read from node_modules)', () => {
    const web = readFileSync(join(process.cwd(), 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.web.js'), 'utf8');

    it('every Hub request goes through env.fetch: the file fetch and the size / existence probe', () => {
      expect(web).toMatch(/fetch: DEFAULT_FETCH/);
      // getFile: the download itself.
      expect(web).toMatch(/return env\.fetch\(urlOrPath, \{\s*headers: getFetchHeaders\(urlOrPath\)\s*\}\);/);
      // fetch_file_head: the one-byte range request behind every "does it exist, how big is it" look-up.
      expect(web).toMatch(/headers\.set\("Range", "bytes=0-0"\);\s*return env\.fetch\(urlOrPath, \{ method: "GET", headers, cache: "no-store" \}\);/);
      // And nothing in its Hub code calls the global fetch directly (a bare fetch( there would bypass the pin).
      const hub = web.slice(web.indexOf('// src/utils/model_registry/get_file_metadata.js'), web.indexOf('// src/utils/maths.js'));
      expect(hub.length, 'the Hub code was found').toBeGreaterThan(5000);
      expect(hub.match(/(?<![.\w])fetch\(/g) ?? []).toEqual([]);
      // The one direct fetch in the whole file belongs to an experimental cache that is off unless a page turns it on.
      expect(web.match(/(?<![.\w])fetch\(/g) ?? []).toHaveLength(1);
      expect(web).toMatch(/const text = await fetch\(rawUrl\)/);
      expect(web).toMatch(/experimental_useCrossOriginStorage: false,/);
      expect(web).toMatch(/if \(!cache2 && env\.experimental_useCrossOriginStorage && CrossOriginStorage\.isAvailable\(\)\)/);
    });

    it('the URL it asks for is {host}/{model}/resolve/{revision}/{file}, which is the shape pinnedModelUrl rewrites', () => {
      expect(web).toMatch(/remoteHost:\s*"https:\/\/huggingface\.co\/"/);
      expect(web).toMatch(/remotePathTemplate:\s*"\{model\}\/resolve\/\{revision\}\/"/);
      expect(web).toMatch(/env\.remotePathTemplate\.replaceAll\("\{model\}", path_or_repo_id\)\.replaceAll\("\{revision\}", encodeURIComponent\(revision\)\)/);
    });

    it("its own look-ups ignore the revision (why none is passed): pipeline()'s file list and the tokenizer's probe use main", () => {
      expect(web).toMatch(/const expected_files = await get_pipeline_files\(task, model, \{\s*device,\s*dtype\s*\}\);/);
      expect(web).toMatch(/const metadata = await get_file_metadata\(modelId, "tokenizer_config\.json", \{\}\);/);
    });
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

  // pinOwnRuntime writes `env.backends.onnx.wasm.wasmPaths`. That only reaches the engine because
  // `env.backends.onnx` is a SHALLOW copy of onnxruntime-web's own env, so `.wasm` is the very object the engine
  // reads. A deep copy in a later transformers.js would leave the engine on jsDelivr while every mocked test here
  // still passed; this fails first. (The e2e is the proof in a real browser: tests/e2e/studio.dictation.spec.ts.)
  it("env.backends.onnx shares onnxruntime-web's own `wasm` object (a shallow copy), so the pair we set is the pair it loads", () => {
    expect(web).toMatch(/env\.backends\.onnx = \{\s*\.\.\.ONNX_ENV,\s*setLogLevel\s*\};/);
    expect(web).toMatch(/var ONNX_ENV = ONNX\?\.env;/);
  });

  it('the engine runs in the page, not in a proxy worker (transformers.js turns the proxy off itself)', () => {
    expect(web).toMatch(/ONNX_ENV\.wasm\.proxy = false;/);
  });

  it("its Safari test is the one our size copy mirrors (picksPlainRuntime): Apple's vendor, and not another browser's user agent", () => {
    expect(web).toMatch(
      /var isSafari = \(\) => \{\s*if \(typeof navigator === "undefined"\) \{\s*return false;\s*\}\s*const userAgent = navigator\.userAgent;\s*const vendor = navigator\.vendor \|\| "";\s*const isAppleVendor = vendor\.indexOf\("Apple"\) > -1;\s*const notOtherBrowser = !userAgent\.match\(\/CriOS\|FxiOS\|EdgiOS\|OPiOS\|mercury\|brave\/i\) && !userAgent\.includes\("Chrome"\) && !userAgent\.includes\("Android"\);\s*return isAppleVendor && notOtherBrowser;\s*\};\s*var IS_SAFARI = isSafari\(\);/
    );
  });
});
