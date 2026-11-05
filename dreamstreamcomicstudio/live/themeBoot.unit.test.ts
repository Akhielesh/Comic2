// @vitest-environment node
// public/live-theme-boot.js — the stored appearance on <html> before first paint (live.html loads it
// in <head>; the page's CSP allows no inline script). It is a hand-written copy of live/theme.ts's
// parsing, so this runs the real file in a fresh page next to theme.ts on the same storage and fails
// the moment the two disagree: the storage keys, the defaults, the allowed values, the legacy theme
// key, the theme-color values, with the Atlas skin on and off. It also pins how the file is served:
// a content-hash URL in live.html, cached for good, never through the Pages Function.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { APPEARANCE_KEY, LEGACY_THEME_KEY, parseAppearance, themeColorFor } from './theme';

const file = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const BOOT = file('../public/live-theme-boot.js');
const LIVE_HTML = file('../live.html');

const PAGE = (skin: boolean) => `<!doctype html><html${skin ? ' data-ds-skin="atlas"' : ''}><head>
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">
</head><body></body></html>`;

/** Runs the boot file in a fresh page with this storage; returns what it put on <html>. */
function boot(storage: Record<string, string>, opts: { skin: boolean; blocked?: boolean }) {
  const dom = new JSDOM(PAGE(opts.skin), { url: 'https://stream.dreamstreamstudio.ai/', runScripts: 'outside-only' });
  for (const [k, v] of Object.entries(storage)) dom.window.localStorage.setItem(k, v);
  if (opts.blocked) {
    Object.defineProperty(dom.window, 'localStorage', {
      get() {
        throw new Error('SecurityError: storage blocked');
      },
    });
  }
  dom.window.eval(BOOT);
  const el = dom.window.document.documentElement;
  return {
    theme: el.getAttribute('data-theme'),
    density: el.getAttribute('data-density'),
    corners: el.getAttribute('data-corners'),
    metas: [...dom.window.document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content')),
  };
}

/** What theme.ts decides for the same storage. */
function bundle(storage: Record<string, string>, skin: boolean) {
  const a = parseAppearance(storage[APPEARANCE_KEY] ?? null, storage[LEGACY_THEME_KEY] ?? null);
  const color = themeColorFor(a.theme, skin);
  return { theme: a.theme, density: a.density, corners: a.corners, metas: [color, color] };
}

const CASES: [name: string, storage: Record<string, string>][] = [
  ['nothing stored (light by default, whatever the OS says)', {}],
  ['dark, pro, sharp', { [APPEARANCE_KEY]: JSON.stringify({ theme: 'dark', accent: 'plum', density: 'pro', corners: 'sharp', studioLayout: 'cinema' }) }],
  ['light, calm, soft', { [APPEARANCE_KEY]: JSON.stringify({ theme: 'light', density: 'calm', corners: 'soft' }) }],
  ['only some fields', { [APPEARANCE_KEY]: JSON.stringify({ corners: 'sharp' }) }],
  ['unknown values', { [APPEARANCE_KEY]: JSON.stringify({ theme: 'sepia', density: 'max', corners: 3 }) }],
  ['unreadable JSON', { [APPEARANCE_KEY]: '{oops' }],
  ['a JSON string', { [APPEARANCE_KEY]: '"dark"' }],
  ['a JSON array', { [APPEARANCE_KEY]: '[]' }],
  ['JSON null, with a legacy key', { [APPEARANCE_KEY]: 'null', [LEGACY_THEME_KEY]: 'dark' }],
  ['legacy key only: dark', { [LEGACY_THEME_KEY]: 'dark' }],
  ['legacy key only: light', { [LEGACY_THEME_KEY]: 'light' }],
  ['legacy key only: anything else', { [LEGACY_THEME_KEY]: '1' }],
  ['both keys: the appearance wins', { [APPEARANCE_KEY]: JSON.stringify({ density: 'pro' }), [LEGACY_THEME_KEY]: 'dark' }],
];

describe('public/live-theme-boot.js decides exactly what live/theme.ts decides', () => {
  it('reads the same storage keys', () => {
    expect(BOOT).toContain(`'${APPEARANCE_KEY}'`);
    expect(BOOT).toContain(`'${LEGACY_THEME_KEY}'`);
  });

  for (const skin of [true, false]) {
    for (const [name, storage] of CASES) {
      it(`${name} — skin ${skin ? 'on' : 'off'}`, () => {
        expect(boot(storage, { skin })).toEqual(bundle(storage, skin));
      });
    }
  }

  it('storage that throws (private mode, sandboxed) leaves the defaults and never breaks the page', () => {
    expect(boot({}, { skin: true, blocked: true })).toEqual(bundle({}, true));
  });

  it('is a classic script with no globals, no network and no accent (the bundle owns the accent)', () => {
    expect(BOOT).toMatch(/^\/\*[\s\S]*?\*\/\s*\(function \(\) \{/);
    expect(BOOT).not.toMatch(/\bfetch\(|XMLHttpRequest|import\(|document\.write|innerHTML|eval\(/);
    expect(BOOT).not.toMatch(/--accent|setProperty/);
  });
});

describe('how live.html loads it', () => {
  const hash = createHash('sha256').update(BOOT).digest('hex').slice(0, 8);

  it(`by its content hash (?v=${hash}), so a change is a new URL — update live.html when the file changes`, () => {
    const srcs = [...LIVE_HTML.matchAll(/<script[^>]*\ssrc="([^"]*live-theme-boot\.js[^"]*)"/g)].map((m) => m[1]);
    expect(srcs).toEqual([`/live-theme-boot.js?v=${hash}`]);
  });

  it('blocking in <head>, before anything paints (not async, not deferred, not a module)', () => {
    const head = LIVE_HTML.slice(0, LIVE_HTML.indexOf('</head>'));
    const tag = /<script[^>]*live-theme-boot\.js[^>]*>/.exec(head);
    expect(tag).toBeTruthy();
    expect(tag![0]).not.toMatch(/\b(async|defer|type="module")\b/);
    // After the theme-color metas it updates.
    expect(head.lastIndexOf('<meta name="theme-color"')).toBeLessThan(tag!.index);
  });

  it('cached for good (the URL changes with the file), and never through the Pages Function', () => {
    const headers = file('../public/_headers');
    const block = headers.split('\n/live-theme-boot.js\n')[1]?.split('\n\n')[0] ?? '';
    expect(block).toMatch(/Cache-Control: public, max-age=31536000, immutable/);
    const routes = JSON.parse(file('../public/_routes.json')) as { exclude: string[] };
    expect(routes.exclude).toContain('/live-theme-boot.js');
  });
});
