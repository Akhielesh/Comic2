/**
 * The Python runtime the browser runs (services/pyRunner.ts → services/pyRunner.worker.ts):
 * Pyodide — CPython compiled to WebAssembly — pinned, and served from our own origin only.
 *
 * The rule (owner): no unpinned third-party script may run in our origin. The playground used to
 * `importScripts('https://cdn.jsdelivr.net/pyodide/…')` inside a same-origin worker, so whatever
 * that CDN served for the path ran with the page's origin. Now:
 *
 *   source   the `pyodide` npm package — the SAME dependency the backend sandbox uses
 *            (server/src/services/pyodideRunner.ts), locked by package-lock.json's sha512;
 *   pin      PYODIDE_RUNTIME_PIN below: the version, and for each file the browser loads its
 *            SHA-256, size, content type and first bytes;
 *   build    `pyodideRuntime()` in vite.config.ts copies exactly these files to
 *            `/pyodide/<version>/` and STOPS the build when the installed version or any byte
 *            differs from the pin; it serves the same files in `vite dev` / `vite preview`;
 *   edge     `servePyodideRuntime` in functions/_middleware.ts is the only thing that answers
 *            under `/pyodide/`: the pinned version's files, checked by their first bytes, with
 *            the content type and immutable caching set there — anything else is a 404, never
 *            the SPA's index.html. public/_headers holds no rule for the folder and
 *            public/_routes.json must not exclude it (tests/edge/pyodideRuntime.test.ts).
 *
 * The same design as the private voice model's engine (services/dictation/ortRuntime.ts, /ort/),
 * and at the edge the very same code: both folders go through serveCheckedRuntimeFile.
 *
 * This module is dependency-free on purpose: the worker, the Vite config, the Pages Function and
 * the tests all import it.
 *
 * Updating Pyodide (one version for the browser AND the backend):
 *   1. set the new exact version of `pyodide` in package.json and run `npm install`;
 *   2. read the release notes, then run `npm run build`: it stops and prints the installed
 *      version, hashes, sizes and first bytes — copy them here only once you trust the release;
 *   3. `npx vitest run tests/edge/pyodideRuntime.test.ts`, and run Python in the app
 *      (tests/e2e/python.runtime.spec.ts does it in CI: the layout smoke on pull requests, the
 *      device matrix nightly).
 * The folder name carries the version, so a new version is a new URL: the year-long cache of the
 * old files never serves the new runtime.
 */

export interface PyodideRuntimeFile {
  /** SHA-256 of the whole file, lowercase hex. */
  sha256: string;
  /** Size in bytes. */
  bytes: number;
  /** The Content-Type it is served with (the server sets it; nothing is sniffed). */
  type: string;
  /** How the file begins, one character per byte (the edge checks this before serving). */
  starts: string;
}

/**
 * What the browser loads, and nothing else. `pyodide.mjs` is the loader the worker imports; it
 * imports `pyodide.asm.mjs`, then fetches the WebAssembly module, the standard library and the
 * package lock from the same folder. (`pyodide.js`, the classic-script build, is not shipped: the
 * worker is a module worker.) Checked on 2026-11-12: all five are byte-identical to the files of
 * the upstream v314.0.0 distribution, so the npm package and the release agree.
 *
 * The lock file lists Pyodide's optional packages (numpy, …) by file name. None of them is
 * shipped: the playground runs the standard library, and a package load resolves to this folder
 * and gets a 404 — it never reaches another host.
 */
export const PYODIDE_RUNTIME_PIN = {
  package: 'pyodide',
  version: '314.0.0',
  files: {
    'pyodide.mjs': {
      sha256: '3abfa8bfc2d1dc9d733f4b0b5c3b35bb469295e455abf13f5c0fac70a1c2e961',
      bytes: 17880,
      type: 'text/javascript; charset=utf-8',
      starts: 'var Q=Object.defineProperty',
    },
    'pyodide.asm.mjs': {
      sha256: '7808c4d7a9fee23a02b0c8b7bbd51b1358e8d41bbe89e5c0ee9c0c4db7b9328f',
      bytes: 1249764,
      type: 'text/javascript; charset=utf-8',
      starts: 'async function _createPyodideModule',
    },
    'pyodide.asm.wasm': {
      sha256: '4d23bd074cc536a96660c9168e223e3aaf01944096ad829737a9c87fec4b28eb',
      bytes: 9610179,
      type: 'application/wasm',
      starts: '\u0000asm\u0001\u0000\u0000\u0000',
    },
    'python_stdlib.zip': {
      sha256: '1215cd239a270c13a3ecb1a84c84b7b3241baf7ea7f54615f00d79ff69c82787',
      bytes: 2552165,
      type: 'application/zip',
      starts: 'PK\u0003\u0004',
    },
    'pyodide-lock.json': {
      sha256: 'f545248ab161ead36adf7110a358334974e97b08f40c7219e97077d380f7247b',
      bytes: 115407,
      type: 'application/json; charset=utf-8',
      starts: '{"info":',
    },
  },
} as const satisfies { package: string; version: string; files: Record<string, PyodideRuntimeFile> };

export type PyodideRuntimeFileName = keyof typeof PYODIDE_RUNTIME_PIN.files;

export const PYODIDE_RUNTIME_FILES = Object.keys(PYODIDE_RUNTIME_PIN.files) as PyodideRuntimeFileName[];

/** The folder only the pinned runtime lives under. */
export const PYODIDE_RUNTIME_ROOT = '/pyodide';

/** `/pyodide/<version>/` — the `indexURL` the worker gives Pyodide (always ends with a slash). */
export const PYODIDE_RUNTIME_BASE = `${PYODIDE_RUNTIME_ROOT}/${PYODIDE_RUNTIME_PIN.version}/`;

/** The path of one pinned file: `/pyodide/<version>/<file>`. */
export const pyodideRuntimePath = (file: PyodideRuntimeFileName): string => `${PYODIDE_RUNTIME_BASE}${file}`;

/**
 * How many leading bytes a server reads before it answers: room for the longest `starts`
 * (the build and tests/edge/pyodideRuntime.test.ts refuse a pin that needs more).
 */
export const PYODIDE_FIRST_BYTES = 64;

/**
 * Is this path inside the runtime folder at all — `/pyodide`, `/pyodide/…`, pinned or not?
 * A wide net on purpose (any letter case, percent-encoded, doubled or back slashes): whatever a
 * static server might fold onto the folder is claimed here, so it gets the pinned file or a 404
 * and never a file served some other way.
 */
export function isPyodideRuntimePath(pathname: string): boolean {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* malformed escapes: judge the raw path */
  }
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
  return p === PYODIDE_RUNTIME_ROOT || p.startsWith(`${PYODIDE_RUNTIME_ROOT}/`);
}

/**
 * The pinned file this path names, or null. Exact and case-sensitive: the pinned version's
 * folder and one of its file names, nothing decoded, nothing after it.
 */
export function pyodideRuntimeFileAt(pathname: string): PyodideRuntimeFileName | null {
  if (!pathname.startsWith(PYODIDE_RUNTIME_BASE)) return null;
  const name = pathname.slice(PYODIDE_RUNTIME_BASE.length);
  return (PYODIDE_RUNTIME_FILES as string[]).includes(name) ? (name as PyodideRuntimeFileName) : null;
}

/**
 * Do these leading bytes belong to the pinned file? `true` once they match its whole `starts`,
 * `false` at the first byte that differs, and `null` while they match so far but more are needed
 * (pass `final` when there are no more: the answer is then yes or no). This is what tells the real
 * file from an HTML fallback page (a static host answers a missing file with index.html and status
 * 200) or from another file under the right name. The whole SHA-256 is checked when the site is
 * built. Same contract as looksLikeOrtRuntimeFile (services/dictation/ortRuntime.ts).
 */
export function looksLikePyodideRuntimeFile(file: PyodideRuntimeFileName, head: Uint8Array, final = false): boolean | null {
  const { starts } = PYODIDE_RUNTIME_PIN.files[file];
  const n = Math.min(head.length, starts.length);
  for (let i = 0; i < n; i++) if (head[i] !== starts.charCodeAt(i)) return false;
  if (head.length >= starts.length) return true;
  return final ? false : null;
}

/** The yes-or-no form, for bytes that are all there (a file read from disk). */
export const hasPyodideFirstBytes = (file: PyodideRuntimeFileName, bytes: Uint8Array): boolean => looksLikePyodideRuntimeFile(file, bytes, true) === true;

/** The Content-Type a pinned file is served with. */
export const pyodideContentType = (file: PyodideRuntimeFileName): string => PYODIDE_RUNTIME_PIN.files[file].type;

/**
 * The headers every runtime file is served with: functions/_middleware.ts and the Vite servers set
 * them, on files they have checked. A year, never revalidated (the path carries the version, the
 * bytes under it never change), and for our own pages only: no CORS grant is sent, and
 * Cross-Origin-Resource-Policy stops other sites loading the files without CORS. The same values
 * as the voice engine's (ORT_CACHE_CONTROL, ORT_RESOURCE_POLICY; a test keeps them equal).
 */
export const PYODIDE_RUNTIME_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const PYODIDE_RUNTIME_RESOURCE_POLICY = 'same-origin';
