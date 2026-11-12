// On-device Whisper transcription via transformers.js (ONNX runtime, WebGPU when
// available, WASM otherwise). The model runs in the browser: audio never leaves the
// device and no API key or external inference service is involved.
//
// Where the weights come from: the first use downloads them once from Hugging Face
// (huggingface.co), and transformers.js keeps them in the browser's Cache API, so later
// takes start from the cache and work offline. The ONNX runtime it runs on comes from
// jsDelivr (cdn.jsdelivr.net): transformers.js 4.2.0 sets that default when it is imported
// and this file leaves it alone, so the copy names both hosts (serving the runtime from our
// own origin is a later, spike-gated change). Our own origin is never asked for model
// files. `public/models/` holds no Whisper weights, and the site's SPA fallback answers a
// missing file there with index.html (HTTP 200, text/html, cached as immutable), which
// transformers.js would parse as JSON and then fail on, every time (see loadWhisper).

export type WhisperModelSize = 'tiny' | 'base' | 'small';

export interface WhisperLoadProgress {
  /** 0..1 overall download/initialization progress (best effort). */
  progress: number;
  status: 'downloading' | 'ready';
}

const MODEL_IDS: Record<WhisperModelSize, string> = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small'
};

type AsrPipeline = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

const pipelines = new Map<string, Promise<AsrPipeline>>();

/** Where transformers.js looks for "local" Whisper files on our own origin when local models are on. */
export const LOCAL_MODEL_PREFIX = '/models/onnx-community/';

/**
 * Remove the cached copies of our own origin's `/models/onnx-community/…` answers.
 *
 * Before this fix the app turned local models on, so transformers.js asked our origin first, got the
 * SPA's index.html with a 200, and stored it in its cache under that same-origin URL. It checks the
 * cache under the local path before the Hugging Face URL even with local models off, so a stored
 * page would keep failing every load on that browser. No real weights ever live there; the real ones
 * are cached under their huggingface.co URLs and are kept.
 */
export const dropPoisonedModelCache = async (cacheKey: string): Promise<number> => {
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
      if (url.origin !== location.origin || !url.pathname.startsWith(LOCAL_MODEL_PREFIX)) continue;
      if (await cache.delete(req)) dropped += 1;
    }
    return dropped;
  } catch {
    return 0; // the cache is a speed-up only; a load still works without this clean-up
  }
};

let cacheCleaned: Promise<unknown> | null = null;

export const hasWebGpu = (): boolean => typeof navigator !== 'undefined' && 'gpu' in navigator;

/** Encoder + decoder, MB (decimal), as transformers.js fetches them: q8 on WASM, q4 on WebGPU. */
const MODEL_MB: Record<'wasm' | 'webgpu', Record<WhisperModelSize, number>> = {
  wasm: { tiny: 40.8, base: 76.9, small: 249 },
  webgpu: { tiny: 95.7, base: 142.4, small: 299.3 }
};
/** The ONNX runtime downloaded with the model: its larger (asyncify) build, so the figure is never low. */
const RUNTIME_MB = 23.6;

/**
 * The one-time download for a size on this device, rounded to 5 MB: an upper bound (Safari's runtime
 * is about 10 MB smaller), so the copy says "up to about".
 */
export const downloadMb = (size: WhisperModelSize, device: 'wasm' | 'webgpu' = hasWebGpu() ? 'webgpu' : 'wasm'): number =>
  Math.round((MODEL_MB[device][size] + RUNTIME_MB) / 5) * 5;

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
  const id = MODEL_IDS[size];
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
    // Once per page: forget any index.html an older build stored under the local model path.
    cacheCleaned ??= dropPoisonedModelCache(env.cacheKey || 'transformers-cache');
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

    const asr = await pipeline('automatic-speech-recognition', id, {
      device: hasWebGpu() ? 'webgpu' : 'wasm',
      // q4 on GPU keeps VRAM small; q8 is the accuracy/speed sweet spot on WASM.
      dtype: hasWebGpu() ? 'q4' : 'q8',
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
export const whisperReady = (size: WhisperModelSize): boolean => pipelines.has(MODEL_IDS[size]);

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
