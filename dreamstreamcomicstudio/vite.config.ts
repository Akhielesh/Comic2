import { createHash } from 'crypto';
import fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { defineConfig, loadEnv, searchForWorkspaceRoot, type Plugin, type Rollup } from 'vite';
import react from '@vitejs/plugin-react';
import { browserModulesReport } from './scripts/licence-check.mjs';
import { webNotices } from './scripts/notices.mjs';
import {
  PYODIDE_FIRST_BYTES,
  PYODIDE_RUNTIME_BASE,
  PYODIDE_RUNTIME_FILES,
  PYODIDE_RUNTIME_PIN,
  hasPyodideFirstBytes,
  isPyodideRuntimePath,
  pyodideRuntimeFileAt,
  pyodideRuntimeHeaders,
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

/** One pinned runtime file as read from disk: its name, where it came from and its bytes. */
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

const runtimeNotFound = (res: ServerResponse): void => {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end('Not found');
};

/**
 * `vite dev` / `vite preview`: the same contract as servePyodideRuntime in functions/_middleware.ts.
 * Under /pyodide/ only the pinned version's files are answered — with their content type, immutable
 * caching and no CORS grant — and everything else is a 404 (never the SPA's index.html fallback).
 */
export function pyodideRuntimeMiddleware(read: (file: PyodideRuntimeFileName) => Buffer | null) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      next();
      return;
    }
    if (!isPyodideRuntimePath(pathname)) {
      next();
      return;
    }
    const file = pyodideRuntimeFileAt(pathname);
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) return runtimeNotFound(res);
    const bytes = read(file);
    if (!bytes || !hasPyodideFirstBytes(file, bytes)) return runtimeNotFound(res);
    res.writeHead(200, { ...pyodideRuntimeHeaders(file), 'content-length': String(bytes.length) });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  };
}

/**
 * The browser's Python runtime (Pyodide), served from our own origin and pinned by hash
 * (services/pyodideRuntime.ts tells the whole story).
 *   build    copies exactly the pinned files from node_modules/pyodide to <outDir>/pyodide/<version>/
 *            and stops the build when the installed version or any byte is not the pinned one. Each
 *            file is emitted with its node_modules path as `originalFileName`, so licenceModules()
 *            counts `pyodide` as browser code: the licence gate judges it by the browser rules and
 *            THIRD-PARTY-NOTICES.txt lists it.
 *   dev      serves the same checked files straight from node_modules (checked on first use; a
 *            mismatch is logged and answered with a 404, the app itself still starts).
 *   preview  serves them from the built folder, each held to its pinned SHA-256.
 */
export function pyodideRuntime(options: { root?: string } = {}): Plugin {
  let building = false;
  let outDir = '';
  return {
    name: 'pyodide-runtime',
    configResolved(config) {
      building = config.command === 'build';
      outDir = path.resolve(config.root, config.build.outDir);
    },
    buildStart() {
      if (!building) return;
      let files: PinnedPyodideFile[];
      try {
        files = readPinnedPyodide(options);
      } catch (e) {
        this.error((e as Error).message);
      }
      for (const f of files) {
        this.emitFile({ type: 'asset', fileName: `${PYODIDE_RUNTIME_BASE.slice(1)}${f.name}`, source: f.source, originalFileName: f.path });
      }
    },
    configureServer(server) {
      let checked: Map<string, Buffer> | false | null = null;
      server.middlewares.use(
        pyodideRuntimeMiddleware((file) => {
          if (checked === null) {
            try {
              checked = new Map(readPinnedPyodide(options).map((f) => [f.name, f.source]));
            } catch (e) {
              checked = false;
              server.config.logger.error((e as Error).message);
            }
          }
          return checked ? checked.get(file) ?? null : null;
        })
      );
    },
    configurePreviewServer(server) {
      const seen = new Map<string, Buffer | null>();
      server.middlewares.use(
        pyodideRuntimeMiddleware((file) => {
          if (!seen.has(file)) {
            let bytes: Buffer | null = null;
            try {
              bytes = fs.readFileSync(path.join(outDir, PYODIDE_RUNTIME_BASE, file));
            } catch {
              bytes = null;
            }
            seen.set(file, bytes && sha256Hex(bytes) === PYODIDE_RUNTIME_PIN.files[file].sha256 ? bytes : null);
          }
          return seen.get(file) ?? null;
        })
      );
    }
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
    plugins: [react(), licence, dsSkinEverywherePlugin(env[DS_SKIN_EVERYWHERE_VAR] ?? process.env[DS_SKIN_EVERYWHERE_VAR]), pyodideRuntime()],
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
