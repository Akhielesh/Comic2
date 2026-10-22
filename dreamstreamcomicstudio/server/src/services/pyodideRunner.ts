// Sandboxed Python execution via Pyodide (CPython compiled to WASM), run inside a
// dedicated worker thread.
//
// The AI authors Python; THIS module runs it deterministically. Two properties matter
// and the OLD design (one Pyodide instance on the main event-loop thread, default
// `jsglobals: globalThis`) violated both:
//
//   1. ISOLATION. With the default `jsglobals`, Python's `import js` exposed the host's
//      `globalThis` — i.e. `process.env` (every backend secret/API key), `require`, and
//      the host filesystem — and reused globals leaked one caller's variables into the
//      next caller's run. Here Python runs in a worker whose `process.env` is scrubbed to
//      an infra-only allowlist (no secrets), `jsglobals` is a curated set of harmless
//      built-ins (no `process`/`require`/`module`), and every run executes in a FRESH
//      Python namespace, so nothing a script defines survives into the next one.
//
//   2. LIVENESS. Pyodide runs Python synchronously; a tight loop (`while True: pass`) or a
//      native C loop pins the thread it runs on. On the main thread that froze the whole
//      backend for every user and no timer could fire to stop it. In a worker the main
//      thread stays free: it raises KeyboardInterrupt via the shared interrupt buffer at
//      the soft deadline and, if the worker is still stuck past a hard deadline, calls
//      `worker.terminate()` and respawns a clean one on the next call.
//
// Residual risk (documented in docs/infrastructure/SECURITY_FINDINGS.md): a determined
// escape could still reach the worker's own realm, but that realm has no secrets in its
// env and no application state — it is a throwaway with a kill switch, not the backend.
//
// COST: one worker is loaded lazily and reused (Pyodide load is ~10-30s and packages
// fetch wheels from a CDN). We deliberately do NOT eagerly preload numpy/Pillow/pandas:
// Pyodide's WASM linear memory never shrinks once allocated, so preloading pandas would
// permanently pin ~500MB to the always-on container. Packages load on demand per run via
// `loadPackagesFromImports`, so a script that never touches pandas never pays for it.

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
// Grace between the soft interrupt (KeyboardInterrupt) and a hard worker.terminate().
const HARD_KILL_GRACE_MS = 2_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024; // 20MB total cap across all produced files
const INIT_TIMEOUT_MS = 90_000; // first load pulls CPython/WASM; be generous

export interface RunPythonFile {
  name: string;
  bytes: Uint8Array;
}

export interface RunPythonOutput {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface RunPythonResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  outputs: RunPythonOutput[];
  error?: string;
}

// Env vars safe to forward to the Python worker: infra/proxy/locale only. Everything
// else (API keys, DB creds, tokens — anything secret) is withheld so a sandbox escape
// reads nothing useful out of `process.env`.
const SAFE_ENV = /^(PATH|HOME|LANG|LANGUAGE|LC_[A-Z]+|TZ|TMPDIR|TEMP|TMP|PWD|HTTPS?_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_(FILE|DIR)|npm_config_https?_proxy)$/i;

const safeEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && SAFE_ENV.test(k)) out[k] = v;
  }
  return out;
};

// Imports we refuse outright: PyMuPDF/fitz is AGPL (license hazard) and not a real
// Pyodide package anyway. Reject early with a clear message instead of a CDN miss.
const BANNED_IMPORT = /(^|\n)\s*(?:import\s+(?:fitz|pymupdf)\b|from\s+(?:fitz|pymupdf)\b)/;

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  csv: 'text/csv',
  json: 'application/json',
  txt: 'text/plain'
};

const mimeForName = (name: string): string => {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return EXT_MIME[ext] || 'application/octet-stream';
};

// The worker program. Runs as CommonJS (eval:true) so `require('pyodide')` works both
// under tsx in dev and in the esbuild single-file bundle (where pyodide is external and
// installed in the image). It owns the Pyodide FS and does all staging/collection; the
// main thread only schedules, times out, and copies bytes across the postMessage bridge.
const WORKER_SRC = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { loadPyodide } = require(workerData.pyodidePath);

// Swallow the late KeyboardInterrupt artifact Pyodide can emit after an interrupted
// run resolves; the run handler already reported the error and the worker is recycled.
process.on('unhandledRejection', () => {});

const INPUT_DIR = '/input';
const OUTPUT_DIR = '/output';
const MAX_OUTPUT_BYTES = workerData.maxOutputBytes;

// Curated js-bridge globals: harmless built-ins only. No process/require/module/global,
// so Python's \`import js\` cannot reach host env, the filesystem, or the network.
const JSGLOBALS = {
  Object, Array, String, Number, Boolean, Math, JSON, Date, RegExp, Map, Set,
  Promise, Error, TextEncoder, TextDecoder, ArrayBuffer, Uint8Array, Uint8ClampedArray,
  Int8Array, Int16Array, Int32Array, Uint16Array, Uint32Array, Float32Array, Float64Array,
  DataView, console, setTimeout, clearTimeout
};

const baseName = (name) => {
  const cleaned = String(name || '').replace(/\\/g, '/');
  const last = cleaned.slice(cleaned.lastIndexOf('/') + 1).trim();
  return last || 'file';
};

const resetDir = (fs, dir) => {
  if (fs.analyzePath(dir).exists) {
    for (const entry of fs.readdir(dir)) {
      if (entry === '.' || entry === '..') continue;
      try { fs.unlink(dir + '/' + entry); } catch {}
    }
    try { fs.rmdir(dir); } catch {}
  }
  fs.mkdir(dir);
};

let py;

const SILENCE = { batched: () => {} };

(async () => {
  py = await loadPyodide({ jsglobals: JSGLOBALS });
  // Neutralize the default stdout/stderr: in a worker thread Node's fd-backed writer
  // throws (the worker's stdout has no real fd). Per-run capture is installed below.
  py.setStdout(SILENCE);
  py.setStderr(SILENCE);
  py.setInterruptBuffer(workerData.interruptBuffer);
  parentPort.postMessage({ type: 'ready' });
})().catch((err) => {
  parentPort.postMessage({ type: 'init-error', error: (err && err.message) || String(err) });
});

parentPort.on('message', async (msg) => {
  if (!msg || msg.type !== 'run') return;
  const fs = py.FS;
  let stdout = '';
  let stderr = '';
  let error;
  const outputs = [];

  // Stage input files and a clean /output BEFORE capturing stdout (package-loader logs
  // write to the real console, not the script's captured stdout).
  resetDir(fs, INPUT_DIR);
  resetDir(fs, OUTPUT_DIR);
  for (const f of msg.files || []) {
    try { fs.writeFile(INPUT_DIR + '/' + baseName(f.name), f.bytes); } catch {}
  }
  // Keep stdout/stderr silenced across the package load (its "Loading X" logs would
  // otherwise hit the invalid fd), then install the capturing handlers for the run.
  try { await py.loadPackagesFromImports(msg.code); } catch {}

  py.setStdout({ batched: (s) => { stdout += s + '\n'; } });
  py.setStderr({ batched: (s) => { stderr += s + '\n'; } });

  // Fresh namespace per run: nothing a prior caller defined is visible here.
  const ns = py.toPy({});
  try {
    await py.runPythonAsync(msg.code, { globals: ns });
  } catch (err) {
    error = (err && err.message) || String(err);
  } finally {
    try { ns.destroy(); } catch {}
    // Back to silence so the next run's package load can't hit the invalid fd.
    py.setStdout(SILENCE);
    py.setStderr(SILENCE);
  }

  let totalBytes = 0;
  try {
    if (fs.analyzePath(OUTPUT_DIR).exists) {
      for (const entry of fs.readdir(OUTPUT_DIR)) {
        if (entry === '.' || entry === '..') continue;
        let bytes;
        try { bytes = new Uint8Array(fs.readFile(OUTPUT_DIR + '/' + entry, { encoding: 'binary' })); }
        catch { continue; }
        if (totalBytes + bytes.length > MAX_OUTPUT_BYTES) continue;
        totalBytes += bytes.length;
        outputs.push({ name: entry, bytes });
      }
    }
  } catch {}

  try { resetDir(fs, INPUT_DIR); } catch {}
  try { resetDir(fs, OUTPUT_DIR); } catch {}

  const interrupted = typeof error === 'string' && /KeyboardInterrupt/.test(error);
  parentPort.postMessage({ type: 'result', id: msg.id, stdout, stderr, error, outputs, interrupted });
});
`;

interface RunMessage {
  type: 'run';
  id: number;
  code: string;
  files: RunPythonFile[];
}

interface ResultMessage {
  type: 'result';
  id: number;
  stdout: string;
  stderr: string;
  error?: string;
  outputs: { name: string; bytes: Uint8Array }[];
  interrupted: boolean;
}

interface WorkerHandle {
  worker: Worker;
  ready: Promise<void>;
  interruptBuffer: Uint8Array;
  pending: Map<number, (msg: ResultMessage) => void>;
  /** Set when the worker is poisoned (init/exit error or an interrupted run) → recycle. */
  dead: boolean;
}

const resolvePyodidePath = (): string => createRequire(import.meta.url).resolve('pyodide');

let handle: WorkerHandle | null = null;
let seq = 0;

function spawnWorker(): WorkerHandle {
  const interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
  const worker = new Worker(WORKER_SRC, {
    eval: true,
    env: safeEnv(), // scrubbed: no secrets reach the sandbox
    workerData: { pyodidePath: resolvePyodidePath(), interruptBuffer, maxOutputBytes: MAX_OUTPUT_BYTES },
    resourceLimits: { maxOldGenerationSizeMb: 512 }
  });
  const pending = new Map<number, (msg: ResultMessage) => void>();
  const h: WorkerHandle = { worker, ready: Promise.resolve(), interruptBuffer, pending, dead: false };

  h.ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Python runtime failed to start in time.')), INIT_TIMEOUT_MS);
    worker.once('message', (m: { type: string; error?: string }) => {
      clearTimeout(timer);
      if (m?.type === 'ready') resolve();
      else reject(new Error(m?.error || 'Python runtime failed to start.'));
    });
  });

  worker.on('message', (m: ResultMessage) => {
    if (m?.type === 'result') h.pending.get(m.id)?.(m);
  });
  const fail = () => {
    h.dead = true;
    for (const resolve of h.pending.values()) {
      resolve({ type: 'result', id: -1, stdout: '', stderr: '', error: 'The Python runtime stopped unexpectedly.', outputs: [], interrupted: true });
    }
    h.pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => { if (code !== 0) fail(); });
  worker.unref(); // never keep the process alive on this worker alone

  return h;
}

async function getWorker(): Promise<WorkerHandle> {
  if (handle && !handle.dead) {
    try {
      await handle.ready;
      return handle;
    } catch {
      // init failed — fall through to respawn
    }
  }
  if (handle) {
    try { await handle.worker.terminate(); } catch { /* ignore */ }
  }
  handle = spawnWorker();
  await handle.ready;
  return handle;
}

async function recycle(h: WorkerHandle): Promise<void> {
  h.dead = true;
  if (handle === h) handle = null;
  try { await h.worker.terminate(); } catch { /* ignore */ }
}

// Serialize runs: one worker, one Pyodide instance with shared FS/sys.modules. Two
// concurrent runs would corrupt each other, so each call chains onto the previous one.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Run AI-authored Python in the sandbox. Input files land in `/input/<name>`; files the
 * code writes to `/output/` are returned as bytes with an inferred MIME type.
 */
export async function runPython(opts: {
  code: string;
  files?: RunPythonFile[];
  timeoutMs?: number;
}): Promise<RunPythonResult> {
  const run = async (): Promise<RunPythonResult> => {
    const empty = (error: string): RunPythonResult => ({ ok: false, stdout: '', stderr: error, outputs: [], error });

    if (BANNED_IMPORT.test(opts.code)) {
      return empty('The module “fitz” / “PyMuPDF” is not available in this sandbox.');
    }

    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));

    let h: WorkerHandle;
    try {
      h = await getWorker();
    } catch (err) {
      return empty(`The Python runtime could not start: ${(err as Error)?.message || 'unknown error'}.`);
    }
    h.interruptBuffer[0] = 0;

    const id = ++seq;
    const files = (opts.files ?? []).map((f) => ({ name: f.name, bytes: f.bytes }));

    const result = await new Promise<ResultMessage>((resolve) => {
      h.pending.set(id, (msg) => {
        clearTimeout(softTimer);
        clearTimeout(hardTimer);
        h.pending.delete(id);
        resolve(msg);
      });
      const softTimer = setTimeout(() => { h.interruptBuffer[0] = 2; }, timeoutMs);
      const hardTimer = setTimeout(() => {
        // Still stuck past the hard deadline (e.g. an un-interruptible native loop):
        // kill the worker and report a timeout. A fresh worker spawns on the next call.
        h.pending.delete(id);
        void recycle(h);
        resolve({ type: 'result', id, stdout: '', stderr: '', error: `Python execution timed out after ${timeoutMs}ms`, outputs: [], interrupted: true });
      }, timeoutMs + HARD_KILL_GRACE_MS);
      const payload: RunMessage = { type: 'run', id, code: opts.code, files };
      h.worker.postMessage(payload);
    });

    // A run that had to be interrupted may have left the interpreter in an odd state
    // (half-run async tasks). Throw the instance away so the next caller starts clean.
    if (result.interrupted && !h.dead) void recycle(h);

    const outputs: RunPythonOutput[] = result.outputs.map((o) => ({ name: o.name, mimeType: mimeForName(o.name), bytes: o.bytes }));
    let stderr = result.stderr || '';
    if (result.error && !stderr.includes(result.error)) {
      stderr += stderr && !stderr.endsWith('\n') ? '\n' : '';
      stderr += result.error;
    }
    return { ok: !result.error, stdout: (result.stdout || '').trimEnd(), stderr: stderr.trimEnd(), outputs, error: result.error };
  };

  const result = queue.then(run, run);
  queue = result.then(() => undefined, () => undefined);
  return result;
}
