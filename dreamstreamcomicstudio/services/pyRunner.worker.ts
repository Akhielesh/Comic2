/**
 * Web Worker: the Python playground's interpreter (Pyodide), off the main thread.
 *
 * A same-origin MODULE worker — Vite builds this file to /assets/pyRunner.worker-<hash>.js — and
 * everything it loads comes from our own origin: the pinned runtime under /pyodide/<version>/
 * (services/pyodideRuntime.ts). There is deliberately no CDN and no fallback to one: no
 * third-party script may run in our origin unpinned, and a runtime that cannot be loaded from us
 * fails with a message instead of being fetched from somewhere else.
 * tests/edge/pyodideRuntime.test.ts keeps this file free of any other origin.
 */
import { PYODIDE_RUNTIME_BASE, PYODIDE_RUNTIME_PIN, pyodideRuntimePath } from './pyodideRuntime';
import type { PyWorkerMessage } from './pyRunner';

/** Types only: the loader itself is imported at run time from the pinned folder, never bundled. */
type PyodideModule = typeof import('pyodide');
type Pyodide = Awaited<ReturnType<PyodideModule['loadPyodide']>>;

type Scope = {
  postMessage(m: PyWorkerMessage): void;
  onmessage: ((e: MessageEvent<string>) => void) | null;
  location: { href: string };
};
const scope = self as unknown as Scope;

/** Absolute, on this worker's own origin: Pyodide resolves its files against these. */
const here = (path: string): string => new URL(path, scope.location.href).href;

let runtime: Promise<Pyodide> | null = null;

const loadRuntime = (): Promise<Pyodide> => {
  if (!runtime) {
    const loading = (async () => {
      const loaderUrl = here(pyodideRuntimePath('pyodide.mjs'));
      const { loadPyodide } = (await import(/* @vite-ignore */ loaderUrl)) as PyodideModule;
      const base = here(PYODIDE_RUNTIME_BASE);
      // Every URL spelled out, so nothing falls back to Pyodide's default (a public CDN):
      // pyodide.asm.mjs + pyodide.asm.wasm come from indexURL, packages from packageBaseUrl.
      const py = await loadPyodide({
        indexURL: base,
        lockFileURL: here(pyodideRuntimePath('pyodide-lock.json')),
        stdLibURL: here(pyodideRuntimePath('python_stdlib.zip')),
        packageBaseUrl: base,
      });
      if (py.version !== PYODIDE_RUNTIME_PIN.version) {
        throw new Error(`Python runtime ${py.version} is not the pinned ${PYODIDE_RUNTIME_PIN.version}`);
      }
      return py;
    })();
    runtime = loading;
    // A failed load is not kept: the next run tries again (a dropped connection, a deploy in flight).
    loading.catch(() => {
      if (runtime === loading) runtime = null;
    });
  }
  return runtime;
};

scope.onmessage = async (e) => {
  let py: Pyodide;
  try {
    py = await loadRuntime();
  } catch {
    scope.postMessage({ type: 'load-error', text: 'Could not load the Python runtime — check your connection and try again.' });
    return;
  }
  scope.postMessage({ type: 'ready' });
  py.setStdout({ batched: (s: string) => scope.postMessage({ type: 'log', level: 'log', text: s }) });
  py.setStderr({ batched: (s: string) => scope.postMessage({ type: 'log', level: 'error', text: s }) });
  try {
    await py.runPythonAsync(e.data);
    scope.postMessage({ type: 'done' });
  } catch (err) {
    const message = err && typeof (err as Error).message === 'string' ? (err as Error).message : String(err);
    scope.postMessage({ type: 'error', text: message });
  }
};
