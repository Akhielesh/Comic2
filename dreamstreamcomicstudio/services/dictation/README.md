# Voice dictation (on-device)

Dictation transcribes speech fully **in the browser** with open-source Whisper
(`onnx-community/whisper-{tiny,base,small}`) via `@huggingface/transformers` —
WebGPU when available, WASM otherwise. Audio never leaves the device; no API key
or external inference service is involved. A browser-native Web Speech engine is
offered as the "instant" alternative in the mic settings menu.

## Where the model comes from

The first use downloads the weights once from Hugging Face, and transformers.js keeps
them in the browser Cache API, so later sessions start from the cache and work offline.
`whisperEngine.ts` keeps transformers.js's local-model lookup **off**: our origin answers a
missing `/models/…` file with the app's `index.html` (HTTP 200), which used to break every
load (F11). It also drops any such page an older build cached. Self-hosting the weights
waits for an R2 lane (the Pages limit is 25 MiB per file; the decoders are larger). Full
doc: `docs/features/voice-dictation.md`.

## Pieces

- `recorder.ts` — mic → mono Float32 PCM @16 kHz with a live level meter.
- `whisperEngine.ts` — lazy pipeline loader (q4 on WebGPU / q8 on WASM) + transcription.
- `hooks/useDictation.ts` — state machine (idle → recording → transcribing), live
  partial transcripts every ~4 s, settings persistence.
- `components/chat/DictationButton.tsx` — composer UI: mic button, recording bar
  with level meter/timer, engine + model picker.
