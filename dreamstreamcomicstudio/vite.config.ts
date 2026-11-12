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
  ORT_VERSION_RE,
  PAGES_FILE_LIMIT_BYTES,
  isOrtRuntimePath,
  ortContentType,
  parseOrtRuntimePath
} from './services/dictation/ortRuntime';

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
 * The private voice model's ONNX runtime, served from our own site (services/dictation/ortRuntime.ts).
 *
 *  - Defines `__ORT_WEB_VERSION__` as the version of the onnxruntime-web transformers.js resolves, so the path the
 *    page asks for and the folder the build writes can never drift.
 *  - Build: copies exactly ORT_RUNTIME_FILES from that package into `<outDir>/ort/<version>/` (never into git),
 *    and stops the build if one is missing, is 25 MiB or more (the Pages per-file limit), or the installed version
 *    is not the one transformers.js pins.
 *  - Dev and preview: answer `/ort/*` themselves, as functions/_middleware.ts does in production: the four files
 *    with their content types and immutable caching, a plain 404 for anything else (never the SPA's index.html).
 */
export function ortRuntime(options: { root?: string } = {}): Plugin {
  const source = resolveOrtRuntime(options.root ?? __dirname);
  const { dir, version } = source;
  let base = '/';
  let outDir = path.resolve(options.root ?? __dirname, 'dist');

  const notFound = (res: ServerResponse) => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end('Not found');
  };
  /** Connect middleware for `/ort/*`, reading the files from `folder()`. */
  const serve = (folder: () => string) => (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    let pathname = (req.url ?? '').split('?')[0];
    if (base !== '/' && pathname.startsWith(base)) pathname = `/${pathname.slice(base.length)}`;
    if (!isOrtRuntimePath(pathname)) return next();
    const hit = parseOrtRuntimePath(pathname);
    const file = hit && hit.version === version ? path.join(folder(), hit.file) : null;
    if (!hit || !file || !fs.existsSync(file)) return notFound(res);
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
    },
    buildStart() {
      if (!ORT_VERSION_RE.test(version)) this.error(`ortRuntime: onnxruntime-web version "${version}" cannot be a path segment`);
      if (source.pinned !== version) {
        this.error(`ortRuntime: @huggingface/transformers pins onnxruntime-web ${source.pinned || '(none)'} but resolves ${version} (${dir}); reinstall node_modules`);
      }
    },
    generateBundle() {
      for (const name of ORT_RUNTIME_FILES) {
        const src = path.join(dir, name);
        if (!fs.existsSync(src)) this.error(`ortRuntime: ${src} is missing`);
        const size = fs.statSync(src).size;
        if (size >= PAGES_FILE_LIMIT_BYTES) this.error(`ortRuntime: ${name} is ${size} bytes, over the Cloudflare Pages limit of ${PAGES_FILE_LIMIT_BYTES}`);
        this.emitFile({ type: 'asset', fileName: `${ORT_RUNTIME_DIR}/${version}/${name}`, originalFileName: src, source: fs.readFileSync(src) });
      }
    },
    configureServer(server) {
      server.middlewares.use(serve(() => dir));
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve(() => path.join(outDir, ORT_RUNTIME_DIR, version)));
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
    plugins: [react(), licence, dsSkinEverywherePlugin(env[DS_SKIN_EVERYWHERE_VAR] ?? process.env[DS_SKIN_EVERYWHERE_VAR]), ortRuntime()],
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
