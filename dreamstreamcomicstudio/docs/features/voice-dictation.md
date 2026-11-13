# Voice dictation (on-device Whisper)

Dictation transcribes speech **fully in the browser** with open-source Whisper via
transformers.js — WebGPU where the engine that runs has it and the device has a usable GPU,
WASM otherwise. Audio never leaves the
device; no API key or inference service is involved. The browser's own online
dictation (Web Speech) is offered as the instant alternative. (Short readme:
`services/dictation/README.md`; this is the full doc. It names functions, not line
numbers, so it does not go stale as the files change.)

## Architecture

```
DictationButton (composer UI: mic + settings caret, the take's bar, the error box)
   └─ useDictation (one take at a time: state, settings, partials, why it ended)
        ├─ engine 'whisper'
        │    ├─ recorder.ts       mic → mono Float32 PCM @16 kHz (+ level meter, track `ended` watch)
        │    └─ whisperEngine.ts  transformers.js ASR pipeline (WebGPU q4 / WASM q8)
        └─ engine 'webspeech'
             └─ window.SpeechRecognition (the browser's online speech service)
ChatComposer, DashboardsView — write partial/final text into their own input
StudioComposer (Comic Studio) — words wait in the bar, then go in at the cursor
```

### Recorder — `services/dictation/recorder.ts`

- `startPcmRecorder(onLevel?, { context, onEnded })` opens the mic with echo cancellation, noise suppression and
  mono, pipes it through a `ScriptProcessorNode` and resamples every block to **16 kHz** (Whisper's native rate)
  into a growing Float32 buffer. No MediaRecorder containers, no decode step.
- The node is wired through a zero-gain sink so the mic isn't echoed to the speakers.
- API: `snapshot()` (audio so far, for partials), `duration()`, `stop()` (releases the mic, returns the buffer).
- `onLevel` receives a 0..1 loudness about every 50 ms for the live waveform.
- `onEnded` fires when the **browser** ends a track (permission revoked in site settings, the device unplugged);
  never for our own `stop()`. The take then ends as `device` and keeps what was captured.
- `context` is the `AudioContext` made inside the tap (iOS starts audio only from a gesture). It stays suspended
  during the download and is resumed when the mic opens; one that will not start is the `audio-suspended` error.

### Engine — `services/dictation/whisperEngine.ts`

- Models: `onnx-community/whisper-{tiny,base,small}`, each fetched at **one fixed commit** (`WHISPER_MODELS`), never
  `main`. `main` moves (whisper-base changed on 2026-11-02); without a pin each browser would keep whatever the
  branch held at its first download.
  - **The pin is applied at the network, not with transformers.js's `revision` option.** Every Hub request
    transformers.js makes goes through its `env.fetch`; `pinHubFetch` wraps it so that any URL of these three
    repositories, at whatever revision, is asked for at the pinned commit (`pinnedModelUrl`). transformers.js itself
    still believes it loads `main`. That is deliberate: in 4.2.0 several of its own look-ups ignore the revision
    they are given and use `main` (`pipeline()`'s file list and file sizes, the tokenizer's "is there a
    `tokenizer_config.json`?" probe). With `revision` passed, those look-ups miss the cache on **every** load, so each
    take would ask Hugging Face for `main` again, and an offline take would fail outright (the probe cannot be
    answered, so no tokenizer is loaded). With one name for everything, a cached model needs no request at all,
    and no request ever names a branch (the e2e requires it).
  - **The cache says which commit it holds.** transformers.js stores the files under their `main` URLs, which do
    not say where the bytes came from, so `keepPinnedModelCache` keeps one small note per repository in the same
    cache (`…/resolve/main/.dreamstream-pinned-commit`) with the commit. Once per page, a model whose note is
    missing or names another commit has its note rewritten and its cached files dropped, so they are fetched again
    at the pin. Files cached before pins existed go the same way, once. If the note cannot be written, nothing is
    dropped.
  - To move a pin: read the new commit from `huggingface.co/api/models/<repo>`, check the q8 and q4 encoder and
    decoder sizes at it (`…/tree/<commit>/onnx`), update `MODEL_MB` if they changed, and change the constant in a
    reviewed commit. Browsers that hold the old files download the new ones once.
- `loadWhisper(size, onProgress?)` lazily imports `@huggingface/transformers` and builds an ASR pipeline with
  `device: webgpu | wasm` and `dtype: 'q4'` on GPU / `'q8'` on WASM. In-flight loads are shared (a take started
  after a cancel joins the same load and hears its progress); a failed download is evicted so retry works.
- **The device** (`whisperDevice`) is WebGPU only when both hold: the engine file transformers.js picked is the
  build with a WebGPU entry point (`ORT_WEBGPU_RUNTIME_MJS`, the asyncify build), and
  `navigator.gpu.requestAdapter()` answers with an adapter. Everything else is WASM. `'gpu' in navigator` alone
  (the old rule) is not enough: transformers.js gives Safari the plain build, which has no `webgpuInit`, and
  Safari 26 ships `navigator.gpu`, so every load failed there ("no available backend found … webgpuInit is not a
  function"); a browser with the API but no adapter failed too ("Failed to get GPU adapter"). The rule reads the
  pair transformers.js really picked, so there is no browser sniffing of our own in what runs.
- Per-file download progress is aggregated into one 0..1 number.
- `transcribe(asr, audio)` chunks long takes (`chunk_length_s: 30`, `stride_length_s: 5`) and skips audio under
  0.1 s. Language is auto-detected; Whisper adds punctuation and casing itself.
- `downloadMb(size, { device, runtime })`: the true one-time download, the model files plus the engine build that
  will run, rounded to 5 MB. By default it is what this browser will most likely use (`likelyVoiceSetup`): the
  plain engine and the WASM files on Safari (`picksPlainRuntime`, transformers.js's own Safari test, mirrored only
  for this number and pinned by a test), otherwise the asyncify engine with the WebGPU files when the browser has
  the API. It is an upper bound (no adapter means the smaller WASM files), so the copy says "up to about".

  | Size | Safari (plain engine, WASM) | WASM (asyncify engine) | WebGPU (asyncify engine) |
  |---|---|---|---|
  | Fast | 55 MB | 65 MB | 120 MB |
  | Balanced | 90 MB | 100 MB | 165 MB |
  | Accurate | 260 MB | 275 MB | 325 MB |

## Engines

- **`whisper` (default)** — private, on-device. The first use downloads the model once (progress shown); after
  that it starts from the browser's caches and works offline, for as long as the browser keeps both (see "What
  the browser keeps" below).
- **`webspeech`** — the browser's `SpeechRecognition`: instant and streamed, but the browser may send the voice
  to its speech service (Google in Chrome, Apple in Safari, Microsoft in Edge). Offered as the online choice,
  never the default.

`loadDictationSettings()` honours `webspeech` only where the browser has it (else `whisper`) and falls back to the
`base` model. `voiceInputSupported()` (mic API + AudioContext) gates the whole button: unsupported browsers render
nothing.

## Live partials (4-second re-transcribe)

Whisper has no native streaming, so partials re-transcribe the **whole take so far** every 4 s
(`PARTIAL_INTERVAL_MS`) and each partial replaces the previous one. A busy guard skips a tick while a pass is
still decoding, so passes never overlap. On stop the hook waits out any pass in flight, then transcribes the full
buffer once.

Chat Studio and Dashboards snapshot their draft when a take starts and splice `base + spoken` on every partial
and final. Comic Studio does not touch its box while you talk: the words heard so far show in the mic's bar
(`showHeard`; the newest two lines, `heardTail`), and the final words go in at the cursor (`insertSpoken` in
`StudioComposer.tsx`), so typing during a take is never overwritten.

## Settings

`{ engine, model }` persist in localStorage key **`ds.dictation.v1`** (read through `loadDictationSettings`,
written by `setSettings`). The settings (the caret next to the mic) offer "How it listens" (Private, on this
device · Browser dictation, online) and, for the private model, "Accuracy" with the true download per size on
this device (`downloadMb`). Choosing an engine also calls the caller's `onEngineChange`, so Comic Studio shows
its "Send when I tap Done" setting only while browser dictation is chosen.

## Where the downloads come from (one third-party host, the engine from our own site, no local `/models/` lookup)

The first use of the private model downloads two things, and the settings copy says where each comes from ("downloads
the voice model once from Hugging Face, and the voice engine from DreamStream"):

- **Hugging Face** (`huggingface.co`, which redirects to its CDN, `cas-bridge.xethub.hf.co` / `cdn-lfs*.hf.co`):
  the model weights (data, not code), at one fixed commit per size (`WHISPER_MODELS`, `pinHubFetch`).
  transformers.js keeps them in the browser **Cache API**. It is the only third-party host the private model
  contacts.
- **Our own site**, `/ort/<onnxruntime-web version>/` (`services/dictation/ortRuntime.ts`): the voice engine, the ONNX
  runtime (`ort-wasm-simd-threaded.asyncify.{mjs,wasm}`, about 23.6 MB; the plain build, about 13 MB, on Safari).
  The `.mjs` is code that runs in our origin next to the session, so it is never fetched from a third party, and
  the bytes we serve are pinned by SHA-256 in source (`ORT_RUNTIME_PIN`).

**How the engine is chosen and served.** transformers.js 4.2.0 picks the build itself when it is imported
(`src/backends/onnx.js` in `node_modules/@huggingface/transformers/dist/transformers.web.js`):

```js
if (!(typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope) && ONNX_ENV.versions?.web && !ONNX_ENV.wasm.wasmPaths) {
  const wasmPathPrefix = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNX_ENV.versions.web}/dist/`;
  ONNX_ENV.wasm.wasmPaths = apis.IS_SAFARI ? {
    mjs: `${wasmPathPrefix}ort-wasm-simd-threaded.mjs`,
    wasm: `${wasmPathPrefix}ort-wasm-simd-threaded.wasm`
  } : {
    mjs: `${wasmPathPrefix}ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${wasmPathPrefix}ort-wasm-simd-threaded.asyncify.wasm`
  };
}
```

So the choice is a `{ mjs, wasm }` pair keyed on transformers.js's own `IS_SAFARI` (Apple vendor, not
Chrome/Android/CriOS/FxiOS/EdgiOS/OPiOS/brave), never onnxruntime-web's: with a pair, onnxruntime-web imports exactly
`mjs` and loads exactly `wasm` (`importWasmModule(urlOverride, …)` and `locateFile` in its `wasm-factory.ts`). A string
prefix would instead let onnxruntime-web name the file from its build flags (always the asyncify build in the
`onnxruntime-web/webgpu` bundle transformers.js imports), which would change what Safari runs, so the page never sets
one. `pinOwnRuntime` (`whisperEngine.ts`), before the first `pipeline()`, keeps that pair's file names and moves only
the folder to `<origin><BASE_URL>ort/<__ORT_WEB_VERSION__>/`; it fails closed (the calm "didn't download" error,
nothing fetched) on anything else: no pair, a string, a file this build does not ship, halves of two builds, or an
engine of another version. It also sets `env.useWasmCache = false`, so transformers.js neither copies the engine's
code into its Cache API (where a script could rewrite it for every later page) nor turns it into a `blob:` script;
the browser imports the `.mjs` and fetches the `.wasm` from our origin and keeps them in its HTTP cache (immutable).

**Build, and the integrity pin.** `ortRuntime()` in `vite.config.ts` resolves onnxruntime-web from transformers.js's
own folder (the lockfile nests 1.26.0-dev under it; the app's own 1.30.0 is the sound model's), defines
`__ORT_WEB_VERSION__` as that version, and copies exactly the four files (`ORT_RUNTIME_FILES`) into
`<outDir>/ort/<version>/`, never into git. The engine is first-party code next to the session, so a version number
is not enough: `ORT_RUNTIME_PIN` (`ortRuntime.ts`) holds the version and the **SHA-256 of each file** as published
to npm (checked against the registry tarball, whose own hash is the lockfile's `integrity`). The build stops, and
emits none of the four, if the installed version is not the pinned one or transformers.js's own pin, if a file is
missing or is 25 MiB or more (the largest is 23.6 MB), or if a file's hash is not the pinned one (a stale, patched
or rewritten `node_modules`). A new transformers.js therefore needs the version and the four hashes changed in the
same reviewed commit, as the SRI pins in `services/legacyPdfLoader.ts` do. `vite dev` serves the same four files
from the package and `vite preview` from the build, with the production headers; both answer anything else under
`/ort/` with a 404 and refuse (500) a file whose bytes are not the pinned ones.

**Serving.** `/ort/*` goes through `functions/_middleware.ts` (`public/_routes.json` does not exclude it): every client
gets the file (no agent gate), with `Content-Type: text/javascript; charset=utf-8` or `application/wasm`,
`Cache-Control: public, max-age=31536000, immutable` (the path is versioned), `Cross-Origin-Resource-Policy:
same-origin` and `nosniff`, and **without** the `Access-Control-Allow-Origin: *` the Pages asset server adds to every
asset (CORP does not stop another site's CORS `import()` or `fetch()`; the page's own are same-origin on every
host). The middleware sets these itself, on a file it has checked:

- Only the four files of the **pinned version** are asked of the asset server. Any other path under `/ort/` (another
  version: an old tab after a deploy that moved the engine; a file this build does not ship) is a plain 404 with
  `no-store`, without asking it.
- What the asset server answers must be a file: a file status, not labelled HTML, and, whenever the answer carries the
  start of the file, **starting like the file** (the WebAssembly magic number `\0asm`; a module that does not begin
  with `<`). Pages answers a missing file with the SPA's `index.html` and a 200, which is what poisoned the model
  cache in F11, and it applies `public/_headers` to that fallback before the Function sees it: a `Content-Type` rule
  for `/ort/*.mjs` once made the page come back labelled as JavaScript, cached immutable for a year (seen with
  `wrangler pages dev`). So the label is not trusted, the first bytes are, and **`public/_headers` has no rule for
  `/ort` at all** (a test fails on one that names `Content-Type`, `Cache-Control` or a CORS grant).

The comics host proxies `/ort/*` to the Pages origin untouched. Tests: `services/dictation/whisperEngine.test.ts` (the
pair, Safari, fail-closed, the device rule, the model commits and the cache note, and the transformers.js source it
relies on: the selection names exactly these four files, `env.backends.onnx` shares onnxruntime-web's own `wasm`
object, the proxy worker is off, the Safari test, every Hub request goes through `env.fetch`),
`tests/edge/voiceRuntime.test.ts` (version = node_modules = pin = lockfile, the
hashes, a tampered engine stops the build, the emitted files, the middleware against the answers Pages really
gives, `_routes.json`, `_headers`, dev and preview) and `tests/e2e/studio.dictation.spec.ts` (a take requests the
engine from our origin only, as JavaScript and WebAssembly, and nothing but Hugging Face, answered there with
stand-ins, at a fixed commit; Safari's plain engine is never asked for WebGPU; the production CSP reports nothing
for the engine).

**What the browser keeps (the offline trade-off).** The weights live in the Cache API (transformers.js puts them
there). The engine lives only in the browser's **HTTP cache** (`immutable`, one year): with `env.useWasmCache = false`
no copy of the code is kept in the Cache API, on purpose, because a script that can write that cache could rewrite
the engine for every later page. Both are best-effort storage, and the HTTP cache is the one a browser trims first.
If the engine is evicted, the next take downloads it again (13 or 24 MB, no progress shown) and an offline take
fails with the calm "didn't download" error until the device is online once. A deploy that moves to a new
onnxruntime-web version has the same one-time cost. Within a session, once a take has run, later takes need no
network. The settings copy ("then it works offline") states the normal case; softening it is an owner's call.

Our own origin is never asked for model files. `loadWhisper` sets:

```ts
env.allowLocalModels = false;
env.useBrowserCache = true;
```

Why local lookup is off (production bug F11, fixed): it used to be on with `localModelPath = '/models/'`, so
transformers.js first asked our origin for `/models/onnx-community/whisper-*/config.json`. `public/models/` holds no
Whisper files, and the site's SPA fallback (`public/_redirects`: `/* /index.html 200`) answers a missing file with
`index.html`, HTTP **200** `text/html`, which the `/models/*` rule in `public/_headers` marks `immutable`.
transformers.js falls back to the hub only on a 404, so it parsed the HTML as JSON and the load failed. It also
stored that page in its cache under the local path, which it reads before the hub URL on every later load (even
with local models off). So, once per page before the first load, `dropStaleVoiceCache` deletes the
`transformers-cache` entries under our origin's `/models/onnx-community/`, and the copies of the jsDelivr engine
(about 24 MB of code) that older builds let transformers.js keep there (the real weights are cached under their
`huggingface.co` URLs and are kept). Tests: `services/dictation/whisperEngine.test.ts`.

Self-hosting the weights needs more than files in `public/models/`: the Pages limit is 25 MiB per file and the
decoders are larger (base q8 is 53.7 MB), so it waits for a read-only R2 lane, with local lookup turned back on and
SHA-256 pinning then (V-4).

**CSP (wave note).** The main site's policy is Report-Only (`functions/_middleware.ts` `mainCsp`, an inventory of
what enforcing would block). The engine now needs nothing beyond `'self'` and the `'wasm-unsafe-eval'` the policy
already has (a same-origin module import and fetch, no `blob:` script); the e2e sends that policy Report-Only on
the QA page and requires that a take reports no `script-src` or `worker-src` violation. Its `connect-src` does not
list Hugging Face, so the weights' download still files violation reports; that is expected, and enforcing the main
CSP before V-4 (ADR 0006 D6.5) would need `huggingface.co` and its CDN hosts in `connect-src`. Browser dictation is
unaffected.

**Downloads and Cancel.** Cancel, a hidden tab or leaving the page stops the take, and the mic never opens, but a
download already started keeps going in the background (up to the size shown) and is then cached for next time.
An abortable download is VOICE-A.

## Permissions-Policy

The API's security headers previously sent `microphone=()` (deny all). Dictation requires in-page capture, so the
policy is `camera=(), geolocation=(), microphone=(self)` (`server/src/middleware/security.ts`): mic access for
same-origin documents only, still denied to embedded third-party frames.

## Take lifecycle — the microphone is never left on (`hooks/useDictation.ts`)

- **One take, one id.** `start()` and `cancel()` bump the id; every async step (the model load, `getUserMedia`, the
  final decode) checks it when it resumes, and a step from a cancelled or replaced take stops whatever it opened
  and returns (a `getUserMedia` that resolves after a cancel has its tracks stopped at once).
- **Prepare, then open the mic.** Whisper loads the model first; the mic opens only after the load succeeds, so a
  failed or cancelled download never turns it on. Tapping the mic while it prepares cancels. While the browser
  then opens the mic (it may ask), `openingMic` is true and the bar says "Opening your microphone…" instead of
  "Your microphone stays off until it's ready."
- **One clean-up path** (`release`): stops the recorder and every track, aborts the recognition, clears every
  timer and listener, closes the audio context. Cancel, errors, a hidden tab, the 2-minute limit and unmount all
  run it. The recorder also stops its tracks if anything after `getUserMedia` fails.
- **Why a take ended** rides with the words: `onFinal(text, { end, engine })`, `end` one of `user` (Done), `escape`,
  `hidden` (tab in the background), `limit` (2 minutes from when the mic opened), `device` (the browser ended the
  mic: permission revoked, device unplugged), `engine` (the browser ended its own dictation, or never ended it
  after our stop). A caller that sends on its own checks `end === 'user'` (`services/dictation/autoSend.ts`).
- **Browser dictation:** after our stop the browser gets 2 s to end its session. If it never does, we end it: the
  words it had not finalized yet (which the bar showed) are kept, and the take ends as `engine`, so a shorter,
  different instruction can never go out by itself.

## UI — `components/chat/DictationButton.tsx`

- **Idle:** a quiet mic and a settings caret. The mic's title names the engine that will listen ("Voice typing ·
  private, on this device" / "… browser dictation, online").
- **Preparing:** "Getting voice typing ready… N%" and "Your microphone stays off until it's ready.", with Cancel;
  then "Opening your microphone…" and "Allow it if your browser asks." while the browser opens it.
- **Listening:** a live dot and "Listening", the timer, Discard and Done. The level meter shows for the private
  model only (the online engine gives us no level). Browser dictation says "online" at every width, since a phone
  shows no tooltip (one short word: the bar can be narrow in a side pane, and Done must stay in it). With `showHeard` (Comic Studio) the newest
  two lines of the words heard show in the bar (`aria-live="off"`), and a new take starts with an empty bar.
- **Done reads Send** when the caller passes `sendsOnDone` (Comic Studio's "Send when I tap Done" is on and can
  act) and the take is browser dictation: aria "Send the message", the mic "Finish and send". The private model
  never reads Send.
- **Writing it down:** "Writing down what you said…", with Discard (the words are dropped when the step ends).
- **Error:** one calm sentence and one action (Try again · Type instead), a Dismiss, and the technical detail (the
  code and the browser's error name) only behind "Show details" (`services/dictation/errors.ts`). A blocked mic
  says where to allow it and offers "Try again": once a site is blocked the browser asks nothing, so no button of
  ours can allow it.
- **Esc** while a take runs stops it and keeps the words; while the words are written down it is held and does
  nothing (a window capture listener, so a sheet underneath stays open either way).
- **Placement** (`dictationPlacement.ts`): every box sits next to the mic on the side the caller names (`align`:
  `end` by default, `start` in Comic Studio, whose mic is at the left), flips below the mic when there is clearly
  more room there (the Dashboards header), and is clamped 8 px inside the visual viewport and any clipping
  ancestor. A caller whose mic sits under its text box passes `stackAboveRef` (Comic Studio: the composer box),
  and the boxes open above that whole box (`placeVoiceBoxClearOf`), falling back to the mic where they do not fit.
  The boxes come after the mic in the DOM, so Tab from the caret reaches the open settings next. Tokens only
  (`Z.popover`, `OVERLAY`, `STATUS_*`). Checked in Chromium by `tests/e2e/studio.dictation.spec.ts` at 320, 390,
  768 and 1280 px (on screen, never over the text box, typing during a take kept, a second take starts empty).

## Failure modes

| Failure | Behavior |
|---|---|
| Mic blocked | "To talk, allow the microphone for this site in your browser's settings, then try again." · Try again. |
| No mic / mic busy / page policy | "No microphone was found on this device." / "Another app is using the microphone right now." / "Voice typing is turned off on this page." |
| Mic taken away mid-take (permission revoked, unplugged) | The take ends as `device`; what was captured goes in the box. |
| Model download fails / offline | "The voice model didn't download, so your microphone stayed off." · Try again. The failed load is evicted so a retry downloads again. |
| Final transcription fails | "Couldn't turn that into text, and nothing was sent." |
| Browser dictation: no speech, offline, Siri off, language | Each has its own sentence; words already heard are kept in the input. |
| Partial pass fails | Silently ignored; partials are best-effort. |
| No mic API / no AudioContext | The button doesn't render at all. |

Deferred (VOICE-A/B): announcements when a take starts or its words land, and the silence filter for the
private model's stock phrases on silence ("Thank you.").

## Bundle impact

`@huggingface/transformers` is **dynamically imported** inside `loadWhisper`, so Vite splits it into its own lazy
chunk: the chat bundle pays nothing until dictation is first used. Model weights and the ONNX runtime are runtime
fetches (above), never part of the JS bundle. The recorder and hook are tiny and statically imported. The build output
grows by the engine's four files under `/ort/<version>/` (36.6 MB, 4 files; 103.9 MB to 140.5 MB for `dist/` on
2026-11-12). Pages bandwidth is not metered, and each browser downloads only its own build, once (two requests
through the Pages Function per browser per engine version; the Function reads the first bytes and streams the rest). The transformers.js
chunk still carries onnxruntime-web's own fallback copy of the asyncify `.wasm` under `/assets/` (Vite emits it from
the bundle's `new URL(…, import.meta.url)`); it is never requested while `wasmPaths` is set, and dropping it is a
later, separate change.
