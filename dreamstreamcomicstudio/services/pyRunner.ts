// Run a learner's Python in a sandboxed Web Worker via Pyodide (CPython compiled to
// WASM). Real execution, real stdout/stderr, real Python tracebacks — the "small quick
// terminal with legit execution errors" for Python, mirroring the JS playground.
//
// Pyodide (~6 MB over the wire, 13.5 MB unpacked) is lazy-loaded on first run only (never part
// of the app bundle, so the app stays light) and kept warm in a persistent worker so later runs
// are fast. The worker has no DOM access; a hard timeout terminates runaway/infinite-loop code
// (which also drops the warm runtime, so the next run reloads — an acceptable trade for safety).
//
// Where the runtime comes from: our own origin, pinned by hash — /pyodide/<version>/, copied
// from the `pyodide` npm package at build time (services/pyodideRuntime.ts has the pin and the
// whole story). Nothing here, or in the worker, talks to a CDN.

import type { JsLogLine, JsRunResult } from './jsRunner';

/** What services/pyRunner.worker.ts posts back. */
export type PyWorkerMessage =
  | { type: 'ready' }
  | { type: 'log'; level: JsLogLine['level']; text: string }
  | { type: 'done' }
  | { type: 'error'; text: string }
  | { type: 'load-error'; text: string };

let worker: Worker | null = null;
let runtimeLoaded = false;

/** True once the Python runtime has loaded — lets the UI show a one-time "downloading" hint. */
export const isPythonRuntimeLoaded = (): boolean => runtimeLoaded;

// A same-origin module worker (a real file, not a blob: URL): the page's `worker-src 'self'`
// covers it, and it can import the runtime's ES modules from /pyodide/<version>/.
const getWorker = (): Worker => {
  if (!worker) worker = new Worker(new URL('./pyRunner.worker.ts', import.meta.url), { type: 'module' });
  return worker;
};

const killWorker = () => {
  try { worker?.terminate(); } catch { /* already gone */ }
  worker = null;
  runtimeLoaded = false; // a fresh worker must reload Pyodide
};

export const runPython = (code: string, timeoutMs = 15000): Promise<JsRunResult> =>
  new Promise((resolve) => {
    const logs: JsLogLine[] = [];
    let done = false;
    let w: Worker;
    try {
      w = getWorker();
    } catch {
      resolve({ logs, error: 'Could not start the Python runtime in this browser.' });
      return;
    }

    const finish = (extra: Partial<JsRunResult>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      w.onmessage = null;
      w.onerror = null;
      resolve({ logs, ...extra });
    };

    // The first run also downloads + initializes the runtime, so give it a much
    // larger budget; warm runs use the caller's (short) timeout.
    const effective = runtimeLoaded ? timeoutMs : Math.max(timeoutMs, 60000);
    const timer = setTimeout(() => {
      killWorker();
      finish({ timedOut: true, error: `Timed out after ${Math.round(effective / 1000)}s (possible infinite loop).` });
    }, effective);

    w.onmessage = (e: MessageEvent) => {
      const m = e.data as PyWorkerMessage;
      if (m.type === 'ready') runtimeLoaded = true;
      else if (m.type === 'log') logs.push({ level: m.level || 'log', text: m.text || '' });
      else if (m.type === 'error') finish({ error: m.text || 'Error' });
      else if (m.type === 'load-error') {
        // The runtime never came up: nothing is warm, and the next run starts from a clean worker.
        killWorker();
        finish({ error: m.text || 'Could not load the Python runtime.' });
      } else if (m.type === 'done') finish({});
    };
    w.onerror = (e: ErrorEvent) => {
      killWorker();
      finish({ error: e.message || 'Could not start the Python runtime — reload the page and try again.' });
    };
    w.postMessage(code);
  });
