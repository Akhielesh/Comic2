import { createHash } from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { defineConfig, loadEnv, searchForWorkspaceRoot, type Plugin, type Rollup } from 'vite';
import react from '@vitejs/plugin-react';
import { browserModulesReport } from './scripts/licence-check.mjs';
import { webNotices } from './scripts/notices.mjs';
import {
  ORT_CACHE_CONTROL,
  ORT_RESOURCE_POLICY,
  ORT_RUNTIME_DIR,
  ORT_RUNTIME_FILES,
  ORT_RUNTIME_PIN,
  ORT_VERSION_RE,
  PAGES_FILE_LIMIT_BYTES,
  isOrtRuntimePath,
  ortContentType,
  parseOrtRuntimePath
} from './services/dictation/ortRuntime';
import {
  PYODIDE_FIRST_BYTES,
  PYODIDE_RUNTIME_BASE,
  PYODIDE_RUNTIME_CACHE_CONTROL,
  PYODIDE_RUNTIME_FILES,
  PYODIDE_RUNTIME_PIN,
  PYODIDE_RUNTIME_RESOURCE_POLICY,
  hasPyodideFirstBytes,
  isPyodideRuntimePath,
  pyodideContentType,
  pyodideRuntimeFileAt,
  type PyodideRuntimeFileName
} from './services/pyodideRuntime';

// Comic Studio QA harness entry (P1-QA: qa/comic-qa.html). Built ONLY when QA_BUILD=1
// (`npm run qa:build` → dist-qa/), so production dist/ never contains it.
const qaInput = (): Record<string, string> => {
  if (process.env.QA_BUILD !== '1') return {};
  const entry = path.resolve(__dirname, 'qa/comic-qa.html');
  if (!fs.existsSync(entry)) {
    throw new Error('QA_BUILD=1 but qa/comic-qa.html does not exist yet (the QA harness entry is added by P1-QA).');
  }
  return { qa: entry };
};

/** Every source a Rollup output came from: chunk modules, and the files assets were emitted from. */
const bundleSources = (bundle: Rollup.OutputBundle): string[] => {
  const ids: string[] = [];
  for (const item of Object.values(bundle)) {
    if (item.type === 'chunk') ids.push(...Object.keys(item.modules));
    else ids.push(...(item.originalFileNames ?? []));
  }
  return ids;
};

/**
 * W1.6 licence gate, browser side: records the npm packages whose modules (or emitted files: fonts,
 * wasm) are REALLY in the production bundle — the main entries and every worker bundle — and emits
 * dist/THIRD-PARTY-NOTICES.txt for exactly those (scripts/notices.mjs). With LICENCE_MODULES_OUT set
 * (CI) it also writes that module list as JSON for `node scripts/licence-check.mjs --browser-modules`,
 * which applies the browser rules (MIT/Apache/BSD/ISC/MPL/OFL only) to it. The list is written
 * outside dist/ so it never ships. `worker()` is the collector for `worker.plugins` (Vite bundles
 * workers in separate Rollup builds that finish before the main bundle's generateBundle).
 */
export function licenceModules(options: { root?: string; reportFile?: string } = {}): Plugin & { worker: () => Plugin } {
  const root = options.root ?? __dirname;
  const workerSources = new Set<string>();
  return {
    name: 'licence-modules',
    apply: 'build',
    enforce: 'post',
    generateBundle(_output, bundle) {
      const report = browserModulesReport([...bundleSources(bundle), ...workerSources], { root });
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source: webNotices(report, { root }) });
      const out = options.reportFile ?? process.env.LICENCE_MODULES_OUT;
      if (out) {
        fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
        fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
      }
    },
    worker: (): Plugin => ({
      name: 'licence-modules:worker',
      apply: 'build',
      enforce: 'post',
      generateBundle(_output, bundle) {
        for (const id of bundleSources(bundle)) workerSources.add(id);
      }
    })
  };
}

/**
 * Bridge D5, "Atlas everywhere": index.html (and every other page entry that opts in, such as live.html)
 * ships `data-ds-skin="atlas"` statically on <html>. The build kill switch VITE_DS_SKIN_EVERYWHERE takes
 * it out again: exactly `off` strips the attribute from EVERY HTML entry Vite builds (no file-name filter,
 * so one switch rolls back every page); any other value, or none, keeps it. The comics host still boots
 * the skin at runtime either way (services/dsSkin.ts). docs/infrastructure/ENV_MATRIX.md.
 */
export const DS_SKIN_EVERYWHERE_VAR = 'VITE_DS_SKIN_EVERYWHERE';

/** The <html> start tag without its data-ds-skin attribute (any value, any quoting); nothing else changes. */
export function stripDsSkinAttribute(html: string): string {
  return html.replace(/<html\b[^>]*>/i, (tag) => tag.replace(/\s+data-ds-skin(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?(?=[\s/>])/gi, ''));
}

/** True when the build keeps the skin attribute: every value but exactly `off`. */
export const dsSkinEverywhere = (value: string | undefined): boolean => value !== 'off';

/**
 * The build-log warning for a value that looks like an attempt to switch the skin off but is not exactly
 * `off` (`OFF`, `false`, `0`, ` off`, `disabled`…): the switch keeps its exact-match rule, so during an
 * incident such a value gives a green build that still ships the skin; the warning says so. null otherwise.
 */
export function dsSkinEverywhereWarning(value: string | undefined): string | null {
  if (value === undefined || value === 'off') return null;
  if (!/^\s*(?:off|false|0|no|disabled?)\s*$/i.test(value)) return null;
  return `${DS_SKIN_EVERYWHERE_VAR}="${value}" keeps the Atlas skin: only the exact value "off" strips it`;
}

export function dsSkinEverywherePlugin(value: string | undefined): Plugin {
  return {
    name: 'ds-skin-everywhere',
    configResolved(config) {
      const warning = dsSkinEverywhereWarning(value);
      if (warning) config.logger.warn(warning);
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => (dsSkinEverywhere(value) ? html : stripDsSkinAttribute(html))
    }
  };
}

/** The onnxruntime-web that @huggingface/transformers itself imports: its dist folder, version, and the version it pins. */
export interface OrtRuntimeSource {
  /** `<package>/dist`, where the ort-wasm-* files live. */
  dir: string;
  version: string;
  /** transformers.js's own `dependencies['onnxruntime-web']` (an exact pin). */
  pinned: string;
}

/**
 * Resolve onnxruntime-web the way transformers.js does: from transformers.js's own folder, so a nested copy
 * (`@huggingface/transformers/node_modules/onnxruntime-web`, what the lockfile installs while the app depends on
 * another version for the sound model) wins over the top-level one. Throws if either package is missing.
 */
export function resolveOrtRuntime(root: string = __dirname): OrtRuntimeSource {
  const fromApp = createRequire(path.join(root, 'package.json'));
  const transformersEntry = fromApp.resolve('@huggingface/transformers');
  const ortEntry = createRequire(transformersEntry).resolve('onnxruntime-web/webgpu');
  const dir = path.dirname(ortEntry);
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; version?: string; dependencies?: Record<string, string> };
  const ortPkg = read(path.join(dir, '..', 'package.json'));
  const transformersPkg = read(path.join(path.dirname(transformersEntry), '..', 'package.json'));
  if (ortPkg.name !== 'onnxruntime-web' || !ortPkg.version) throw new Error(`ortRuntime: ${dir} is not onnxruntime-web's dist folder`);
  return { dir, version: ortPkg.version, pinned: transformersPkg.dependencies?.['onnxruntime-web'] ?? '' };
}

/** The build-time constant whisperEngine.ts reads (vite-env.d.ts declares it). */
export const ORT_VERSION_DEFINE = '__ORT_WEB_VERSION__';

/**
 * The bytes of one runtime file, only when they are the pinned ones (ORT_RUNTIME_PIN.sha256): the SHA-256 of what is
 * on disk must equal the hash reviewed in source. Throws otherwise, naming both hashes.
 */
export function readPinnedOrtFile(dir: string, name: (typeof ORT_RUNTIME_FILES)[number]): Buffer {
  const src = path.join(dir, name);
  if (!fs.existsSync(src)) throw new Error(`ortRuntime: ${src} is missing`);
  const bytes = fs.readFileSync(src);
  const got = createHash('sha256').update(bytes).digest('hex');
  const want = ORT_RUNTIME_PIN.sha256[name];
  if (got !== want) {
    throw new Error(
      `ortRuntime: integrity check failed for ${src}: sha256 ${got}, but onnxruntime-web ${ORT_RUNTIME_PIN.version} published ${want} ` +
        '(services/dictation/ortRuntime.ts ORT_RUNTIME_PIN). Reinstall node_modules with `npm ci`; never edit the pin to match a file you did not review.'
    );
  }
  return bytes;
}

/**
 * The private voice model's ONNX runtime, served from our own site (services/dictation/ortRuntime.ts).
 *
 *  - Defines `__ORT_WEB_VERSION__` as the version of the onnxruntime-web transformers.js resolves, so the path the
 *    page asks for and the folder the build writes can never drift.
 *  - Build: copies exactly ORT_RUNTIME_FILES from that package into `<outDir>/ort/<version>/` (never into git),
 *    and stops the build if the installed version is not the one pinned in source and by transformers.js, if a file
 *    is missing or is 25 MiB or more (the Pages per-file limit), or if a file's SHA-256 is not the pinned one. All
 *    four are checked before any is emitted, so a build that fails the check ships none of them.
 *  - Dev and preview: answer `/ort/*` themselves, as functions/_middleware.ts does in production: the four files
 *    with their content types and immutable caching, a plain 404 for anything else (never the SPA's index.html),
 *    and a 500 for a file whose bytes are not the pinned ones (it is never served).
 */
export function ortRuntime(options: { root?: string } = {}): Plugin {
  const source = resolveOrtRuntime(options.root ?? __dirname);
  const { dir, version } = source;
  let base = '/';
  let outDir = path.resolve(options.root ?? __dirname, 'dist');
  let report: (msg: string) => void = (msg) => console.error(msg);

  const plain = (res: ServerResponse, status: number, body: string) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  };
  /** One integrity check per file and change (path, size, mtime): the result, or the error to show. */
  const checked = new Map<string, { stamp: string; error: string | null }>();
  const integrityError = (folder: string, name: (typeof ORT_RUNTIME_FILES)[number]): string | null => {
    const file = path.join(folder, name);
    const stat = fs.statSync(file);
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    const known = checked.get(file);
    if (known && known.stamp === stamp) return known.error;
    let error: string | null = null;
    try {
      readPinnedOrtFile(folder, name);
    } catch (e) {
      error = (e as Error).message;
    }
    checked.set(file, { stamp, error });
    return error;
  };
  /** Connect middleware for `/ort/*`, reading the files from `folder()`. */
  const serve = (folder: () => string) => (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    let pathname = (req.url ?? '').split('?')[0];
    if (base !== '/' && pathname.startsWith(base)) pathname = `/${pathname.slice(base.length)}`;
    if (!isOrtRuntimePath(pathname)) return next();
    const hit = parseOrtRuntimePath(pathname);
    const file = hit && hit.version === version ? path.join(folder(), hit.file) : null;
    if (!hit || !file || !fs.existsSync(file)) return plain(res, 404, 'Not found');
    const bad = integrityError(folder(), hit.file);
    if (bad) {
      report(bad);
      return plain(res, 500, 'The voice engine failed its integrity check and was not served. See the server log.');
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', ortContentType(hit.file));
    res.setHeader('Cache-Control', ORT_CACHE_CONTROL);
    res.setHeader('Cross-Origin-Resource-Policy', ORT_RESOURCE_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(fs.statSync(file).size));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  };

  return {
    name: 'ort-runtime',
    config: () => ({ define: { [ORT_VERSION_DEFINE]: JSON.stringify(version) } }),
    configResolved(config) {
      base = config.base || '/';
      outDir = path.resolve(config.root, config.build.outDir);
      if (config.logger) report = (msg) => config.logger.error(msg);
    },
    buildStart() {
      if (!ORT_VERSION_RE.test(version)) this.error(`ortRuntime: onnxruntime-web version "${version}" cannot be a path segment`);
      if (source.pinned !== version) {
        this.error(`ortRuntime: @huggingface/transformers pins onnxruntime-web ${source.pinned || '(none)'} but resolves ${version} (${dir}); reinstall node_modules`);
      }
      if (version !== ORT_RUNTIME_PIN.version) {
        this.error(
          `ortRuntime: transformers.js resolves onnxruntime-web ${version}, but the engine pinned in services/dictation/ortRuntime.ts is ${ORT_RUNTIME_PIN.version}. ` +
            'A new engine needs its version and its four SHA-256 hashes reviewed there, in the same commit as the dependency change.'
        );
      }
    },
    generateBundle() {
      // Every file is read and checked before the first is emitted: a failed check ships nothing.
      const files: { name: string; src: string; bytes: Buffer }[] = [];
      for (const name of ORT_RUNTIME_FILES) {
        const src = path.join(dir, name);
        let bytes: Buffer;
        try {
          bytes = readPinnedOrtFile(dir, name);
        } catch (e) {
          return this.error((e as Error).message);
        }
        if (bytes.length >= PAGES_FILE_LIMIT_BYTES) return this.error(`ortRuntime: ${name} is ${bytes.length} bytes, over the Cloudflare Pages limit of ${PAGES_FILE_LIMIT_BYTES}`);
        files.push({ name, src, bytes });
      }
      for (const f of files) this.emitFile({ type: 'asset', fileName: `${ORT_RUNTIME_DIR}/${version}/${f.name}`, originalFileName: f.src, source: f.bytes });
    },
    configureServer(server) {
      server.middlewares.use(serve(() => dir));
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve(() => path.join(outDir, ORT_RUNTIME_DIR, version)));
    }
  };
}

/** One pinned Python runtime file as read from disk: its name, where it came from and its bytes. */
export interface PinnedPyodideFile {
  name: PyodideRuntimeFileName;
  path: string;
  source: Buffer;
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * The pinned Python runtime, read from the installed `pyodide` package and held to
 * PYODIDE_RUNTIME_PIN (services/pyodideRuntime.ts): the package version, then every file's size,
 * first bytes and SHA-256. Throws — naming each difference and printing what is installed — when
 * anything is not the pinned bytes, so a build can never ship a runtime nobody reviewed.
 */
export function readPinnedPyodide(options: { root?: string } = {}): PinnedPyodideFile[] {
  const pin = PYODIDE_RUNTIME_PIN;
  const dir = path.join(options.root ?? __dirname, 'node_modules', pin.package);
  const problems: string[] = [];
  let installed = '';
  try {
    installed = String((JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version ?? '');
  } catch {
    problems.push(`${pin.package} is not installed (${path.join(dir, 'package.json')} could not be read): run npm ci`);
  }
  if (installed && installed !== pin.version) problems.push(`installed ${pin.package}@${installed}, pinned ${pin.version}`);
  const files: PinnedPyodideFile[] = [];
  const actual: string[] = [];
  for (const name of PYODIDE_RUNTIME_FILES) {
    const want = pin.files[name];
    const file = path.join(dir, name);
    let source: Buffer;
    try {
      source = fs.readFileSync(file);
    } catch {
      if (installed) problems.push(`${name}: missing from ${pin.package}@${installed}`);
      continue;
    }
    const got = sha256Hex(source);
    actual.push(`  ${name}: sha256 ${got}, ${source.length} bytes, starts ${JSON.stringify(source.subarray(0, want.starts.length).toString('latin1'))}`);
    if (source.length !== want.bytes) problems.push(`${name}: ${source.length} bytes, pinned ${want.bytes}`);
    if (source.length >= PAGES_FILE_LIMIT_BYTES) problems.push(`${name}: ${source.length} bytes, over the Cloudflare Pages limit of ${PAGES_FILE_LIMIT_BYTES}`);
    if (!hasPyodideFirstBytes(name, source)) problems.push(`${name}: does not start with the pinned first bytes ${JSON.stringify(want.starts)}`);
    if (want.starts.length > PYODIDE_FIRST_BYTES) problems.push(`${name}: the pinned first bytes are longer than the ${PYODIDE_FIRST_BYTES} a server reads (PYODIDE_FIRST_BYTES)`);
    if (got !== want.sha256) problems.push(`${name}: sha256 ${got}, pinned ${want.sha256}`);
    files.push({ name, path: file, source });
  }
  if (problems.length) {
    throw new Error(
      [
        'The Python runtime is not the pinned one (services/pyodideRuntime.ts PYODIDE_RUNTIME_PIN):',
        ...problems.map((p) => `  - ${p}`),
        ...(actual.length ? [`Installed${installed ? ` (${pin.package}@${installed})` : ''}:`, ...actual] : []),
        'Nothing was built. If this is a Pyodide update you have reviewed, update the pin (version, sha256, bytes, starts) to the installed values; otherwise reinstall with npm ci.'
      ].join('\n')
    );
  }
  return files;
}

/**
 * `vite dev` / `vite preview`: `/pyodide/*` answered as functions/_middleware.ts answers it in production (and as
 * ortRuntime() answers `/ort/*`): a pinned file with its content type and immutable caching, a plain 404 for
 * anything else (never the SPA's index.html), and a 500 for a file whose bytes are not the pinned ones (it is never
 * served). `read` gives a file's checked bytes, null when it is missing, or the Error that failed its check.
 */
export function pyodideRuntimeMiddleware(read: (file: PyodideRuntimeFileName) => Buffer | Error | null) {
  const plain = (res: ServerResponse, status: number, body: string) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  };
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const pathname = (req.url ?? '').split('?')[0];
    if (!isPyodideRuntimePath(pathname)) return next();
    const file = pyodideRuntimeFileAt(pathname);
    const bytes = file ? read(file) : null;
    if (!file || bytes === null) return plain(res, 404, 'Not found');
    if (bytes instanceof Error || !hasPyodideFirstBytes(file, bytes)) {
      return plain(res, 500, 'The Python runtime failed its integrity check and was not served. See the server log.');
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', pyodideContentType(file));
    res.setHeader('Cache-Control', PYODIDE_RUNTIME_CACHE_CONTROL);
    res.setHeader('Cross-Origin-Resource-Policy', PYODIDE_RUNTIME_RESOURCE_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(bytes.length));
    res.end(req.method === 'HEAD' ? undefined : bytes);
  };
}

/**
 * The chat's Python runtime (Pyodide), served from our own site and pinned by hash (services/pyodideRuntime.ts) —
 * the same design as ortRuntime() above.
 *
 *  - Build: copies exactly the pinned files from node_modules/pyodide into `<outDir>/pyodide/<version>/` (never
 *    into git) and stops the build when the installed version is not the pinned one, or a file is missing, is 25 MiB
 *    or more, or is not the pinned bytes (size, first bytes, SHA-256). Every file is checked before any is emitted,
 *    so a build that fails the check ships none of them. Each is emitted with its node_modules path as
 *    `originalFileName`, so licenceModules() counts `pyodide` as browser code: the licence gate judges it by the
 *    browser rules and THIRD-PARTY-NOTICES.txt lists it.
 *  - Dev: answers `/pyodide/*` straight from node_modules, checked on first use (a mismatch is logged and every
 *    runtime file is then a 500; the app itself still starts).
 *  - Preview: answers from the built folder, each file held to its pinned SHA-256.
 */
export function pyodideRuntime(options: { root?: string } = {}): Plugin {
  let building = false;
  let outDir = path.resolve(options.root ?? __dirname, 'dist');
  let report: (msg: string) => void = (msg) => console.error(msg);
  return {
    name: 'pyodide-runtime',
    configResolved(config) {
      building = config.command === 'build';
      outDir = path.resolve(config.root, config.build.outDir);
      if (config.logger) report = (msg) => config.logger.error(msg);
    },
    buildStart() {
      if (!building) return;
      let files: PinnedPyodideFile[];
      try {
        files = readPinnedPyodide(options);
      } catch (e) {
        return this.error((e as Error).message);
      }
      for (const f of files) {
        this.emitFile({ type: 'asset', fileName: `${PYODIDE_RUNTIME_BASE.slice(1)}${f.name}`, originalFileName: f.path, source: f.source });
      }
    },
    configureServer(server) {
      let checked: Map<string, Buffer> | Error | null = null;
      server.middlewares.use(
        pyodideRuntimeMiddleware((file) => {
          if (checked === null) {
            try {
              checked = new Map(readPinnedPyodide(options).map((f) => [f.name, f.source]));
            } catch (e) {
              checked = e as Error;
              report(checked.message);
            }
          }
          return checked instanceof Error ? checked : checked.get(file) ?? null;
        })
      );
    },
    configurePreviewServer(server) {
      const seen = new Map<string, Buffer | Error | null>();
      server.middlewares.use(
        pyodideRuntimeMiddleware((file) => {
          if (!seen.has(file)) {
            let result: Buffer | Error | null = null;
            const built = path.join(outDir, PYODIDE_RUNTIME_BASE, file);
            if (fs.existsSync(built)) {
              const bytes = fs.readFileSync(built);
              const got = sha256Hex(bytes);
              const want = PYODIDE_RUNTIME_PIN.files[file].sha256;
              result = got === want ? bytes : new Error(`pyodideRuntime: integrity check failed for ${built}: sha256 ${got}, pinned ${want} (services/pyodideRuntime.ts PYODIDE_RUNTIME_PIN)`);
              if (result instanceof Error) report(result.message);
            }
            seen.set(file, result);
          }
          return seen.get(file) ?? null;
        })
      );
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const licence = licenceModules();
  return {
    server: {
      port: Number(env.VITE_PORT) || 7000,
      strictPort: false,
      host: '0.0.0.0',
      fs: {
        // Git worktrees link node_modules to the main checkout; vite's fs guard checks the
        // REAL path, so without this every `?url` font import (fontFiles.ts) fails in tests there.
        allow: [searchForWorkspaceRoot(process.cwd()), ...(fs.existsSync('node_modules') ? [fs.realpathSync('node_modules')] : [])]
      },
      proxy: {
        // Regex, not the bare '/api' prefix: a prefix key also captures app MODULE
        // requests like /apiTypes.ts and forwards them to the backend, whose Express
        // 404 then kills the whole dev module graph (blank app, chat never opens).
        '^/api(/|$)': {
          target: 'http://localhost:7071',
          changeOrigin: true
        }
      }
    },
    plugins: [react(), licence, dsSkinEverywherePlugin(env[DS_SKIN_EVERYWHERE_VAR] ?? process.env[DS_SKIN_EVERYWHERE_VAR]), ortRuntime(), pyodideRuntime()],
    // Module workers (the baby monitor's sound-model worker imports ONNX Runtime). Their packages
    // count as browser code for the licence gate too.
    worker: { format: 'es', plugins: () => [licence.worker()] },
    // ONNX Runtime loads its .wasm next to its own module; pre-bundling it into
    // .vite/deps breaks that path in dev (production builds emit it correctly).
    optimizeDeps: { exclude: ['onnxruntime-web'] },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    },
    build: {
      // vendor-sandpack (CodeMirror + in-browser bundler) is inherently large but lazy-loaded
      // (only the legacy Sandpack peek pulls it), so allow headroom past it.
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          live: path.resolve(__dirname, 'live.html'),
          ...qaInput()
        },
        output: {
          // Split heavy, independently-cacheable vendors out of the entry chunks so a change
          // to app code doesn't bust their cache (and the >500 kB warning clears).
          manualChunks(id: string) {
            // Vite's dynamic-import preload helper is pulled in by every chunk with a lazy
            // import — including the entry. Left unassigned, Rollup folds it into a heavy
            // vendor chunk (here vendor-sandpack, 958 kB), which then gets eagerly preloaded
            // on first paint just to obtain this tiny helper. Pin it to the always-eager
            // React chunk so the entry references it for free and Sandpack stays lazy.
            if (id.includes('preload-helper')) return 'vendor-react';
            if (!id.includes('node_modules')) return undefined;
            // Pin React core to its own stable, eagerly-loaded chunk. Without this, Rollup
            // merges react/react-dom into whichever vendor chunk first pulls them in (here
            // vendor-sandpack), forcing the landing page to download ~950 kB of Sandpack/
            // CodeMirror just to get React. The regex matches exact package segments so it
            // never catches react-markdown, react-leaflet, @codesandbox/sandpack-react, etc.
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/.test(id)) return 'vendor-react';
            if (id.includes('framer-motion')) return 'vendor-motion';
            if (id.includes('@codesandbox/sandpack') || id.includes('@codemirror') || id.includes('codemirror')) return 'vendor-sandpack';
            if (
              id.includes('react-markdown') || id.includes('remark') || id.includes('rehype') ||
              id.includes('micromark') || id.includes('mdast') || id.includes('hast') ||
              id.includes('unist') || id.includes('vfile') || id.includes('property-information')
            ) return 'vendor-markdown';
            if (id.includes('leaflet')) return 'vendor-leaflet';
            if (id.includes('jszip')) return 'vendor-jszip';
            return undefined;
          }
        }
      }
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './tests/setup.ts',
      // tests/e2e holds Playwright specs (npm run qa:mobile), not vitest suites.
      exclude: ['**/node_modules/**', '**/dist/**', '**/dist-qa/**', '**/server/dist/**', 'tests/e2e/**']
    }
  };
});
