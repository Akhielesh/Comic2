/**
 * Web Worker: runs Google's YAMNet sound classifier (ONNX, Apache-2.0) on the
 * nursery camera, off the main thread. Audio never leaves the phone.
 *
 * The model (16 MB) is served from our own origin only and cached by the
 * browser; the bytes must match the pinned SHA-256 before they're executed.
 * There is deliberately no third-party fallback (ADR 0006 WS-1): the page CSP
 * keeps connect-src to our own hosts, and a nursery's sound model never depends
 * on, or reveals the camera to, another company's CDN.
 */
import * as ort from 'onnxruntime-web/wasm';
import { YAMNET_CLASSES, scoreRows } from './soundClasses';

/** Same-origin and hash-pinned (tests/edge/supplyChain.test.ts keeps it that way). */
const MODEL_URL = '/models/yamnet/yamnet-v1.onnx';
const MODEL_SHA256 = 'd3835ffbbd4a1bb3e777f0ca217b5007907f5171dd5d17c4236b95b2af8f908e';
const CACHE_NAME = 'ds-monitor-models-v1';

type Scope = {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
};
const scope = self as unknown as Scope;

// Single-threaded WASM: no SharedArrayBuffer / cross-origin isolation needed.
ort.env.wasm.numThreads = 1;

let session: ort.InferenceSession | null = null;
let loading: Promise<void> | null = null;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function download(url: string): Promise<Uint8Array | null> {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok || !res.body) return null;
  const total = Number(res.headers.get('content-length')) || 16_093_355;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (got - lastReport > 512 * 1024) {
      lastReport = got;
      scope.postMessage({ t: 'progress', p: Math.min(0.99, got / total) });
    }
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  return bytes;
}

async function modelBytes(): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(MODEL_URL);
    if (hit) {
      const b = new Uint8Array(await hit.arrayBuffer());
      if ((await sha256Hex(b)) === MODEL_SHA256) return b;
      await cache.delete(MODEL_URL);
    }
  } catch {
    cache = null; // Cache API unavailable (private mode) — HTTP cache still helps
  }
  // Two tries at our own copy: a dropped connection mid-download (16 MB on a
  // phone) is the common failure, and the second try is usually served warm.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const b = await download(MODEL_URL);
      if (!b || (await sha256Hex(b)) !== MODEL_SHA256) continue;
      try {
        await cache?.put(MODEL_URL, new Response(b, { headers: { 'content-type': 'application/octet-stream' } }));
      } catch { /* quota — fine */ }
      return b;
    } catch { /* retry once */ }
  }
  throw new Error('The sound model could not be downloaded.');
}

async function load(): Promise<void> {
  const t0 = performance.now();
  const bytes = await modelBytes();
  session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  // Warm-up run so the first real hop isn't slow.
  await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(15_360), [15_360]) });
  scope.postMessage({ t: 'ready', ms: Math.round(performance.now() - t0) });
}

scope.onmessage = async (e: MessageEvent) => {
  const m = e.data as { t: 'load' } | { t: 'run'; id: number; wave: Float32Array };
  if (m.t === 'load') {
    loading ??= load().catch((err: unknown) => {
      loading = null;
      scope.postMessage({ t: 'failed', error: err instanceof Error ? err.message : String(err) });
    });
    return;
  }
  if (m.t === 'run') {
    if (!session) return scope.postMessage({ t: 'scores', id: m.id, cats: null });
    try {
      const t0 = performance.now();
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', m.wave, [m.wave.length]) });
      const data = out[session.outputNames[0]].data as Float32Array;
      const rows = Math.max(1, Math.floor(data.length / YAMNET_CLASSES));
      scope.postMessage({ t: 'scores', id: m.id, cats: scoreRows(data, rows), ms: Math.round(performance.now() - t0) });
    } catch (err) {
      scope.postMessage({ t: 'scores', id: m.id, cats: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
};
