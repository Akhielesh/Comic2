// The platform renderers stay out of the entry chunk (platform plan §12 W1.7 / W1.8). docx, the vendored PptxGenJS and
// the Markdown → RichDoc converter are loaded only when someone exports (services/platformExport.ts: one `import()`
// each), so a first paint never pays for them. This test reads the REAL production build: for each renderer the app
// calls, its marker strings must be ABSENT from every eagerly loaded chunk (each HTML entry's module script, its
// modulepreloads and everything they import statically) and PRESENT in at least one other chunk, so a marker that
// vanishes (a minifier change, a re-vendored library) fails here instead of passing silently.
//
// Markers (render waveNote 4, corrected; each is a string literal that survives minification and appears in exactly
// one renderer chunk): docx 'w:document'; pptx 'PptxGenJS' (the library's default author) and 'addMedia() is
// disabled' (the vendored P2 guard); markdown 'The rest of this document was too long to include.' (the note names
// no surviving markdown marker: '[DreamStream P0]' and 'remark-gfm' are comments, and remark is already in the app
// through the chat's Markdown, so this sentence from packages/platform-render/src/markdown.ts stands in).
//
// A renderer nothing in the app calls yet is tree-shaken out of the build entirely (W1.9 adds the first docx and
// markdown callers); for it the test only checks that its markers are not eagerly loaded. Whether the app calls a
// renderer is read from the app's own source, not from the build, so a renderer that is called but whose marker is
// missing fails.
//
// How it runs: CI's `verify` job runs `npm run build` before `npm test -- --run` (.github/workflows/ci.yml), so dist/
// is the build of this very commit; there, a missing dist/ fails the test. Locally, run `npm run build` first; without
// a dist/ the test is skipped (a full build is ~1 min and ~2 GB, too heavy for every test run). PLATFORM_CHUNKS_DIST
// points it at another build directory.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = path.resolve(__dirname, '../..');
const DIST = process.env.PLATFORM_CHUNKS_DIST ? path.resolve(process.env.PLATFORM_CHUNKS_DIST) : path.join(APP, 'dist');
const HTML_ENTRIES = ['index.html', 'live.html'];
const built = existsSync(path.join(DIST, 'index.html'));
const inCi = !!process.env.CI;

interface Renderer {
  name: 'docx' | 'pptx' | 'markdown';
  markers: string[];
  /** A call in app code that loads this renderer (through services/platformExport.ts). */
  callers: RegExp;
}

const RENDERERS: Renderer[] = [
  { name: 'docx', markers: ['w:document'], callers: /\b(?:exportDocx|exportMarkdownDocx|loadDocx|loadPlatformRender)\s*\(/ },
  { name: 'pptx', markers: ['PptxGenJS', 'addMedia() is disabled'], callers: /\b(?:exportPptx|loadPptx|loadPlatformRender)\s*\(/ },
  { name: 'markdown', markers: ['The rest of this document was too long to include.'], callers: /\b(?:exportMarkdownDocx|loadMarkdown|loadPlatformRender)\s*\(/ },
];

/** App source that ships to the browser: no tests, no server, no packages (the renderers themselves), no build output. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-qa', 'server', 'packages', 'tests', 'qa', 'scripts', 'docs', 'public', 'api-proxy', 'live-worker', 'email-worker', 'data-egress', 'comics-edge', 'functions', 'deploy', '.git']);
const LOADER = path.join(APP, 'services', 'platformExport.ts');

const appSources = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.startsWith('.') && name !== '__fixtures__') walk(full);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') && full !== LOADER) {
        out.push(full);
      }
    }
  };
  walk(APP);
  return out;
};

/** Files (relative to the app) whose code calls this renderer. */
const callersOf = (r: Renderer, sources: string[]): string[] =>
  sources.filter((f) => r.callers.test(readFileSync(f, 'utf8'))).map((f) => path.relative(APP, f));

const STATIC_IMPORT = /\bfrom\s*["']\.\/([\w.-]+\.js)["']|\bimport\s*["']\.\/([\w.-]+\.js)["']/g;

/** The chunks a page loads before any `import()`: its module scripts and modulepreloads, and their static imports. */
const eagerChunks = (assets: string): Set<string> => {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const html of HTML_ENTRIES) {
    const file = path.join(DIST, html);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="\/assets\/([^"]+\.js)"/g)) queue.push(m[1]);
    for (const m of text.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="\/assets\/([^"]+\.js)"/g)) queue.push(m[1]);
  }
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name) || !existsSync(path.join(assets, name))) continue;
    seen.add(name);
    const code = readFileSync(path.join(assets, name), 'utf8');
    for (const m of code.matchAll(STATIC_IMPORT)) queue.push(m[1] || m[2]);
  }
  return seen;
};

describe('platform renderers stay out of the entry chunk (real build)', () => {
  it('a build is there to check (CI builds before it tests)', () => {
    if (inCi) expect(built, `no ${path.relative(APP, DIST)}/index.html: run \`npm run build\` before the tests`).toBe(true);
  });

  describe.skipIf(!built)('dist/', () => {
    const assets = path.join(DIST, 'assets');
    const chunks = built ? readdirSync(assets).filter((f) => f.endsWith('.js')) : [];
    const eager = built ? eagerChunks(assets) : new Set<string>();
    const lazy = chunks.filter((c) => !eager.has(c));
    const read = (name: string) => readFileSync(path.join(assets, name), 'utf8');
    const sources = appSources();

    it('finds the entry chunks and their static imports, and lazy chunks besides', () => {
      expect([...eager].some((c) => /^main-/.test(c))).toBe(true);
      expect(eager.size).toBeGreaterThan(1); // the entry imports at least the React vendor chunk
      expect(lazy.length).toBeGreaterThan(0);
    });

    it('the comic pitch deck calls the PowerPoint renderer, so its markers must be in the build', () => {
      expect(callersOf(RENDERERS.find((r) => r.name === 'pptx')!, sources)).toContain(path.join('components', 'comicstudio', 'export', 'pitchDeck.ts'));
    });

    for (const r of RENDERERS) {
      it(`${r.name}: markers are never eagerly loaded, and are in a lazy chunk whenever the app calls it`, () => {
        const callers = callersOf(r, sources);
        for (const marker of r.markers) {
          const inEager = [...eager].filter((c) => read(c).includes(marker));
          expect(inEager, `"${marker}" (${r.name}) is in an eagerly loaded chunk`).toEqual([]);
          if (callers.length) {
            const inLazy = lazy.filter((c) => read(c).includes(marker));
            expect(inLazy.length, `"${marker}" (${r.name}, called from ${callers.join(', ')}) is in no lazy chunk: the marker vanished or the renderer moved`).toBeGreaterThan(0);
          }
        }
      });
    }
  });
});
