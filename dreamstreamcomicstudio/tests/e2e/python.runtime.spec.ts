// python.runtime.spec.ts — the Python playground runs on a runtime from OUR origin, pinned by hash, and
// from nowhere else (the owner's rule: no unpinned third-party script may run in our origin).
//
// The kit scene `python` (qa/KitScenes.tsx) mounts the chat's real code playground on a Python exercise.
// Run starts the real worker (services/pyRunner.worker.ts, built by Vite to /assets/), which loads Pyodide
// from /pyodide/<version>/ — the files `pyodideRuntime()` (vite.config.ts) copied from the `pyodide` npm
// package after checking each against PYODIDE_RUNTIME_PIN (services/pyodideRuntime.ts). `vite preview`
// serves them here under the same contract as the Pages Function (functions/_middleware.ts
// servePyodideRuntime; tests/edge/pyodideRuntime.test.ts covers that one).
//
//   1. Python really runs, and EVERY request the page and its worker make while it loads and runs is to
//      this origin: nothing to cdn.jsdelivr.net (where the runtime used to come from) or any other host.
//   2. What the worker loaded is exactly the pinned files, each with its pinned content type, immutable
//      caching, the hash as its validator and no CORS grant — and the bytes hash to the pin.
//   3. Anything else under the folder is a 404, never the app's index.html.
//   4. A package the program asks Pyodide for (numpy) is looked for in this folder only — a 404 here, never a
//      download from another host: the optional packages are not shipped.
//
// Own project (`python-runtime`, one desktop Chromium): the runtime is 13.5 MB, so it is loaded once, not
// once per device. scripts/layout-smoke.mjs runs it with the per-PR smoke (layout-smoke.yml), and the nightly
// device matrix (e2e-mobile.yml) runs every project.

import { createHash } from 'node:crypto';
import type { Request as PwRequest } from '@playwright/test';
import { test, expect } from './helpers/harness';
import { PYODIDE_RUNTIME_BASE, PYODIDE_RUNTIME_CACHE_CONTROL, PYODIDE_RUNTIME_FILES, PYODIDE_RUNTIME_PIN, pyodideRuntimePath } from '../../services/pyodideRuntime';

const isNetwork = (url: string) => /^https?:/i.test(url);

test.describe('the Python playground loads its runtime from our origin only', () => {
  test('Run executes Python; every request stays on this origin, and the runtime is exactly the pinned files', async ({ qa, page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const requests: PwRequest[] = [];
    // The context sees the page's requests AND its worker's.
    page.context().on('request', (r) => requests.push(r));

    await qa.open({ surface: 'kit', kit: 'python' }, { settle: 300 });
    const scene = page.getByTestId('kit-python');
    await expect(scene.getByText('Python · Pyodide')).toBeVisible();
    expect(requests.filter((r) => new URL(r.url()).pathname.startsWith('/pyodide')), 'the runtime is not downloaded until Python is run').toEqual([]);

    await scene.getByRole('button', { name: 'Run' }).click();
    // json + math + sys from the standard library: the interpreter, the stdlib archive and the lock file all loaded.
    // (Read from the console output only: the editor above it holds the program's own text.)
    const output = scene.getByRole('log', { name: 'Console output' });
    await expect(output.getByText('{"sum": 5050, "root": 42}'), 'the program printed its result').toBeVisible({ timeout: 75_000 });
    await expect(output.getByText('python 3')).toBeVisible();
    await qa.settle(500);

    // 1. Nothing left this origin — the old CDN least of all.
    const network = requests.map((r) => r.url()).filter(isNetwork);
    expect(network.filter((u) => /jsdelivr/i.test(u)), 'no request to jsDelivr').toEqual([]);
    expect([...new Set(network.filter((u) => new URL(u).origin !== origin).map((u) => new URL(u).origin))], 'no request to any other origin').toEqual([]);

    // The worker is a same-origin file Vite built, not a blob: URL.
    const workers = page.workers().map((w) => w.url());
    expect(workers.filter((u) => /\/assets\/pyRunner\.worker-[\w-]+\.js$/.test(new URL(u).pathname) && new URL(u).origin === origin), `the Python worker (${workers.join(', ')})`).toHaveLength(1);

    // 2. Under /pyodide/ the worker asked for the pinned files, each once, and for nothing else.
    const runtime = requests.filter((r) => new URL(r.url()).pathname.startsWith('/pyodide'));
    expect(runtime.map((r) => new URL(r.url()).pathname).sort()).toEqual(PYODIDE_RUNTIME_FILES.map(pyodideRuntimePath).sort());
    for (const file of PYODIDE_RUNTIME_FILES) {
      const pin = PYODIDE_RUNTIME_PIN.files[file];
      const res = await runtime.find((r) => new URL(r.url()).pathname === pyodideRuntimePath(file))!.response();
      expect(res?.status(), file).toBe(200);
      const headers = res!.headers();
      expect(headers['content-type'], file).toBe(pin.type);
      expect(headers['cache-control'], file).toBe(PYODIDE_RUNTIME_CACHE_CONTROL);
      expect(headers.etag, file).toBe(`"${pin.sha256}"`);
      expect(headers['x-content-type-options'], file).toBe('nosniff');
      expect(headers['access-control-allow-origin'], `${file}: no CORS grant`).toBeUndefined();
    }
    expect(qa.pageErrors, 'no page errors').toEqual([]);
  });

  test('a package the program asks for is looked for on this origin only (not shipped: a 404 here, never another host)', async ({ qa, page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const requests: PwRequest[] = [];
    page.context().on('request', (r) => requests.push(r));
    await qa.open({ surface: 'kit', kit: 'python' }, { settle: 300 });
    const scene = page.getByTestId('kit-python');
    // Pyodide's own package loader, called from Python: the lock file knows numpy, the folder does not have it.
    await scene.getByRole('textbox').fill(['import pyodide_js', 'await pyodide_js.loadPackage("numpy")', 'try:', '    import numpy', '    print("numpy", "imported")', 'except ModuleNotFoundError:', '    print("numpy", "missing")'].join('\n'));
    await scene.getByRole('button', { name: 'Run' }).click();
    const output = scene.getByRole('log', { name: 'Console output' });
    await expect(output.getByText('numpy missing'), 'the import fails cleanly').toBeVisible({ timeout: 75_000 });
    await expect(output.getByText('numpy imported')).toHaveCount(0);
    await qa.settle(300);

    const network = requests.map((r) => r.url()).filter(isNetwork);
    expect([...new Set(network.filter((u) => new URL(u).origin !== origin).map((u) => new URL(u).origin))], 'no request to any other origin').toEqual([]);
    const wheels = requests.filter((r) => /\.whl$/.test(new URL(r.url()).pathname));
    expect(wheels.length, 'the loader did look for the package').toBeGreaterThan(0);
    for (const r of wheels) {
      expect(new URL(r.url()).origin, r.url()).toBe(origin);
      expect(new URL(r.url()).pathname.startsWith(PYODIDE_RUNTIME_BASE), r.url()).toBe(true);
      expect((await r.response())?.status(), r.url()).toBe(404);
    }
  });

  test('the served bytes are the pinned bytes, and nothing else under the folder is served (a 404, never index.html)', async ({ page }) => {
    for (const file of PYODIDE_RUNTIME_FILES) {
      const res = await page.request.get(pyodideRuntimePath(file));
      expect(res.status(), file).toBe(200);
      const body = await res.body();
      expect(body.length, file).toBe(PYODIDE_RUNTIME_PIN.files[file].bytes);
      expect(createHash('sha256').update(body).digest('hex'), file).toBe(PYODIDE_RUNTIME_PIN.files[file].sha256);
    }
    const refused = [
      '/pyodide',
      '/pyodide/',
      PYODIDE_RUNTIME_BASE,
      `${PYODIDE_RUNTIME_BASE}pyodide.js`,
      `${PYODIDE_RUNTIME_BASE}numpy-2.3.0-cp314-cp314-pyodide_2026_0_wasm32.whl`,
      `${PYODIDE_RUNTIME_BASE}index.html`,
      '/pyodide/0.26.4/pyodide.js',
      '/pyodide/v0.26.4/full/pyodide.asm.wasm',
      '/pyodide/latest/pyodide.mjs',
      `/PYODIDE/${PYODIDE_RUNTIME_PIN.version}/pyodide.mjs`,
      `/pyodide/${PYODIDE_RUNTIME_PIN.version}/sub/pyodide.mjs`,
    ];
    for (const path of refused) {
      const res = await page.request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
      expect(res.headers()['content-type'], path).toMatch(/^text\/plain/);
      expect(res.headers()['cache-control'], path).toBe('no-store');
      expect(await res.text(), path).not.toMatch(/<html|<!doctype/i);
    }
  });
});
