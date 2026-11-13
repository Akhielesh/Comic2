# Voice dictation (on-device)

Dictation transcribes speech fully **in the browser** with open-source Whisper
(`onnx-community/whisper-{tiny,base,small}`) via `@huggingface/transformers` —
WebGPU where the engine that runs has it and the device has a usable GPU, WASM
otherwise. Audio never leaves the device; no API key
or external inference service is involved. A browser-native Web Speech engine is
offered as the "instant" alternative in the mic settings menu.

## Where the model comes from

The first use downloads the weights once from Hugging Face, the only third-party host, each size at one fixed commit
(`WHISPER_MODELS`, never `main`; pinned where the requests leave the page, `pinHubFetch`), and the voice engine (the ONNX runtime, about 24 MB, or 13 MB on Safari; code that
runs in the page) from our own site, `/ort/<onnxruntime-web version>/` (`ortRuntime.ts`; built by `vite.config.ts`
`ortRuntime()`, served by `functions/_middleware.ts`). The engine is pinned by version and by the SHA-256 of each
file (`ORT_RUNTIME_PIN`): the build stops if the bytes in `node_modules` are not the published ones. The settings copy
names both hosts. `whisperEngine.ts` `pinOwnRuntime` keeps transformers.js's own choice of build (plain on Safari,
asyncify elsewhere) and moves only its folder, before the first `pipeline()`, and fails closed on anything else;
`whisperDevice` asks for WebGPU only on the asyncify build (the plain one has none) with a real GPU adapter.
transformers.js keeps the weights in the browser Cache API, so later sessions start from the cache and work offline;
the engine is kept by the HTTP cache only (immutable; no code in the Cache API, on purpose), so a browser that trims
it downloads the engine again. `whisperEngine.ts` keeps transformers.js's local-model lookup **off**: our origin
answers a missing `/models/…` file with the app's `index.html` (HTTP 200), which used to break every load (F11). It
also drops any such page, and any jsDelivr engine, an older build cached. Self-hosting the weights waits for an R2 lane
(the Pages limit is 25 MiB per file; the decoders are larger). Full doc: `docs/features/voice-dictation.md`.

## Pieces

- `recorder.ts` — mic → mono Float32 PCM @16 kHz with a live level meter; says when the
  browser ends the mic itself (the take then ends as `device`).
- `whisperEngine.ts` — lazy pipeline loader (q4 on WebGPU / q8 on WASM) + transcription; points the engine at our
  copy, picks the device from the engine that will run, pins each model to a commit at the network (transformers.js's
  own look-ups ignore the revision they are given) and keeps a note in the cache of which commit it holds.
- `ortRuntime.ts` — the engine's four files, their version and SHA-256 pin, `/ort/<version>/`, their headers and the
  first-bytes check (shared by the page, the Pages middleware, the Vite plugin and the tests).
- `hooks/useDictation.ts` — state machine (idle → starting → recording → transcribing), live
  partial transcripts every ~4 s, settings persistence, why each take ended.
- `errors.ts` — every failure as one calm sentence and one action (Try again · Type instead).
- `autoSend.ts` — when a take may send itself: almost never (Done, browser dictation,
  English, chosen, not a removal).
- `components/chat/DictationButton.tsx` — composer UI: mic button, recording bar
  with level meter/timer, engine + model picker; its boxes stay on screen and, in Comic
  Studio, above the composer box (`dictationPlacement.ts`).
