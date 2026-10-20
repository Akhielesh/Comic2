# YAMNet (ONNX) — baby-monitor sound model

`yamnet-v1.onnx` is Google's **YAMNet** audio event classifier (521 AudioSet
classes), in the ONNX export published at
[`audiomagic/yamnet-onnx`](https://huggingface.co/audiomagic/yamnet-onnx)
(a straight `tf2onnx` conversion of `google/yamnet` v1 — no weights changed).

- Licence: Apache 2.0 (see `LICENSE`). Copyright 2022 Google LLC.
- AudioSet ontology and labels: CC BY 4.0, Google.
- SHA-256: `d3835ffbbd4a1bb3e777f0ca217b5007907f5171dd5d17c4236b95b2af8f908e`
  (verified by `live/monitor/yamnet.worker.ts` before the model runs).

Used only on the baby monitor's camera device, in the browser, to recognise
nursery sounds (crying, fussing, coughing, babbling, alarms, bangs…). Audio is
never uploaded. Bump the file name (`-v2`) when replacing the model so cached
copies are never mixed up.
