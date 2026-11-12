// On-device Whisper transcription via transformers.js (ONNX runtime: WebGPU when the engine
// that runs has it and the device has a usable GPU, WASM otherwise). The model runs in the
// browser: audio never leaves the device and no API key or external inference service is involved.
//
// Where the files come from. The model weights (data): the first use downloads them once from Hugging Face
// (huggingface.co), the only third-party host, each size at one fixed commit (WHISPER_MODELS, pinHubFetch), and
// transformers.js keeps them in the browser's Cache API, so later takes start from the cache and work offline. The voice engine
// itself (the ONNX runtime, code that runs in the page): from DreamStream, at `/ort/<version>/` on our own origin
// (./ortRuntime.ts), never a CDN.
// transformers.js 4.2.0 points the runtime at cdn.jsdelivr.net when it is imported; pinOwnRuntime keeps its
// choice of build and moves it to our copy before the first pipeline(), and the browser loads that copy itself
// (no code is kept in the Cache API, no blob: script). Our own origin is never asked for model files.
// `public/models/` holds no Whisper weights, and the site's SPA fallback answers a missing file there with
// index.html (HTTP 200, text/html, cached as immutable), which transformers.js would parse as JSON and then
// fail on, every time (see loadWhisper).

import { DictationError } from './errors';
import { ORT_WEBGPU_RUNTIME_MJS, isOrtRuntimeFile, ortRuntimePath } from './ortRuntime';

export type WhisperModelSize = 'tiny' | 'base' | 'small';

export interface WhisperLoadProgress {
  /** 0..1 overall download/initialization progress (best effort). */
  progress: number;
  status: 'downloading' | 'ready';
}

/**
 * Each size's Hugging Face repository and the one commit its files are fetched at (`<repo>/resolve/<commit>/…`).
 * Never a branch: `main` moves (one of the three changed on 2026-11-02), so without a pin each browser would keep
 * whatever the branch held at its first download, and a change upstream would reach users unreviewed. The files
 * at these commits are the ones MODEL_MB was measured from (the Hub's tree API, 2026-11-12).
 *
 * How the pin is applied: at the network, not through transformers.js's `revision` option. Every request
 * transformers.js makes goes through `env.fetch`; pinHubFetch wraps it so that any URL of these repositories, at
 * whatever revision, is asked for at the pinned commit (pinnedModelUrl). transformers.js itself still thinks it
 * is loading `main`, on purpose. In 4.2.0 several of its own look-ups ignore the revision they are given and use
 * `main` (pipeline()'s file list and file sizes, the tokenizer's "is there a tokenizer_config.json?" probe). With a
 * revision passed, those look-ups miss the cache on every load: each take would ask Hugging Face for `main` again,
 * and an offline take would fail outright (the probe cannot be answered, so no tokenizer is loaded). With one
 * name for everything, a cached model needs no request at all, and no request ever names a branch
 * (tests/e2e/studio.dictation.spec.ts requires both).
 *
 * Moving a pin: read the new commit from huggingface.co/api/models/<repo>, check the q8 and q4 encoder and
 * decoder sizes at it (…/tree/<commit>/onnx), update MODEL_MB if they changed, and change it here in a reviewed
 * commit. Browsers that hold the old files drop them and download the new ones once (keepPinnedModelCache).
 */
export const WHISPER_MODELS: Readonly<Record<WhisperModelSize, { readonly id: string; readonly revision: string }>> = {
  tiny: { id: 'onnx-community/whisper-tiny', revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7' },
  base: { id: 'onnx-community/whisper-base', revision: '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c' },
  small: { id: 'onnx-community/whisper-small', revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732' }
};

/** Where transformers.js fetches model files from (its `env.remoteHost`). */
export const HUB_ORIGIN = 'https://huggingface.co';

const PIN_BY_REPO: ReadonlyMap<string, string> = new Map(Object.values(WHISPER_MODELS).map((m) => [m.id, m.revision]));

/**
 * A file of one of our voice models on the Hub, at any revision (`…/<repo>/resolve/<revision>/<file>`) → the same
 * file at that model's pinned commit. Any other URL comes back unchanged.
 */
export const pinnedModelUrl = (url: string): string => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.origin !== HUB_ORIGIN) return url;
  const m = /^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(u.pathname);
  const pin = m ? PIN_BY_REPO.get(m[1]) : undefined;
  if (!m || !pin || m[2] === pin) return url;
  u.pathname = `/${m[1]}/resolve/${pin}/${m[3]}`;
  return u.href;
};

const PINNED_FETCH = Symbol.for('dreamstream.dictation.pinnedHubFetch');

/**
 * Make every request transformers.js sends for our voice models go to their pinned commits: wrap its `env.fetch`
 * (the one function all its Hub requests use) with pinnedModelUrl. Safe to call again: it wraps once.
 */
export const pinHubFetch = (env: { fetch?: typeof fetch }): void => {
  const inner = env.fetch ?? globalThis.fetch.bind(globalThis);
  if ((inner as unknown as Record<symbol, unknown>)[PINNED_FETCH]) return;
  const pinned = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') return inner(pinnedModelUrl(input), init);
    if (input instanceof URL) return inner(pinnedModelUrl(input.href), init);
    const url = pinnedModelUrl(input.url);
    return inner(url === input.url ? input : new Request(url, input), init);
  }) as typeof fetch;
  (pinned as unknown as Record<symbol, unknown>)[PINNED_FETCH] = true;
  env.fetch = pinned;
};

type AsrPipeline = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

const pipelines = new Map<string, Promise<AsrPipeline>>();

/** Where transformers.js looks for "local" Whisper files on our own origin when local models are on. */
export const LOCAL_MODEL_PREFIX = '/models/onnx-community/';

/** Where older builds fetched the voice engine from; transformers.js kept those copies (code) in its cache. */
export const STALE_RUNTIME_PREFIX = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@';

/**
 * Remove what older builds left in transformers.js's cache that this build never reads again.
 *
 *  - Our own origin's `/models/onnx-community/…` answers. Before the F11 fix the app turned local models on, so
 *    transformers.js asked our origin first, got the SPA's index.html with a 200, and stored it in its cache under
 *    that same-origin URL. It checks the cache under the local path before the Hugging Face URL even with local
 *    models off, so a stored page would keep failing every load on that browser. No real weights ever live there.
 *  - The voice engine fetched from jsDelivr (about 24 MB of code per browser that used voice). The engine now
 *    comes from our own origin and is never read from this cache, so those copies are only dead weight.
 *
 * The real weights are cached under their huggingface.co URLs and are kept.
 */
export const dropStaleVoiceCache = async (cacheKey: string): Promise<number> => {
  if (typeof caches === 'undefined' || typeof location === 'undefined') return 0;
  try {
    if (!(await caches.has(cacheKey))) return 0;
    const cache = await caches.open(cacheKey);
    let dropped = 0;
    for (const req of await cache.keys()) {
      let url: URL;
      try {
        url = new URL(req.url, location.href);
      } catch {
        continue;
      }
      const poisoned = url.origin === location.origin && url.pathname.startsWith(LOCAL_MODEL_PREFIX);
      const staleRuntime = url.href.startsWith(STALE_RUNTIME_PREFIX);
      if (!poisoned && !staleRuntime) continue;
      if (await cache.delete(req)) dropped += 1;
    }
    return dropped;
  } catch {
    return 0; // the cache is a speed-up only; a load still works without this clean-up
  }
};

/** The name, in transformers.js's cache, of the note that says which commit a model's cached files came from. */
export const pinMarkerUrl = (repo: string): string => `${HUB_ORIGIN}/${repo}/resolve/main/.dreamstream-pinned-commit`;

/**
 * Keep transformers.js's cache true to the pins. Its cached model files are stored under their `main` URLs
 * (WHISPER_MODELS explains why), which do not say which commit the bytes came from, so a note beside them does:
 * one small entry per repository holding the commit. For each model whose note is missing or names another
 * commit, the note is rewritten first and then that model's cached files are dropped, so the next load fetches
 * them at the pinned commit. Files cached before pins existed have no note and go the same way (once).
 *
 * The note is written BEFORE anything is dropped: where it cannot be written (no quota, a browser without a
 * writable cache), nothing is dropped, so a cache that cannot be tracked is never emptied on every page load.
 * On a browser's very first use the cache is created here and the notes are written before any file arrives, so
 * the first download is already accounted for.
 */
export const keepPinnedModelCache = async (cacheKey: string): Promise<number> => {
  if (typeof caches === 'undefined') return 0;
  try {
    const cache = await caches.open(cacheKey);
    let dropped = 0;
    for (const { id, revision } of Object.values(WHISPER_MODELS)) {
      const marker = pinMarkerUrl(id);
      const note = await cache.match(marker);
      if (note && (await note.text()).trim() === revision) continue;
      try {
        await cache.put(marker, new Response(revision, { headers: { 'content-type': 'text/plain' } }));
      } catch {
        continue; // cannot keep track here: leave this model's cache as it is
      }
      const prefix = `${HUB_ORIGIN}/${id}/resolve/`;
      for (const req of await cache.keys()) {
        if (!req.url.startsWith(prefix) || req.url === marker) continue;
        if (await cache.delete(req)) dropped += 1;
      }
    }
    return dropped;
  } catch {
    return 0; // the cache is a speed-up only; a load still works without this
  }
};

/** The voice engine's version: the onnxruntime-web transformers.js resolves, fixed at build time (vite.config.ts). */
export const ORT_WEB_VERSION: string = __ORT_WEB_VERSION__;

/** This page's copy of the voice engine: `<origin><base>ort/<version>/`. */
export const ownRuntimeBase = (): string => new URL(ortRuntimePath(ORT_WEB_VERSION, import.meta.env.BASE_URL || '/'), location.origin).href;

/** The part of transformers.js's `env.backends.onnx` this file reads and writes. */
export interface OnnxEnvLike {
  wasm?: { wasmPaths?: unknown };
  versions?: { web?: string };
}

const fileNameOf = (u: unknown): string => {
  const s = u instanceof URL ? u.href : typeof u === 'string' ? u : '';
  return s.slice(s.lastIndexOf('/') + 1);
};

/**
 * Point the voice engine at our own copy, keeping transformers.js's own choice of build. When it is imported,
 * transformers.js sets `wasmPaths` to a { mjs, wasm } pair (the plain build when its IS_SAFARI check is true, the
 * asyncify build otherwise); only the folder changes here, so every browser runs the build it would have run.
 * Anything else (no pair, a string prefix, a file this build does not ship, two halves of different builds, an
 * engine of another version) fails closed: the load stops with the calm download error and nothing is fetched.
 * Safe to call again: a pair already pointing here keeps its file names.
 */
export const pinOwnRuntime = (onnx: OnnxEnvLike | undefined, base: string = ownRuntimeBase()): { mjs: string; wasm: string } => {
  const wasm = onnx?.wasm;
  const picked = wasm?.wasmPaths;
  const pair = picked && typeof picked === 'object' && !(picked instanceof URL) ? (picked as { mjs?: unknown; wasm?: unknown }) : null;
  const mjs = fileNameOf(pair?.mjs);
  const bin = fileNameOf(pair?.wasm);
  const ok =
    !!wasm &&
    isOrtRuntimeFile(mjs) &&
    mjs.endsWith('.mjs') &&
    isOrtRuntimeFile(bin) &&
    bin.endsWith('.wasm') &&
    mjs.slice(0, -'.mjs'.length) === bin.slice(0, -'.wasm'.length) &&
    (onnx?.versions?.web === undefined || onnx.versions.web === ORT_WEB_VERSION);
  if (!ok || !wasm) throw new DictationError('model-download', 'The voice engine is not the one this build serves.');
  const paths = { mjs: `${base}${mjs}`, wasm: `${base}${bin}` };
  wasm.wasmPaths = paths;
  return paths;
};

let cacheCleaned: Promise<unknown> | null = null;

export type VoiceDevice = 'wasm' | 'webgpu';
/** Which build of the engine runs: transformers.js picks `plain` on Safari and `asyncify` everywhere else. */
export type VoiceRuntimeBuild = 'plain' | 'asyncify';

/** The browser has a WebGPU API. That alone promises nothing: see whisperDevice. */
export const hasWebGpu = (): boolean => typeof navigator !== 'undefined' && 'gpu' in navigator;

/** How long the browser gets to answer `requestAdapter()` before the load goes on without WebGPU. */
export const GPU_ADAPTER_WAIT_MS = 3000;

/**
 * True when the device really has a GPU to give: `requestAdapter()` answers with one. Never throws, and never
 * holds a load up: a browser that does not answer in time counts as having none (the load then runs on WASM).
 */
const hasGpuAdapter = async (): Promise<boolean> => {
  if (!hasWebGpu()) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
    if (typeof gpu?.requestAdapter !== 'function') return false;
    const gaveUp = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), GPU_ADAPTER_WAIT_MS);
    });
    return !!(await Promise.race([gpu.requestAdapter(), gaveUp]));
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * The device a load asks transformers.js for, given the engine file it will really run (pinOwnRuntime's pair).
 * WebGPU only when both hold: that file is the build with a WebGPU entry point (ORT_WEBGPU_RUNTIME_MJS), and the
 * device has a usable GPU. Everything else runs on WASM.
 *
 * Why not `'gpu' in navigator` alone (what this did before): transformers.js gives Safari the plain build, which
 * has no WebGPU entry point, and Safari 26 ships `navigator.gpu`. Asking for 'webgpu' there fails every load
 * ("no available backend found … webgpuInit is not a function"); transformers.js has no fallback. A browser with
 * `navigator.gpu` but no adapter failed the same way ("Failed to get GPU adapter").
 */
export const whisperDevice = async (runtimeMjs: string): Promise<VoiceDevice> =>
  fileNameOf(runtimeMjs) === ORT_WEBGPU_RUNTIME_MJS && (await hasGpuAdapter()) ? 'webgpu' : 'wasm';

/**
 * Will transformers.js pick the plain build here? Its own Safari test, word for word (`isSafari` in its env.js;
 * whisperEngine.test.ts fails if that code changes). Used ONLY to show the right download size before
 * transformers.js is loaded: what runs is decided from the pair transformers.js really picked, never from this.
 */
export const picksPlainRuntime = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent;
  const isAppleVendor = (navigator.vendor || '').indexOf('Apple') > -1;
  const notOtherBrowser = !userAgent.match(/CriOS|FxiOS|EdgiOS|OPiOS|mercury|brave/i) && !userAgent.includes('Chrome') && !userAgent.includes('Android');
  return isAppleVendor && notOtherBrowser;
};

/**
 * What a load will most likely use here, known without loading anything: the engine build, and WebGPU when that
 * build has it and the browser has the API. (Whether the device has an adapter is only known by asking; without
 * one the load uses WASM, a smaller download, so the size shown stays an upper bound.)
 */
export const likelyVoiceSetup = (): { device: VoiceDevice; runtime: VoiceRuntimeBuild } => {
  const runtime: VoiceRuntimeBuild = picksPlainRuntime() ? 'plain' : 'asyncify';
  return { device: runtime === 'asyncify' && hasWebGpu() ? 'webgpu' : 'wasm', runtime };
};

/** Encoder + decoder, MB (decimal), as transformers.js fetches them at the pinned commits: q8 on WASM, q4 on WebGPU. */
const MODEL_MB: Record<VoiceDevice, Record<WhisperModelSize, number>> = {
  wasm: { tiny: 40.8, base: 76.9, small: 249.1 },
  webgpu: { tiny: 95.7, base: 142.4, small: 299.3 }
};
/** The voice engine (from our own origin) downloaded with the model, per build: its .mjs and .wasm, MB (decimal). */
const RUNTIME_MB: Record<VoiceRuntimeBuild, number> = { plain: 13, asyncify: 23.6 };

/**
 * The one-time download for a size on this device, rounded to 5 MB: the model files for the device plus the engine
 * build that will run. An upper bound (a browser with WebGPU but no usable GPU downloads the smaller WASM files),
 * so the copy says "up to about".
 */
export const downloadMb = (size: WhisperModelSize, setup: { device: VoiceDevice; runtime: VoiceRuntimeBuild } = likelyVoiceSetup()): number =>
  Math.round((MODEL_MB[setup.device][size] + RUNTIME_MB[setup.runtime]) / 5) * 5;

// Every take waiting on a shared in-flight load hears its progress (a take started after a cancel joins it).
const progressListeners = new Map<string, Set<(p: WhisperLoadProgress) => void>>();

/**
 * Load (and cache) the ASR pipeline for a model size. Safe to call repeatedly —
 * the same in-flight promise is shared. Heavy code is dynamically imported so the
 * chat bundle doesn't pay for transformers.js until dictation is first used.
 */
export const loadWhisper = (
  size: WhisperModelSize,
  onProgress?: (p: WhisperLoadProgress) => void
): Promise<AsrPipeline> => {
  const { id } = WHISPER_MODELS[size];
  const existing = pipelines.get(id);
  if (existing) {
    if (onProgress) progressListeners.get(id)?.add(onProgress);
    return existing;
  }
  const listeners = new Set<(p: WhisperLoadProgress) => void>(onProgress ? [onProgress] : []);
  progressListeners.set(id, listeners);
  const emit = (p: WhisperLoadProgress) => listeners.forEach((fn) => fn(p));

  const load = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // Weights come from Hugging Face and the browser cache only: never from our origin (header).
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    // The voice engine comes from our own origin, in the build transformers.js chose, and the browser loads it
    // directly: off, transformers.js neither copies it into its cache nor turns it into a blob: script.
    env.useWasmCache = false;
    const runtime = pinOwnRuntime(env.backends?.onnx as OnnxEnvLike | undefined);
    // Every model file is asked of Hugging Face at its pinned commit, whatever revision transformers.js names.
    pinHubFetch(env as { fetch?: typeof fetch });
    // Once per page: forget what older builds stored (an index.html under the local model path, jsDelivr runtimes),
    // and any cached model files that did not come from the pinned commits.
    const cacheKey = env.cacheKey || 'transformers-cache';
    cacheCleaned ??= dropStaleVoiceCache(cacheKey).then(() => keepPinnedModelCache(cacheKey));
    await cacheCleaned;

    // Aggregate per-file progress events into one 0..1 number.
    const fileProgress = new Map<string, number>();
    const progress_callback = (info: { status?: string; file?: string; progress?: number }) => {
      if (info.status === 'progress' && info.file) {
        fileProgress.set(info.file, (info.progress ?? 0) / 100);
        const values = [...fileProgress.values()];
        emit({ progress: values.reduce((a, b) => a + b, 0) / values.length, status: 'downloading' });
      } else if (info.status === 'ready') {
        emit({ progress: 1, status: 'ready' });
      }
    };

    // WebGPU only on the engine build that has it, and only with a usable GPU (whisperDevice).
    const device = await whisperDevice(runtime.mjs);
    // No `revision` here, on purpose: the commit is pinned at the network (pinHubFetch; WHISPER_MODELS says why).
    const asr = await pipeline('automatic-speech-recognition', id, {
      device,
      // q4 on GPU keeps VRAM small; q8 is the accuracy/speed sweet spot on WASM.
      dtype: device === 'webgpu' ? 'q4' : 'q8',
      progress_callback
    });
    emit({ progress: 1, status: 'ready' });
    return asr as unknown as AsrPipeline;
  })();

  pipelines.set(id, load);
  load.then(
    () => progressListeners.delete(id),
    () => {
      progressListeners.delete(id);
      pipelines.delete(id); // allow retry after a failed download
    }
  );
  return load;
};

/** True once the model is loaded, or loading, in this session (no new download needed to start). */
export const whisperReady = (size: WhisperModelSize): boolean => pipelines.has(WHISPER_MODELS[size].id);

/**
 * Transcribe mono 16 kHz PCM. Language is auto-detected (multilingual model);
 * Whisper adds punctuation and casing on its own.
 */
export const transcribe = async (asr: AsrPipeline, audio: Float32Array): Promise<string> => {
  if (audio.length < 1600) return ''; // <0.1s — nothing to say
  const out = await asr(audio, {
    // Long takes are chunked with overlap so dictation isn't capped at 30s.
    chunk_length_s: 30,
    stride_length_s: 5
  });
  const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
  return (text ?? '').trim();
};
