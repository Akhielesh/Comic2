// The ONNX runtime the private voice model runs on, served from our own site, never from a third-party CDN.
//
// Which build runs is transformers.js's own choice, made when it is imported (4.2.0, src/backends/onnx.js): a
// { mjs, wasm } pair, the plain `ort-wasm-simd-threaded` build when its IS_SAFARI check is true and the
// `ort-wasm-simd-threaded.asyncify` build otherwise, under a cdn.jsdelivr.net prefix. whisperEngine keeps that
// choice and only moves the pair to `/ort/<version>/` on our origin. vite.config.ts (`ortRuntime()`) copies these
// four files, from the onnxruntime-web that transformers.js itself resolves, into the build at that path, and
// functions/_middleware.ts serves them: a missing file is a 404, never the SPA's index.html (F11).
//
// The engine is pinned twice: by version, and by the SHA-256 of each file (ORT_RUNTIME_PIN). The build stops unless
// the bytes in node_modules are the ones onnxruntime-web published under that version, so what runs in our origin
// is reviewed in this file, not whatever happens to sit in a dependency folder.
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

/**
 * The engine this build serves: the onnxruntime-web version transformers.js pins, and the SHA-256 of each file as
 * published to npm under that version (checked against the registry tarball, whose own hash is the lockfile's
 * `integrity`). vite.config.ts hashes the files it is about to ship and stops on any difference; the middleware
 * serves this version's folder and no other.
 *
 * Moving to a new transformers.js: change the version and all four hashes here, in the same reviewed commit
 * (`sha256sum node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*`
 * after a clean `npm ci`, compared with the registry tarball).
 */
export const ORT_RUNTIME_PIN: { readonly version: string; readonly sha256: Readonly<Record<OrtRuntimeFile, string>> } = {
  version: '1.26.0-dev.20260416-b7804b056c',
  sha256: {
    'ort-wasm-simd-threaded.mjs': '5f2cd914554830762579c372d0211614c1e3f40ab3f6c0cfcf0900343229071d',
    'ort-wasm-simd-threaded.wasm': 'f4f290847a4df02d0b93cdbf39b4b0e71acefbe80573e7e6b9342a7abd7b290a',
    'ort-wasm-simd-threaded.asyncify.mjs': '5959c6733039619c9af710d8e1bae8d6e84402787990637be987c2b1bd6c5fa9',
    'ort-wasm-simd-threaded.asyncify.wasm': 'e0c0c6d3e73d43b8a249972f8358f845b08cc16fec3c80efafdf8bed40366786'
  }
};

/**
 * The one build with a WebGPU entry point (`webgpuInit`). The plain build, which transformers.js picks on Safari,
 * has none: asking it for the WebGPU device fails every load ("webgpuInit is not a function"), so WebGPU is only
 * ever asked of this file (whisperEngine.ts; whisperEngine.test.ts reads both files to keep this true).
 */
export const ORT_WEBGPU_RUNTIME_MJS: OrtRuntimeFile = 'ort-wasm-simd-threaded.asyncify.mjs';

/** The folder at the site root. Each onnxruntime-web version gets its own subfolder, so every file is immutable. */
export const ORT_RUNTIME_DIR = 'ort';

/** A version as it may appear in the path: semver, with an optional prerelease (transformers.js pins a dev build). */
export const ORT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** `<base>ort/<version>/`: `base` is Vite's BASE_URL (`/` on every host). */
export const ortRuntimePath = (version: string, base = '/'): string => `${base.endsWith('/') ? base : `${base}/`}${ORT_RUNTIME_DIR}/${version}/`;

/**
 * The headers every runtime file is served with. functions/_middleware.ts and the Vite servers set them, on files
 * they have checked; public/_headers must name none of them for /ort (Pages applies that file to its SPA fallback
 * too, which would label index.html as the engine).
 */
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

/** How many leading bytes `looksLikeOrtRuntimeFile` needs at most (it decides sooner when it can). */
export const ORT_SNIFF_BYTES = 512;

/**
 * Do these leading bytes belong to the named runtime file? A `.wasm` starts with the WebAssembly magic number
 * (`\0asm`); an `.mjs` starts, after any byte-order mark and white space, with something other than `<` (an HTML
 * page, which is what a static host's SPA fallback answers for a missing file, starts with `<`). `null` means more
 * bytes are needed to decide; pass `final` when there are no more, and the answer is then yes or no.
 */
export const looksLikeOrtRuntimeFile = (file: OrtRuntimeFile, head: Uint8Array, final = false): boolean | null => {
  if (file.endsWith('.wasm')) {
    if (head.length < 4) return final ? false : null;
    return head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
  }
  let i = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  while (i < head.length && (head[i] === 0x20 || (head[i] >= 0x09 && head[i] <= 0x0d))) i += 1;
  if (i < head.length) return head[i] !== 0x3c;
  return final || head.length >= ORT_SNIFF_BYTES ? false : null;
};
