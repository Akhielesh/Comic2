/**
 * Runs the smart-vision models on the camera phone: Google MediaPipe's
 * object detector (EfficientDet-Lite0, 80 COCO classes, int8) and pose
 * landmarker (BlazePose lite, 33 points), both Apache-2.0. Frames never leave
 * the phone; only the conclusions (see scene.ts) do.
 *
 * Models are served from our own site and refused unless their SHA-256
 * matches. The WebAssembly runtime is bundled from the pinned npm package.
 * Detector on the CPU (it's int8), pose on the GPU (WebGL) with a CPU
 * fallback; about one frame a second, slower if the phone struggles.
 */

import { FilesetResolver, ObjectDetector, PoseLandmarker } from '@mediapipe/tasks-vision';
import loaderSimd from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmSimd from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import loaderNoSimd from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.js?url';
import wasmNoSimd from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.wasm?url';
import type { Detection, SceneFrame } from './scene';

const MODELS = {
  detector: { url: '/models/mediapipe/efficientdet_lite0-int8-v1.tflite', sha256: '0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb' },
  pose: { url: '/models/mediapipe/pose_landmarker_lite-v1.task', sha256: '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a' },
};

export type SceneAiState = 'idle' | 'loading' | 'ready' | 'failed';

async function fetchVerified(url: string, sha256: string): Promise<Uint8Array> {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`model ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), (b) => b.toString(16).padStart(2, '0')).join('');
  if (hash !== sha256) throw new Error('model checksum mismatch');
  return buf;
}

export class SceneAi {
  state: SceneAiState = 'idle';
  private detector: ObjectDetector | null = null;
  private pose: PoseLandmarker | null = null;
  private lastTs = 0;
  /** Recent inference times, ms. */
  private costs: number[] = [];

  /** How long one frame takes on this phone (median of recent), ms. */
  get cost(): number {
    const s = [...this.costs].sort((a, b) => a - b);
    return s.length ? s[(s.length / 2) | 0] : 0;
  }

  async load(): Promise<boolean> {
    if (this.state === 'ready') return true;
    this.state = 'loading';
    try {
      const simd = await FilesetResolver.isSimdSupported();
      const fileset = { wasmLoaderPath: simd ? loaderSimd : loaderNoSimd, wasmBinaryPath: simd ? wasmSimd : wasmNoSimd };
      const [det, pose] = await Promise.all([fetchVerified(MODELS.detector.url, MODELS.detector.sha256), fetchVerified(MODELS.pose.url, MODELS.pose.sha256)]);
      const make = async (delegate: 'GPU' | 'CPU') => {
        // The detector is int8-quantized: built for the CPU (XNNPACK) path —
        // on the GPU delegate it returns nonsense. Pose (float16) uses the GPU.
        this.detector = await ObjectDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: det, delegate: 'CPU' },
          runningMode: 'VIDEO',
          scoreThreshold: 0.3,
          maxResults: 12,
        });
        this.pose = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: pose, delegate },
          runningMode: 'VIDEO',
          numPoses: 2,
          minPoseDetectionConfidence: 0.4,
          minPosePresenceConfidence: 0.4,
          minTrackingConfidence: 0.4,
        });
      };
      // Dev/testing: ds-scene-cpu=1 forces the CPU path (software-GPU browsers misread frames).
      let cpuOnly = false;
      try {
        cpuOnly = localStorage.getItem('ds-scene-cpu') === '1';
      } catch { /* storage unavailable */ }
      try {
        await make(cpuOnly ? 'CPU' : 'GPU');
      } catch {
        this.close();
        await make('CPU');
      }
      this.state = 'ready';
      return true;
    } catch {
      this.close();
      this.state = 'failed';
      return false;
    }
  }

  /** One frame (live video, or a still for evaluation) → detections + poses, normalized to the frame. */
  detect(video: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement): SceneFrame | null {
    if (this.state !== 'ready' || !this.detector || !this.pose) return null;
    const isVideo = video instanceof HTMLVideoElement;
    const w = isVideo ? video.videoWidth : video instanceof HTMLImageElement ? video.naturalWidth : video.width;
    const h = isVideo ? video.videoHeight : video instanceof HTMLImageElement ? video.naturalHeight : video.height;
    if (!w || !h || (isVideo && video.readyState < 2)) return null;
    const ts = Math.max(this.lastTs + 1, performance.now());
    this.lastTs = ts;
    const t0 = performance.now();
    try {
      const d = this.detector.detectForVideo(video, ts);
      const p = this.pose.detectForVideo(video, ts + 0.5);
      this.lastTs = ts + 0.5;
      const objects: Detection[] = (d.detections ?? [])
        .filter((x) => x.boundingBox && x.categories?.[0])
        .map((x) => ({
          label: x.categories[0].categoryName,
          score: x.categories[0].score,
          box: { x: x.boundingBox!.originX / w, y: x.boundingBox!.originY / h, w: x.boundingBox!.width / w, h: x.boundingBox!.height / h },
        }));
      const poses = (p.landmarks ?? []).map((pts) => pts.map((q) => ({ x: q.x, y: q.y, v: q.visibility ?? 0 })));
      this.costs = [...this.costs.slice(-9), performance.now() - t0];
      return { objects, poses };
    } catch {
      return null;
    }
  }

  close(): void {
    try {
      this.detector?.close();
      this.pose?.close();
    } catch { /* already closed */ }
    this.detector = null;
    this.pose = null;
  }
}
