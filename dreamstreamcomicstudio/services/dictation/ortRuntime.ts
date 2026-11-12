// The ONNX runtime the private voice model runs on, served from our own site, never from a third-party CDN.
//
// Which build runs is transformers.js's own choice, made when it is imported (4.2.0, src/backends/onnx.js): a
// { mjs, wasm } pair, the plain `ort-wasm-simd-threaded` build when its IS_SAFARI check is true and the
// `ort-wasm-simd-threaded.asyncify` build otherwise, under a cdn.jsdelivr.net prefix. whisperEngine keeps that
// choice and only moves the pair to `/ort/<version>/` on our origin. vite.config.ts (`ortRuntime()`) copies these
// four files, from the onnxruntime-web that transformers.js itself resolves, into the build at that path, and
// functions/_middleware.ts serves them: a missing file is a 404, never the SPA's index.html (F11).
//
// No DOM and no Node imports: the client, the Pages middleware, the Vite plugin and the tests all read this file.

/**
 * Every runtime file transformers.js's choice can reach in a browser: both halves of both builds.
 * whisperEngine.test.ts reads the selection code in node_modules and fails if it ever names another file.
 */
export const ORT_RUNTIME_FILES = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm'
] as const;

export type OrtRuntimeFile = (typeof ORT_RUNTIME_FILES)[number];

/** The folder at the site root. Each onnxruntime-web version gets its own subfolder, so every file is immutable. */
export const ORT_RUNTIME_DIR = 'ort';

/** A version as it may appear in the path: semver, with an optional prerelease (transformers.js pins a dev build). */
export const ORT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** `<base>ort/<version>/`: `base` is Vite's BASE_URL (`/` on every host). */
export const ortRuntimePath = (version: string, base = '/'): string => `${base.endsWith('/') ? base : `${base}/`}${ORT_RUNTIME_DIR}/${version}/`;

/** The headers every runtime file is served with (public/_headers, functions/_middleware.ts, the Vite servers). */
export const ORT_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const ORT_CONTENT_TYPES = { mjs: 'text/javascript; charset=utf-8', wasm: 'application/wasm' } as const;
export const ORT_RESOURCE_POLICY = 'same-origin';

/** Cloudflare Pages refuses a file of 25 MiB or more; the build stops before that (vite.config.ts). */
export const PAGES_FILE_LIMIT_BYTES = 25 * 1024 * 1024;

export const isOrtRuntimeFile = (name: string): name is OrtRuntimeFile => (ORT_RUNTIME_FILES as readonly string[]).includes(name);

/** The content type for a runtime file name. */
export const ortContentType = (file: OrtRuntimeFile): string => (file.endsWith('.wasm') ? ORT_CONTENT_TYPES.wasm : ORT_CONTENT_TYPES.mjs);

/** True for any path under `/ort/` (the middleware answers all of them, found or not). */
export const isOrtRuntimePath = (pathname: string): boolean => pathname === `/${ORT_RUNTIME_DIR}` || pathname.startsWith(`/${ORT_RUNTIME_DIR}/`);

/**
 * `/ort/<version>/<file>` → its parts, when the version is well formed and the file is one of the four; null for
 * anything else under `/ort/` (which is then a 404 without asking the asset server).
 */
export const parseOrtRuntimePath = (pathname: string): { version: string; file: OrtRuntimeFile } | null => {
  const m = /^\/ort\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!m || !ORT_VERSION_RE.test(m[1]) || !isOrtRuntimeFile(m[2])) return null;
  return { version: m[1], file: m[2] };
};
