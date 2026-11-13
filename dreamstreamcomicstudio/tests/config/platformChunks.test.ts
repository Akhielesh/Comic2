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
import { gzipSync } from 'node:zlib';
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

/**
 * Pro code the reader and the first paint never load (master plan §2.8: the Pro chunk is lazy, never in the reader's
 * first load). Each marker is a literal that survives minification and that only this code holds; none may be in an
 * eagerly loaded chunk or in the reader's own chunk (ComicReaderView-*). PE-QA (S3) extends this list (effect
 * generators, font tables, the Pro editor); the scan below stays the same.
 */
interface ProOnly {
  name: string;
  markers: string[];
}

const PRO_ONLY: ProOnly[] = [
  // PE-MOTION-ENGINE wave note 8: Penner's bounce constant and the seeded hash's multiplier (0x9e3779b1, as minified),
  // the same markers shared/comic/motion/chunks.test.ts checks on an esbuild bundle.
  { name: 'motion engine', markers: ['7.5625', '2654435761'] },
];

/**
 * The first-load ceiling per HTML entry: the gzip -9 bytes of its module scripts, modulepreloads and their static imports
 * (what every visitor pays before first paint, the public share reader and the comics landing included). S2b grew the
 * site entry from 279,251 B (99b870c4) to 303,837 B (the S2b integration): tailwind-merge and 17 components/ds modules
 * moved onto the critical path (App.tsx's cn and DS primitives, DS-3's eager AuthPage, DS-2's StaticSiteHeader).
 *
 * Lead decision D17b (the S2b release; docs/features/pro-edit.md §8): that growth is ACCEPTED for this release with the
 * ceiling pinned; the cut (AuthPage and the Toast host lazy, a clsx-only `cx` in eager chrome) is a later performance
 * package. Taking production's three releases into S2b then raised the site entry from 303,837 B to 308,786 B (+4,949 B),
 * measured on a production build of the merged tree: about three quarters is the slim-reads release's save guards and
 * card projection in hooks/useProjectManager.ts and services/db.ts, the rest is the comics host's own header
 * (ComicsHeader and its routing, which App draws on sign-in, Privacy, Terms and the Library) and the public-page recipes;
 * the token waitlist form gives some back. All of it already ships on production. The ceiling rises by exactly that
 * measured amount (306,000 + 4,949, rounded up to 310,950), so it still holds the measured number plus the same ~2 KB
 * for zlib and build noise: nothing grows it unseen. live.html is unchanged (314,239 B measured). A cut lowers the
 * ceiling here; a reviewed rise raises it with the lead's decision named beside it.
 */
const EAGER_GZ_CEILING: Record<string, number> = { 'index.html': 310_950, 'live.html': 316_500 };

/** The reader's own chunk: the comic reader is code-split from the studio (one lazy chunk per entry). */
const READER_CHUNK = /^ComicReaderView-[\w-]+\.js$/;

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
const eagerChunks = (assets: string, entries: string[] = HTML_ENTRIES): Set<string> => {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const html of entries) {
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

    for (const [html, ceiling] of Object.entries(EAGER_GZ_CEILING)) {
      it(`${html}: the first load stays under its gzip ceiling (${ceiling.toLocaleString('en')} B)`, () => {
        const files = [...eagerChunks(assets, [html])];
        expect(files.length, `${html} loads no module script`).toBeGreaterThan(0);
        const gz = files.reduce((sum, f) => sum + gzipSync(readFileSync(path.join(assets, f)), { level: 9 }).length, 0);
        expect(gz, `${html} first load is ${gz} B gz (${files.join(', ')}); lower EAGER_GZ_CEILING after a cut, or raise it with a lead decision`).toBeLessThanOrEqual(ceiling);
      });
    }

    it('the comic pitch deck calls the PowerPoint renderer, so its markers must be in the build', () => {
      expect(callersOf(RENDERERS.find((r) => r.name === 'pptx')!, sources)).toContain(path.join('components', 'comicstudio', 'export', 'pitchDeck.ts'));
    });

    for (const pro of PRO_ONLY) {
      it(`${pro.name}: never in an eagerly loaded chunk or in the reader's chunk`, () => {
        const reader = chunks.filter((c) => READER_CHUNK.test(c));
        expect(reader.length, 'no ComicReaderView-* chunk in the build: the reader chunk was renamed or merged').toBeGreaterThan(0);
        const scanned = [...new Set([...eager, ...reader])];
        for (const marker of pro.markers) {
          expect(scanned.filter((c) => read(c).includes(marker)), `"${marker}" (${pro.name}) is in the reader or an eagerly loaded chunk`).toEqual([]);
        }
      });
    }

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
