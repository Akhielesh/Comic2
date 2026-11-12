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

Chat Studio and Dashboards snapshot their draft when a take starts (`dictationBaseRef`)
and splice `base + spoken` on every partial and final. Comic Studio does not touch its
box while you talk: the words heard so far show in the mic's bar (`showHeard`), and the
final words go in at the cursor (`insertSpoken` in `StudioComposer.tsx`), so typing
during a take is never overwritten.

## Settings persistence

`{ engine, model }` persists in localStorage key **`ds.dictation.v1`**
(`useDictation.ts:31`, write at `:76-83`, validated read at `:40-50`). The settings
menu (chevron next to the mic) offers the engine choice plus three Whisper sizes:
tiny "Fast ~40 MB", base "Balanced ~80 MB" (recommended/default), small "Accurate
~250 MB" (`DictationButton.tsx:25-46`).

## Where the weights come from (no local `/models/` lookup)

`loadWhisper` (`services/dictation/whisperEngine.ts`) sets:

```ts
env.allowLocalModels = false;
env.useBrowserCache = true;
```

The first use downloads the model once from Hugging Face (`huggingface.co`, which
redirects to its CDN), and transformers.js keeps the files in the browser **Cache API**,
so later sessions start from the cache and work offline. Our own origin is never asked
for model files.

Why local lookup is off (production bug F11, fixed): it used to be on with
`localModelPath = '/models/'`, so transformers.js first asked our origin for
`/models/onnx-community/whisper-*/config.json`. `public/models/` holds no Whisper files,
and the site's SPA fallback (`public/_redirects`: `/* /index.html 200`) answers a missing
file with `index.html`, HTTP **200** `text/html`, which the `/models/*` rule in
`public/_headers` marks `immutable`. transformers.js falls back to the hub only on a 404, so
it parsed the HTML as JSON and the load failed. It also stored that page in its cache under
the local path, which it reads before the hub URL on every later load. So, once per page
before the first load, `dropPoisonedModelCache` deletes the `transformers-cache` entries
under our origin's `/models/onnx-community/` (the real weights are cached under their
`huggingface.co` URLs and are kept). Tests: `services/dictation/whisperEngine.test.ts`.

Self-hosting the weights needs more than files in `public/models/`: the Pages limit is
25 MiB per file and the decoders are larger (base q8 is 53.7 MB), so it waits for a
read-only R2 lane, with local lookup turned back on and SHA-256 pinning then.

## Permissions-Policy change

The API's security headers previously sent `microphone=()` (deny all). Dictation
requires in-page capture, so the policy is now
`camera=(), geolocation=(), microphone=(self)`
(`server/src/middleware/security.ts:21-23`) — mic access allowed for same-origin
documents only, still denied to embedded third-party frames.

## Take lifecycle — the microphone is never left on (`hooks/useDictation.ts`)

- **One take, one id.** `start()` and `cancel()` bump the id; every async step (the model load, `getUserMedia`,
  the final decode) checks it when it resumes, and a step from a cancelled or replaced take stops whatever it
  opened and returns (a `getUserMedia` that resolves after a cancel has its tracks stopped at once).
- **Prepare, then open the mic.** Whisper loads the model first; the mic opens only after the load succeeds, so a
  failed or cancelled download never turns it on. Tapping the mic while it prepares cancels.
- **One clean-up path** (`release`): stops the recorder and every track, aborts the recognition, clears every
  timer and listener, closes the audio context. Cancel, errors, a hidden tab, the 2-minute limit and unmount all
  run it. The recorder (`recorder.ts`) also stops its tracks if anything after `getUserMedia` fails. The audio
  context is made inside the tap (iOS starts audio only from a gesture), kept quiet during the download and
  resumed when the mic opens; one that will not start is the `audio-suspended` error.
- **Why a take ended** rides with the words: `onFinal(text, { end, engine })`, `end` one of `user` (Done),
  `escape`, `hidden` (tab in the background), `limit` (2 minutes from when the mic opened), `engine` (the browser
  ended its own dictation). A caller that sends on its own checks `end === 'user'`.
- **Browser dictation:** after our stop the browser gets 2 s to end its session before we end it ourselves.

## UI — `components/chat/DictationButton.tsx`

- **Idle:** a quiet mic and a settings caret. The mic's title names the engine that will listen ("Voice typing ·
  private, on this device" / "… browser dictation, online").
- **Settings:** "How it listens" (Private, on this device · Browser dictation, online) and, for the private
  model, "Accuracy" with the true one-time download per size on this device (`downloadMb`: model plus runtime,
  rounded to 5 MB, an upper bound): Fast up to about 65 MB, Balanced 100 MB, Accurate 275 MB on WASM; 120, 165
  and 325 MB with WebGPU.
- **Preparing:** "Getting voice typing ready… N%" and "Your microphone stays off until it's ready.", with Cancel.
- **Listening:** a live dot and "Listening", the level meter, the timer, Discard and Done. With `showHeard` (Comic
  Studio) the words heard so far show in the bar (`aria-live="off"`) instead of being written into the input.
- **Writing it down:** "Writing down what you said…".
- **Error:** one calm sentence and one action (Try again · Allow microphone · Type instead), a Dismiss, and the
  technical detail (the code and the browser's error name) only behind "Show details"
  (`services/dictation/errors.ts`).
- **Esc** while a take runs stops it and keeps the words (a window capture listener, so a sheet underneath stays
  open).
- **Placement** (`dictationPlacement.ts`): every box sits next to the mic on the side the caller names (`align`:
  `end` by default, `start` in Comic Studio, whose mic is at the left), flips below the mic when there is clearly
  more room there (the Dashboards header), and is clamped 8 px inside the visual viewport and any clipping
  ancestor. Tokens only (`Z.popover`, `OVERLAY`, `STATUS_*`). Checked in Chromium by
  `tests/e2e/studio.dictation.spec.ts` at 320, 390, 768 and 1280 px.

## Failure modes

| Failure | Behavior |
|---|---|
| Mic blocked | "To talk, allow the microphone for this site in your browser's settings." · Allow microphone (asks again where the browser still can). |
| No mic / mic busy / page policy | "No microphone was found on this device." / "Another app is using the microphone right now." / "Voice typing is turned off on this page." |
| Model download fails / offline | "The voice model didn't download, so your microphone stayed off." · Try again. The failed load is evicted so a retry downloads again. |
| Final transcription fails | "Couldn't turn that into text, and nothing was sent." |
| Browser dictation: no speech, offline, Siri off, language | Each has its own sentence; words already heard are kept in the input. |
| Partial pass fails | Silently ignored; partials are best-effort. |
| No mic API / no AudioContext | The button doesn't render at all. |

## Bundle impact

`@huggingface/transformers` is **dynamically imported** inside `loadWhisper`
(`whisperEngine.ts:44`), so Vite splits it into its own lazy chunk — the chat bundle
pays nothing until dictation is first used. Model weights are runtime fetches (Cache
API), never part of the JS bundle. The recorder and hook are tiny
and statically imported.
