// Sandboxed Python execution via Pyodide (CPython compiled to WASM).
//
// The AI authors Python; THIS module runs it deterministically. Pyodide is memory-
// sandboxed: Python cannot reach the host filesystem or network (we never bridge
// them). Attached user files are written into an in-WASM `/input` dir; whatever the
// code writes to `/output` is collected back out as bytes.
//
// One Pyodide instance is loaded lazily and reused (loading is slow, ~10-30s the
// first time and packages fetch wheels from a CDN). Because there is a single
// instance with shared state, calls are serialized through a small promise queue.

import { loadPyodide, type PyodideInterface } from 'pyodide';

// Minimal structural view of Pyodide's Emscripten FS — enough for the ops we use,
// without depending on the ambient (untyped-in-this-config) `FS` global.
interface PyFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array | string, opts?: { encoding?: string }): void;
  readFile(path: string, opts?: { encoding?: 'binary' | 'utf8' }): Uint8Array;
  readdir(path: string): string[];
  unlink(path: string): void;
  rmdir(path: string): void;
  analyzePath(path: string): { exists: boolean };
}

const INPUT_DIR = '/input';
const OUTPUT_DIR = '/output';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024; // 20MB total cap across all produced files

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

let pyodidePromise: Promise<PyodideInterface> | null = null;

/**
 * Lazily load (and cache) the single Pyodide instance.
 *
 * COST NOTE: we deliberately do NOT eagerly preload numpy/Pillow/pandas here.
 * Pyodide's WASM linear memory never shrinks once allocated, so preloading pandas
 * (which pulls in numpy) permanently pinned ~500MB+ to the always-on server after a
 * single Python run — the dominant driver of the Railway memory bill. Packages are
 * now loaded on demand per run via `loadPackagesFromImports` (see runPython), so a
 * script that doesn't touch pandas never pays for it, and cold starts are faster.
 */
export function getPyodide(): Promise<PyodideInterface> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      return loadPyodide();
    })();
    // If load fails, allow a later retry rather than caching a rejected promise forever.
    pyodidePromise.catch(() => {
      pyodidePromise = null;
    });
  }
  return pyodidePromise;
}

// Serialize runs: a single Pyodide instance has shared global + FS state, so two
// concurrent runs would corrupt each other. Each call chains onto the previous one.
let queue: Promise<unknown> = Promise.resolve();

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

// Strip any directory components so an attachment named "../x" or "/etc/y" can't
// escape /input. (Pyodide is sandboxed regardless, but keep the tree tidy.)
const baseName = (name: string): string => {
  const cleaned = String(name || '').replace(/\\/g, '/');
  const last = cleaned.slice(cleaned.lastIndexOf('/') + 1).trim();
  return last || 'file';
};

const resetDir = (fs: PyFS, dir: string): void => {
  if (fs.analyzePath(dir).exists) {
    for (const entry of fs.readdir(dir)) {
      if (entry === '.' || entry === '..') continue;
      const full = `${dir}/${entry}`;
      try {
        fs.unlink(full);
      } catch {
        // best effort — nested dirs are unexpected here, ignore
      }
    }
    try {
      fs.rmdir(dir);
    } catch {
      /* ignore */
    }
  }
  fs.mkdir(dir);
};

/**
 * Run AI-authored Python in the sandbox. Input files land in `/input/<name>`; files
 * the code writes to `/output/` are returned as bytes with an inferred MIME type.
 */
export async function runPython(opts: {
  code: string;
  files?: RunPythonFile[];
  timeoutMs?: number;
}): Promise<RunPythonResult> {
  const run = async (): Promise<RunPythonResult> => {
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const py = await getPyodide();
    const fs = py.FS as unknown as PyFS;

    // Load ONLY the packages this script imports (numpy/pandas/Pillow/etc.), on demand.
    // Best-effort: if detection misses something, the script's own `import` raises a
    // normal ModuleNotFoundError that surfaces to the user — we don't preload the world.
    try {
      await py.loadPackagesFromImports(opts.code);
    } catch (err) {
      console.warn('[pyodideRunner] loadPackagesFromImports failed (continuing):', (err as Error)?.message);
    }

    let stdout = '';
    let stderr = '';
    let error: string | undefined;
    const outputs: RunPythonOutput[] = [];

    // Reset the working dirs and stage input files.
    resetDir(fs, INPUT_DIR);
    resetDir(fs, OUTPUT_DIR);
    for (const f of opts.files ?? []) {
      try {
        fs.writeFile(`${INPUT_DIR}/${baseName(f.name)}`, f.bytes);
      } catch (err) {
        console.warn(`[pyodideRunner] failed to stage input ${f.name}:`, (err as Error)?.message);
      }
    }

    // Capture stdout/stderr.
    py.setStdout({ batched: (s: string) => { stdout += s + '\n'; } });
    py.setStderr({ batched: (s: string) => { stderr += s + '\n'; } });

    // Interrupt-buffer timeout: setting ib[0] = 2 makes the next CPython opcode raise
    // KeyboardInterrupt, unwinding the running Python. It's cooperative (a tight C loop
    // inside a native extension may not check it), so we ALSO race a hard reject.
    const ib = new Uint8Array(new SharedArrayBuffer(1));
    py.setInterruptBuffer(ib);

    let softTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exec = py.runPythonAsync(opts.code);
      const hardReject = new Promise<never>((_, reject) => {
        softTimer = setTimeout(() => { ib[0] = 2; }, timeoutMs);
        hardTimer = setTimeout(() => reject(new Error(`Python execution timed out after ${timeoutMs}ms`)), timeoutMs + 2_000);
      });
      await Promise.race([exec, hardReject]);
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      error = msg;
      if (msg && !stderr.includes(msg)) stderr += msg.endsWith('\n') ? msg : msg + '\n';
    } finally {
      if (softTimer) clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
      ib[0] = 0;
      try { py.setInterruptBuffer(undefined as unknown as Uint8Array); } catch { /* ignore */ }
    }

    // Collect /output files (cap total bytes).
    let totalBytes = 0;
    try {
      if (fs.analyzePath(OUTPUT_DIR).exists) {
        for (const entry of fs.readdir(OUTPUT_DIR)) {
          if (entry === '.' || entry === '..') continue;
          const full = `${OUTPUT_DIR}/${entry}`;
          let bytes: Uint8Array;
          try {
            const read = fs.readFile(full, { encoding: 'binary' });
            // Copy out of the WASM heap so a later FS reset can't mutate these bytes.
            bytes = new Uint8Array(read);
          } catch {
            continue; // skip dirs / unreadable entries
          }
          if (totalBytes + bytes.length > MAX_OUTPUT_BYTES) {
            // Skip files that would blow the cap rather than truncating image bytes
            // (a truncated PNG is useless). Keep what fit.
            continue;
          }
          totalBytes += bytes.length;
          outputs.push({ name: entry, mimeType: mimeForName(entry), bytes });
        }
      }
    } catch (err) {
      console.warn('[pyodideRunner] failed to collect outputs:', (err as Error)?.message);
    }

    // Always clean up so the next run starts from a blank slate.
    try { resetDir(fs, INPUT_DIR); } catch { /* ignore */ }
    try { resetDir(fs, OUTPUT_DIR); } catch { /* ignore */ }

    return { ok: !error, stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), outputs, error };
  };

  // Chain onto the queue; a thrown error in one run must not break the chain.
  const result = queue.then(run, run);
  queue = result.then(() => undefined, () => undefined);
  return result;
}
