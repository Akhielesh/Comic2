# Voice dictation (on-device)

Dictation transcribes speech fully **in the browser** with open-source Whisper
(`onnx-community/whisper-{tiny,base,small}`) via `@huggingface/transformers` —
WebGPU when available, WASM otherwise. Audio never leaves the device; no API key
or external inference service is involved. A browser-native Web Speech engine is
offered as the "instant" alternative in the mic settings menu.

## Serving the model from our app (fully self-hosted)

`whisperEngine.ts` sets `env.localModelPath = '/models/'`, so weights placed under
`public/models/` are served by the app itself and the Hugging Face CDN is never
contacted. To pin a model in-app:

```
public/models/onnx-community/whisper-base/
  config.json  generation_config.json  tokenizer.json  tokenizer_config.json
  preprocessor_config.json
  onnx/encoder_model_quantized.onnx  onnx/decoder_model_merged_quantized.onnx
```

(Names must match what transformers.js requests for the chosen dtype; copy them
from the browser network tab or the HF repo.) Without local files, the model
downloads once from the CDN and is persisted in the browser Cache API, so every
later session is instant and offline-capable either way.

## Pieces

- `recorder.ts` — mic → mono Float32 PCM @16 kHz with a live level meter.
- `whisperEngine.ts` — lazy pipeline loader (q4 on WebGPU / q8 on WASM) + transcription.
- `hooks/useDictation.ts` — state machine (idle → recording → transcribing), live
  partial transcripts every ~4 s, settings persistence.
- `components/chat/DictationButton.tsx` — composer UI: mic button, recording bar
  with level meter/timer, engine + model picker.
