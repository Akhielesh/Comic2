# Voice dictation (on-device Whisper)

Dictation transcribes speech **fully in the browser** with open-source Whisper via
transformers.js — WebGPU when available, WASM otherwise. Audio never leaves the
device; no API key or inference service is involved. A browser-native Web Speech
engine is offered as the "instant" alternative. (Short readme:
`services/dictation/README.md`; this is the full doc.)

## Architecture

```
DictationButton (composer UI)
   └─ useDictation (state machine, settings, partials)
        ├─ engine 'whisper'
        │    ├─ recorder.ts   mic → mono Float32 PCM @16 kHz (+ level meter)
        │    └─ whisperEngine.ts  transformers.js ASR pipeline (WebGPU q4 / WASM q8)
        └─ engine 'webspeech'
             └─ window.SpeechRecognition (browser cloud service)
ChatComposer — inserts partial/final text into the draft
```

### Recorder — `services/dictation/recorder.ts`

- `startPcmRecorder(onLevel?)` opens the mic with echo cancellation / noise
  suppression / mono (`recorder.ts:39-42`), pipes it through a `ScriptProcessorNode`
  and linear-interpolation-resamples every block to **16 kHz** (Whisper's native
  rate) into a growing Float32 buffer (`recorder.ts:18-30`, `52-64`). No
  MediaRecorder containers, no decode step.
- `ScriptProcessorNode` is deprecated but universally supported; an AudioWorklet adds
  a module round-trip for no quality gain at dictation workloads (`recorder.ts:49-51`).
  The node is wired through a zero-gain sink so the mic isn't echoed to the speakers
  (`recorder.ts:66-70`).
- API: `snapshot()` (audio so far — enables partials), `duration()`, `stop()`
  (releases the mic, returns the final buffer) (`recorder.ts:6-13`).
- `onLevel` receives 0..1 RMS loudness ~every 50 ms for the live waveform
  (`recorder.ts:59-63`).

### Engine — `services/dictation/whisperEngine.ts`

- Models: `onnx-community/whisper-{tiny,base,small}` (`whisperEngine.ts:18-22`).
- `loadWhisper(size, onProgress?)` lazily `import('@huggingface/transformers')`
  (`whisperEngine.ts:44`) and builds an ASR pipeline with
  `device: webgpu | wasm`, `dtype: 'q4'` on GPU (small VRAM) / `'q8'` on WASM
  (accuracy/speed sweet spot) (`whisperEngine.ts:63-68`). In-flight loads are shared
  via a promise map; a failed download is evicted so retry works
  (`whisperEngine.ts:26`, `73-75`).
- Per-file download progress events are aggregated into one 0..1 number
  (`whisperEngine.ts:51-61`).
- `transcribe(asr, audio)` chunks long takes (`chunk_length_s: 30`,
  `stride_length_s: 5`) so dictation isn't capped at 30 s, and skips audio under
  0.1 s (`whisperEngine.ts:85-94`). Language is auto-detected; Whisper adds
  punctuation/casing itself.

## Engines + fallback

`hooks/useDictation.ts:11-22` defines the two engines:

- **`whisper` (default)** — private, on-device. First use downloads the model once
  (progress surfaced); afterwards it starts instantly from cache.
- **`webspeech`** — the browser's built-in `SpeechRecognition`
  (`useDictation.ts:173-218`): instant and natively streamed, but Chrome routes audio
  through Google's servers — offered as the "instant" option, never the default.
  Errors steer the user back to Whisper ("Speech recognition failed — try on-device
  Whisper instead", `useDictation.ts:197-204`).

Settings load defends against unavailability: `webspeech` is only honored if the
browser supports it, otherwise it falls back to `whisper`; the model falls back to
`base` (`useDictation.ts:40-50`). `voiceInputSupported()` (mic + AudioContext,
`recorder.ts:32-33`) gates the whole button — unsupported browsers render nothing
(`components/chat/DictationButton.tsx:80`).

## Live partials (4-second re-transcribe)

Whisper has no native streaming, so partials are faked by **re-transcribing the
accumulated take** on an interval (`PARTIAL_INTERVAL_MS = 4000`,
`useDictation.ts:32`):

- Every 4 s, `recorder.snapshot()` is transcribed and delivered via `onPartial`
  (`useDictation.ts:125-138`). Each partial **replaces** the previous one (it's the
  whole take so far, not a delta).
- A `partialBusyRef` guard skips a tick if the previous pass is still decoding (long
  takes decode slower than the interval) — passes never overlap
  (`useDictation.ts:126-136`).
- On stop, the hook waits out any in-flight partial pass, then transcribes the full
  final buffer and delivers `onFinal` (`useDictation.ts:149-169`).

The composer (`components/chat/ChatComposer.tsx:94-110`, `429-439`) snapshots the
draft when a take starts (`dictationBaseRef`) and splices `base + spoken` on every
partial/final — streamed partials replace only the dictated segment, never clobbering
typed text.

## Settings persistence

`{ engine, model }` persists in localStorage key **`ds.dictation.v1`**
(`useDictation.ts:31`, write at `:76-83`, validated read at `:40-50`). The settings
menu (chevron next to the mic) offers the engine choice plus three Whisper sizes:
tiny "Fast ~40 MB", base "Balanced ~80 MB" (recommended/default), small "Accurate
~250 MB" (`DictationButton.tsx:25-46`).

## Model self-hosting under `public/models/`

`whisperEngine.ts:45-48` sets:

```ts
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useBrowserCache = true;
```

Weights placed under `public/models/<model-id>/…` are served by the app itself and
the Hugging Face CDN is never contacted. Expected layout (file names must match what
transformers.js requests for the chosen dtype — copy from the browser network tab or
the HF repo):

```
public/models/onnx-community/whisper-base/
  config.json  generation_config.json  tokenizer.json  tokenizer_config.json
  preprocessor_config.json
  onnx/encoder_model_quantized.onnx  onnx/decoder_model_merged_quantized.onnx
```

Without local files, the model downloads once from the CDN and persists in the
browser **Cache API**, so later sessions are instant and offline-capable either way.
(As of this writing `public/models/` is not populated — the CDN+cache path is live.)

## Permissions-Policy change

The API's security headers previously sent `microphone=()` (deny all). Dictation
requires in-page capture, so the policy is now
`camera=(), geolocation=(), microphone=(self)`
(`server/src/middleware/security.ts:21-23`) — mic access allowed for same-origin
documents only, still denied to embedded third-party frames.

## UI states — `components/chat/DictationButton.tsx`

Status machine: `idle → starting → recording → transcribing → idle`, plus `error`
(`useDictation.ts:24`).

- **Idle**: quiet mic button; a chevron opens the engine/model menu (`:86-125`).
- **Downloading** (first Whisper use): floating glass bar with percent + "One-time
  download, then it's instant & offline", cancellable (`:137-149`).
- **Recording**: red ping dot, 5-bar live level meter, `m:ss` timer, engine tag,
  ✕ discard / ✓ finish (`:150-176`). Mic icon pulses; clicking it finishes the take.
- **Transcribing**: spinner + "Transcribing on-device…" (`:132-136`).
- **Error**: red toast above the composer with the message (`:180-186`).

`cancel()` discards everything (sets `cancelledRef` so late async results are dropped,
`useDictation.ts:235-241`); `stop()` finalizes and inserts text.

## Failure modes

| Failure | Behavior |
|---|---|
| Mic permission denied | `NotAllowedError` mapped to "Microphone access was denied. Allow the mic in your browser settings to dictate." (`useDictation.ts:143-145`; webspeech equivalent `:200-202`). |
| Model download fails / offline | `startWhisper` catch → generic "Could not start dictation…" error; the failed pipeline promise is evicted (`whisperEngine.ts:74`) so the next attempt re-downloads. |
| Final transcription fails | "Transcription failed. Try again." — the audio take is lost (`useDictation.ts:164-167`). |
| Partial pass fails | Silently ignored; partials are best-effort (`useDictation.ts:132-134`). |
| No Web Speech support | Engine option hidden (`DictationButton.tsx:90`); if somehow selected, error suggests Whisper (`useDictation.ts:178-182`). |
| No mic / no AudioContext | Button doesn't render at all (`DictationButton.tsx:80`). |

## Bundle impact

`@huggingface/transformers` is **dynamically imported** inside `loadWhisper`
(`whisperEngine.ts:44`), so Vite splits it into its own lazy chunk — the chat bundle
pays nothing until dictation is first used. Model weights are runtime fetches (Cache
API / `public/models/`), never part of the JS bundle. The recorder and hook are tiny
and statically imported.
