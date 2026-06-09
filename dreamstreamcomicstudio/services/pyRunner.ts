// Run a learner's Python in a sandboxed Web Worker via Pyodide (CPython compiled to
// WASM). Real execution, real stdout/stderr, real Python tracebacks — the "small quick
// terminal with legit execution errors" for Python, mirroring the JS playground.
//
// Pyodide (~6MB) is lazy-loaded from a CDN on first run only (never bundled, so the app
// stays light) and kept warm in a persistent worker so subsequent runs are fast. The
// worker has no DOM access; a hard timeout terminates runaway/infinite-loop code (which
// also drops the warm runtime, so the next run reloads — an acceptable trade for safety).

import type { JsLogLine, JsRunResult } from './jsRunner';

// Pin a stable Pyodide release. Served from jsDelivr (same third-party-CDN posture the
// app already uses for map tiles / image results).
const PYODIDE_VERSION = 'v0.26.4';
const CDN = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

const WORKER_SRC = `
importScripts('${CDN}pyodide.js');
let ready;
const ensure = () => { if (!ready) ready = loadPyodide({ indexURL: '${CDN}' }); return ready; };
self.onmessage = async (e) => {
  let py;
  try { py = await ensure(); } catch (err) { self.postMessage({ type: 'error', text: 'Could not load the Python runtime — check your connection and try again.' }); return; }
  py.setStdout({ batched: (s) => self.postMessage({ type: 'log', level: 'log', text: s }) });
  py.setStderr({ batched: (s) => self.postMessage({ type: 'log', level: 'error', text: s }) });
  try {
    await py.runPythonAsync(e.data);
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', text: (err && err.message) ? String(err.message) : String(err) });
  }
};
`;

let worker: Worker | null = null;
let workerUrl: string | null = null;
let runtimeLoaded = false;

/** True once the Python runtime has loaded — lets the UI show a one-time "downloading" hint. */
export const isPythonRuntimeLoaded = (): boolean => runtimeLoaded;

const getWorker = (): Worker => {
  if (!worker) {
    workerUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' }));
    worker = new Worker(workerUrl);
  }
  return worker;
};

const killWorker = () => {
  try { worker?.terminate(); } catch { /* already gone */ }
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  worker = null;
  workerUrl = null;
  runtimeLoaded = false; // a fresh worker must reload Pyodide
};

export const runPython = (code: string, timeoutMs = 15000): Promise<JsRunResult> =>
  new Promise((resolve) => {
    const logs: JsLogLine[] = [];
    let done = false;
    const w = getWorker();

    const finish = (extra: Partial<JsRunResult>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      w.onmessage = null;
      w.onerror = null;
      resolve({ logs, ...extra });
    };

    // The first run also downloads + initializes the ~6MB runtime, so give it a much
    // larger budget; warm runs use the caller's (short) timeout.
    const effective = runtimeLoaded ? timeoutMs : Math.max(timeoutMs, 60000);
    const timer = setTimeout(() => {
      killWorker();
      finish({ timedOut: true, error: `Timed out after ${Math.round(effective / 1000)}s (possible infinite loop).` });
    }, effective);

    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; level?: JsLogLine['level']; text?: string };
      runtimeLoaded = true; // any message back means the runtime is up
      if (m.type === 'log') logs.push({ level: m.level || 'log', text: m.text || '' });
      else if (m.type === 'error') finish({ error: m.text || 'Error' });
      else if (m.type === 'done') finish({});
    };
    w.onerror = (e: ErrorEvent) => {
      killWorker();
      finish({ error: e.message || 'Python worker error' });
    };
    w.postMessage(code);
  });
