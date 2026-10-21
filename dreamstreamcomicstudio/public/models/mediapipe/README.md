# MediaPipe vision models — baby-monitor smart vision (beta)

Google MediaPipe Tasks models, unchanged, run on the baby monitor's camera device
in the browser by `live/monitor/sceneAi.ts` (`@mediapipe/tasks-vision` 1.0.1):

| File | Model | Source | SHA-256 |
|---|---|---|---|
| `efficientdet_lite0-int8-v1.tflite` | Object detector, EfficientDet-Lite0, int8, 80 COCO classes | `storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/` | `0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb` |
| `pose_landmarker_lite-v1.task` | Pose landmarker (BlazePose lite), 33 points, float16 | `storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/` | `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a` |

- Licence: Apache 2.0 (see `LICENSE`), Google LLC. COCO labels: CC BY 4.0.
- Both hashes are checked before a model runs; a mismatch turns smart vision off.
- Video frames never leave the camera phone — only conclusions do (see
  `docs/features/baby-monitor.md` → Smart vision).
- Bump the file name (`-v2`) when replacing a model so cached copies are never mixed up.
