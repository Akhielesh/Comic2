// On-device Whisper transcription via transformers.js (ONNX runtime, WebGPU when
// available, WASM otherwise). The model runs entirely in the browser: audio never
// leaves the device and no API key or external inference service is involved.
//
// Self-hosting: weights are looked up under `/models/<model-id>/…` on our own origin
// first (drop the ONNX files into public/models/ to serve them from the app itself);
// when absent they're fetched once from the Hugging Face CDN and then persisted in
// the browser's Cache API, so even the CDN path only ever downloads once.

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

export const hasWebGpu = (): boolean => typeof navigator !== 'undefined' && 'gpu' in navigator;

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
  if (existing) return existing;

  const load = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // Prefer weights served by our own app; fall back to the hub + browser cache.
    env.allowLocalModels = true;
    env.localModelPath = '/models/';
    env.useBrowserCache = true;

    // Aggregate per-file progress events into one 0..1 number.
    const fileProgress = new Map<string, number>();
    const progress_callback = (info: { status?: string; file?: string; progress?: number }) => {
      if (!onProgress) return;
      if (info.status === 'progress' && info.file) {
        fileProgress.set(info.file, (info.progress ?? 0) / 100);
        const values = [...fileProgress.values()];
        onProgress({ progress: values.reduce((a, b) => a + b, 0) / values.length, status: 'downloading' });
      } else if (info.status === 'ready') {
        onProgress({ progress: 1, status: 'ready' });
      }
    };

    const asr = await pipeline('automatic-speech-recognition', id, {
      device: hasWebGpu() ? 'webgpu' : 'wasm',
      // q4 on GPU keeps VRAM small; q8 is the accuracy/speed sweet spot on WASM.
      dtype: hasWebGpu() ? 'q4' : 'q8',
      progress_callback
    });
    onProgress?.({ progress: 1, status: 'ready' });
    return asr as unknown as AsrPipeline;
  })();

  pipelines.set(id, load);
  load.catch(() => pipelines.delete(id)); // allow retry after a failed download
  return load;
};

/** True once the model is loaded in this session (no download needed to start). */
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
