// @vitest-environment node
/**
 * ADR 0006 WS-1 — proof that Stream Studio's CSP fits the BUILT app.
 *
 * Serves dist/ (the output of `npm run build`) through the real Pages middleware with the
 * policy ENFORCED, then checks the response's own header against:
 *   - every tag in the built live.html (scripts, module preloads, styles, manifest, icons,
 *     inline scripts, style attributes, event handlers);
 *   - every chunk the page can reach (entry → modulepreloads → dynamic imports → workers →
 *     wasm loaders): each external origin written in that code must be allowed by the policy
 *     or be on NOT_FETCHED with the reason it is never loaded;
 *   - what the code does at run time that no literal URL shows: the live Worker over https +
 *     wss, Supabase REST + realtime, Drive uploads, the service worker, blob: workers and
 *     AudioWorklets, MediaSource / blob: media, WebAssembly;
 *   - and that no reachable chunk needs eval.
 *
 * CI builds before it tests (.github/workflows/ci.yml), so this runs there on every PR. Run
 * locally after `npm run build`; without a dist/ it is skipped, loudly.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { SUPABASE_ORIGIN, createOnRequest } from '../../functions/_middleware';
import { SW_URL } from '../../live/monitor/push';
import { allowsInlineScript, allowsInlineStyleAttribute, allowsUrl, allowsWasm, allowsEval, parsePolicy, type Policy } from './cspEval';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST = path.join(ROOT, 'dist');
const BUILT = existsSync(path.join(DIST, 'live.html'));
if (!BUILT) console.warn('[liveCsp.built] dist/live.html not found — run `npm run build` first; the built-page CSP proof is skipped.');

/**
 * Origins that appear as text in the live bundle but are never loaded by the page, each with
 * the reason. A NEW origin in the bundle fails this test until it is either allowed in the
 * policy (functions/_middleware.ts) or added here with its reason.
 */
const NOT_FETCHED: Record<string, string> = {
  'http://www.w3.org': 'XML / SVG namespace strings (React DOM)',
  'https://react.dev': 'React error-message links',
  'https://reactrouter.com': 'React Router warning links',
  'https://developer.mozilla.org': 'links in library error messages',
  'https://github.com': 'links in library error messages',
  'https://web.dev': 'ONNX Runtime error-message link (worker)',
  'http://kripken.github.io': 'Emscripten comments (MediaPipe wasm loader)',
  'http://en.wikipedia.org': 'Emscripten comments (MediaPipe wasm loader)',
  'http://pubs.opengroup.org': 'Emscripten comments (MediaPipe wasm loader)',
  'http://server.com': 'Emscripten example text (MediaPipe wasm loader)',
  'http://unicode.org': 'Emscripten comments (MediaPipe wasm loader)',
  'https://bugzil.la': 'Emscripten comments (MediaPipe wasm loader)',
  'https://tools.ietf.org': 'Emscripten comments (MediaPipe wasm loader)',
  'https://webkit.org': 'Emscripten comments (MediaPipe wasm loader)',
  'https://www.ietf.org': 'Emscripten comments (MediaPipe wasm loader)',
  'https://www.khronos.org': 'Emscripten comments (MediaPipe wasm loader)',
  'https://drive.google.com': 'links the user opens in a new tab (a navigation, not a fetch)',
  'https://one.google.com': '"Drive is full" link (a navigation)',
  'https://odml.pa.googleapis.com': 'MediaPipe usage telemetry: opt-in (enableLogging), never called — and blocked on purpose',
  'http://localhost': 'local development only (vite / wrangler dev)',
  'http://127.0.0.1': 'local development only (wrangler dev live Worker)',
};

const read = (rel: string) => readFileSync(path.join(DIST, rel), 'utf8');

/** Every file the page can reach, following the references Vite writes into chunks. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.shift()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!/\.(m?js|css|html)$/.test(rel) || !existsSync(path.join(DIST, rel))) continue;
    const text = read(rel);
    for (const m of text.matchAll(/["'`(\s=]\/?(assets\/[\w.-]+\.(?:m?js|css|wasm))/g)) queue.push(m[1]);
    for (const m of text.matchAll(/["'`]\.\/([\w.-]+\.(?:m?js|css|wasm))["'`]/g)) queue.push(path.posix.join(path.posix.dirname(rel), m[1]));
  }
  return [...seen];
}

const originsIn = (text: string): string[] =>
  [...new Set([...text.matchAll(/\b(https?|wss?):\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+|localhost)(?::\d+)?/gi)].map((m) => `${m[1].toLowerCase()}://${m[2].toLowerCase()}`))];

const HOSTS = [
  { name: 'Stream Studio host', page: 'https://stream.dreamstreamstudio.ai/' },
  { name: 'apex /live', page: 'https://dreamstreamstudio.ai/live' },
];

describe.skipIf(!BUILT)('Stream Studio CSP vs the built app (dist/)', () => {
  const buildSupabase = process.env.VITE_SUPABASE_URL;
  const files = BUILT ? reachable('live.html') : [];
  const code = files.filter((f) => /\.(m?js)$/.test(f)).map((f) => ({ file: f, text: read(f) }));

  async function servedPolicy(page: string): Promise<{ policy: Policy; res: Response }> {
    const handler = createOnRequest({ streamHostOn: false, enforceLive: true });
    const live = () => new Response(read('live.html'), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const res = await handler({
      request: new Request(page, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' } }),
      next: async () => live(),
      // The build's Supabase URL reaches the Function the way it does in Pages (project env).
      env: { ASSETS: { fetch: async () => live() }, VITE_SUPABASE_URL: buildSupabase },
    });
    const header = res.headers.get('content-security-policy');
    expect(header, 'the enforced policy is on the response').toBeTruthy();
    return { policy: parsePolicy(header!), res };
  }

  it('reaches the whole live app (sanity: entry, lazy views, workers, wasm)', () => {
    expect(files.some((f) => /^assets\/live-[\w-]+\.js$/.test(f))).toBe(true);
    expect(files.some((f) => /^assets\/MonitorCamera-[\w-]+\.js$/.test(f))).toBe(true);
    expect(files.some((f) => /^assets\/yamnet\.worker-[\w-]+\.js$/.test(f))).toBe(true);
    expect(files.some((f) => /^assets\/vision_wasm_internal-[\w-]+\.js$/.test(f))).toBe(true);
    for (const f of files) expect(existsSync(path.join(DIST, f)), `${f} is referenced but missing`).toBe(true);
  });

  for (const { name, page } of HOSTS) {
    describe(name, () => {
      it('allows every tag in the built live.html', async () => {
        const { policy } = await servedPolicy(page);
        const doc = new JSDOM(read('live.html')).window.document;
        const problems: string[] = [];
        const need = (directive: string, url: string | null) => {
          if (url && !allowsUrl(policy, directive, url, page)) problems.push(`${directive} ${url}`);
        };
        doc.querySelectorAll('script[src]').forEach((s) => need('script-src-elem', s.getAttribute('src')));
        doc.querySelectorAll('link[rel="modulepreload"]').forEach((l) => need('script-src-elem', l.getAttribute('href')));
        doc.querySelectorAll('link[rel~="stylesheet"]').forEach((l) => need('style-src-elem', l.getAttribute('href')));
        doc.querySelectorAll('link[rel="manifest"]').forEach((l) => need('manifest-src', l.getAttribute('href')));
        doc.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]').forEach((l) => need('img-src', l.getAttribute('href')));
        doc.querySelectorAll('script:not([src])').forEach((s) => {
          if (!allowsInlineScript(policy, s.textContent ?? '')) problems.push(`inline script: ${(s.textContent ?? '').slice(0, 60)}`);
        });
        if (doc.querySelector('[style]') && !allowsInlineStyleAttribute(policy)) problems.push('style attribute');
        doc.querySelectorAll('*').forEach((el) => {
          for (const a of el.attributes) if (/^on/i.test(a.name)) problems.push(`${el.tagName}[${a.name}] handler`);
        });
        expect(problems).toEqual([]);
        // The Google Fonts stylesheet's font files.
        need('font-src', 'https://fonts.gstatic.com/s/newsreader/v1/x.woff2');
        expect(problems).toEqual([]);
      });

      it('allows (or knowingly leaves out) every external origin in the reachable code', async () => {
        const { policy } = await servedPolicy(page);
        const governing = ['connect-src', 'script-src-elem', 'frame-src', 'style-src-elem', 'font-src', 'img-src', 'media-src', 'worker-src'];
        const unexplained: string[] = [];
        for (const { file, text } of code) {
          for (const origin of originsIn(text)) {
            if (NOT_FETCHED[origin]) continue;
            const probe = `${origin}/`;
            if (!governing.some((d) => allowsUrl(policy, d, probe, page))) unexplained.push(`${origin}  (in ${file})`);
          }
        }
        expect(unexplained, 'allow these in functions/_middleware.ts, or add them to NOT_FETCHED with the reason').toEqual([]);
      });

      it('allows what the code does at run time', async () => {
        const { policy } = await servedPolicy(page);
        const self = new URL(page);
        const wsSelf = `${self.protocol === 'https:' ? 'wss' : 'ws'}://${self.host}`;
        const all = code.map((c) => c.text).join('\n');
        const expectations: [string, string][] = [
          // live/config.ts resolveWorkerBase → `${origin}/live-api` (REST and WebSockets).
          ['connect-src', `${self.origin}/live-api/api/monitor/n1/ws`],
          ['connect-src', `${wsSelf}/live-api/api/monitor/n1/ws`],
          // Supabase: production project, and whatever this build was given.
          ['connect-src', `${SUPABASE_ORIGIN}/rest/v1/rpc/monitor_list`],
          ['connect-src', `${SUPABASE_ORIGIN.replace('https:', 'wss:')}/realtime/v1/websocket`],
          // Drive resumable upload sessions (URL comes from Google via our backend).
          ['connect-src', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=x'],
          // Self-hosted, hash-pinned models fetched from the page (MediaPipe on the main thread).
          ['connect-src', '/models/mediapipe/pose_landmarker_lite-v1.task'],
          // The alert service worker.
          ['worker-src', SW_URL],
        ];
        for (const m of buildSupabase ? [buildSupabase] : []) {
          expectations.push(['connect-src', `${new URL(m).origin}/auth/v1/token`]);
          expectations.push(['connect-src', `${new URL(m).origin.replace('https:', 'wss:')}/realtime/v1/websocket`]);
        }
        for (const m of all.matchAll(/new Worker\(new URL\("([^"]+)"/g)) expectations.push(['worker-src', m[1]]);
        for (const m of all.matchAll(/"(\/assets\/vision_wasm[\w-]*\.js)"/g)) expectations.push(['script-src-elem', m[1]]);
        const blob = `blob:${self.origin}/7f1c2d3e-0000-4000-8000-000000000000`;
        if (/createObjectURL\(new Blob\([^)]*\)\)[^;]*;?[^;]*new Worker\(|new Worker\(\w+\)/.test(all)) expectations.push(['worker-src', blob]);
        // The sound engine's and the relay player's AudioWorklets: addModule(blob:) is script-src.
        expect(all).toMatch(/audioWorklet\.addModule\(/);
        expectations.push(['script-src-elem', blob]);
        if (/MediaSource/.test(all)) expectations.push(['media-src', blob]);
        if (/new Image\b/.test(all) && /createObjectURL/.test(all)) expectations.push(['img-src', blob]);
        const refused = expectations.filter(([d, u]) => !allowsUrl(policy, d, u, page)).map(([d, u]) => `${d} ${u}`);
        expect(refused).toEqual([]);
        // MediaPipe and ONNX Runtime compile WebAssembly.
        expect(files.some((f) => f.endsWith('.wasm'))).toBe(true);
        expect(allowsWasm(policy)).toBe(true);
      });
    });
  }

  it('needs no eval anywhere on the page (the policy has no unsafe-eval)', async () => {
    const { policy } = await servedPolicy(HOSTS[0].page);
    expect(allowsEval(policy)).toBe(false);
    const offenders = code.filter(({ text }) => /\beval\(|\bnew Function\(/.test(text)).map((c) => c.file);
    expect(offenders).toEqual([]);
  });

  it('the YAMNet worker loads its model from our own origin only', () => {
    const worker = code.find((c) => /yamnet\.worker-/.test(c.file))!;
    expect(worker.text).toContain('/models/yamnet/yamnet-v1.onnx');
    expect(worker.text).not.toMatch(/huggingface\.co/);
  });

  it('every built file fits Cloudflare Pages (25 MiB per file)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    const tooBig = walk(DIST).filter((f) => statSync(f).size > 25 * 1024 * 1024).map((f) => path.relative(DIST, f));
    expect(tooBig).toEqual([]);
  });

  it('ships security.txt with the build', () => {
    expect(existsSync(path.join(DIST, '.well-known/security.txt'))).toBe(true);
  });
});
