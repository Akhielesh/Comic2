// @vitest-environment node
// live.html as a browser receives it, before any script: the Atlas skin attribute (static, so it
// can't flash and needs no script), no inline script at all (the page's CSP is script-src 'self';
// tests/edge/liveCsp.built.test.ts checks the BUILT page against the served header), the
// theme-color pair, the On-air icons, the self-hosted chrome fonts, and the static boot splash React
// replaces — whose rules (and the shared mark's loading loop) the account splash reuses, so the
// hand-over moves nothing.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { MARK_POINT_RADIUS, MARK_STROKE, MARK_TILE_RADIUS, STUDIO_MARKS } from '../components/brand/studios';

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const SOURCE = readFileSync(path('../live.html'), 'utf8');
// Parsed with scripting off, as the no-JavaScript visitor sees it (<noscript> content is markup).
const doc = new JSDOM(SOURCE).window.document;
const html = doc.documentElement;
const style = [...doc.head.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');

describe('live.html — the page before any script', () => {
  it('carries the Atlas skin statically, and leaves the theme to the stored appearance', () => {
    expect(html.getAttribute('data-ds-skin')).toBe('atlas');
    // No static data-theme: live-theme-boot.js sets the stored one before first paint, and without
    // JavaScript the splash follows the OS colour scheme instead of forcing light.
    expect(html.hasAttribute('data-theme')).toBe(false);
    expect(html.getAttribute('data-density')).toBe('calm');
    expect(html.getAttribute('data-corners')).toBe('soft');
    expect(html.getAttribute('lang')).toBe('en');
  });

  it('has no inline script and no inline event handler', () => {
    const scripts = [...doc.querySelectorAll('script')];
    expect(scripts.filter((s) => !s.hasAttribute('src'))).toEqual([]);
    expect(scripts.map((s) => s.getAttribute('src'))).toEqual([expect.stringMatching(/^\/live-theme-boot\.js\?v=[0-9a-f]{8}$/), '/live/main.tsx']);
    const handlers = [...doc.querySelectorAll('*')].flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${el.tagName}[${a.name}]`));
    expect(handlers).toEqual([]);
  });

  it('the browser chrome matches the page: #ffffff light, #0a0a0a dark', () => {
    const metas = [...doc.querySelectorAll('meta[name="theme-color"]')].map((m) => [m.getAttribute('content'), m.getAttribute('media')]);
    expect(metas).toEqual([
      ['#ffffff', '(prefers-color-scheme: light)'],
      ['#0a0a0a', '(prefers-color-scheme: dark)'],
    ]);
  });

  it('wears the On-air icons: an ICO and an SVG favicon, and a PNG touch icon (iOS ignores an SVG one)', () => {
    const links = [...doc.head.querySelectorAll('link')].map((l) => [l.getAttribute('rel'), l.getAttribute('href'), l.getAttribute('type'), l.getAttribute('sizes')]);
    expect(links.filter(([rel]) => rel === 'icon' || rel === 'apple-touch-icon')).toEqual([
      ['icon', '/icons/stream-favicon.ico', null, '32x32'],
      ['icon', '/icons/stream-favicon.svg', 'image/svg+xml', null],
      ['apple-touch-icon', '/icons/stream-apple-touch-180.png', null, null],
    ]);
    // The main app's own manifest; main.tsx swaps in /stream.webmanifest on Stream Studio's host.
    expect(links.filter(([rel]) => rel === 'manifest').map(([, href]) => href)).toEqual(['/live.webmanifest']);
  });

  it('preloads the self-hosted chrome fonts it paints first (files that exist), crossorigin', () => {
    const preloads = [...doc.querySelectorAll('link[rel="preload"][as="font"]')];
    expect(preloads.map((l) => l.getAttribute('href'))).toEqual([
      '/fonts/ibm-plex-sans-latin-400-normal.woff2',
      '/fonts/ibm-plex-sans-latin-600-normal.woff2',
      '/fonts/space-grotesk-latin-600-normal.woff2',
      // The lockup's "Studio" (components/brand/studio-marks.css .ds-logo-word-muted), on every screen.
      '/fonts/space-grotesk-latin-500-normal.woff2',
    ]);
    for (const l of preloads) {
      expect(l.hasAttribute('crossorigin')).toBe(true);
      expect(l.getAttribute('type')).toBe('font/woff2');
      expect(existsSync(path(`../public${l.getAttribute('href')}`))).toBe(true);
    }
  });

  it('keeps Hanken Grotesk (the compositor burns it into broadcasts) and JetBrains Mono; Newsreader is gone', () => {
    const css = [...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href') ?? '');
    const google = css.filter((h) => h.startsWith('https://fonts.googleapis.com/'));
    expect(google).toHaveLength(1);
    expect(google[0]).toContain('family=Hanken+Grotesk');
    expect(google[0]).toContain('family=JetBrains+Mono');
    expect(SOURCE).not.toMatch(/Newsreader/);
    expect(readFileSync(path('./studio/compositor.ts'), 'utf8')).toContain("'Hanken Grotesk'");
  });
});

describe('the boot splash (static, inside #live-root until React renders)', () => {
  const root = doc.getElementById('live-root')!;
  const splash = root.querySelector('[data-live-boot]');

  it('is the only thing in #live-root: the Stream on-air mark, the wordmark, a progress line, a status line', () => {
    expect(root.children).toHaveLength(1);
    expect(splash?.classList.contains('boot-page')).toBe(true);
    const mark = splash!.querySelector('svg.boot-mark');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(mark?.getAttribute('viewBox')).toBe('0 0 64 64');
    expect(splash!.querySelector('.boot-word')?.textContent).toBe('Stream Studio');
    expect(splash!.querySelector('.boot-bar i')).toBeTruthy();
    expect(splash!.querySelector('[role="status"]')?.textContent).toContain('Opening Stream Studio');
  });

  it('draws the approved Stream Studio mark exactly as StudioMark does (one rx 16 tile in currentColor, the on-air cut through a mask)', () => {
    const spec = STUDIO_MARKS.stream;
    const mask = splash!.querySelector('mask')!;
    expect(mask.getAttribute('maskUnits')).toBe('userSpaceOnUse');
    expect(mask.querySelector('rect')?.getAttribute('rx')).toBe(String(MARK_TILE_RADIUS));
    const cut = mask.querySelector('path')!;
    expect(cut.getAttribute('d')).toBe(spec.cut);
    expect(cut.getAttribute('stroke-width')).toBe(String(MARK_STROKE));
    const point = mask.querySelector('circle')!;
    expect([point.getAttribute('cx'), point.getAttribute('cy')]).toEqual(spec.point.map(String));
    expect(point.getAttribute('r')).toBe(String(MARK_POINT_RADIUS));
    const tile = splash!.querySelector('svg > rect')!;
    expect(tile.getAttribute('fill')).toBe('currentColor');
    expect(tile.getAttribute('mask')).toBe(`url(#${mask.id})`);
  });

  it('loops the mark’s broadcast with the shared stylesheet’s classes (studio-marks.css, in the render-blocking bundle CSS)', () => {
    const mark = splash!.querySelector('svg.boot-mark')!;
    expect([...mark.classList]).toEqual(['boot-mark', 'ds-logo-mark', 'ds-logo-mark--stream', 'ds-logo-mark--loading']);
    expect(mark.getAttribute('data-studio')).toBe('stream');
    expect(mark.querySelector('mask path')?.getAttribute('class')).toBe('ds-logo-cut');
    expect(mark.querySelector('mask circle')?.getAttribute('class')).toBe('ds-logo-point');
    const brandCss = readFileSync(path('../components/brand/studio-marks.css'), 'utf8');
    for (const cls of ['ds-logo-mark--loading', 'ds-logo-mark--stream', 'ds-logo-cut', 'ds-logo-point']) expect(brandCss).toContain(`.${cls}`);
  });

  it('tells a visitor without JavaScript what to do (no progress line, and the mark holds still: nothing is loading)', () => {
    expect(splash!.querySelector('noscript')?.textContent).toMatch(/needs JavaScript/);
    const noscript = [...doc.head.querySelectorAll('noscript')].map((n) => n.textContent).join('');
    expect(noscript).toMatch(/\.boot-bar[^{]*\{\s*display:\s*none/);
    expect(noscript).toMatch(/\.boot-mark \*\s*\{\s*animation:\s*none !important/);
  });

  it('without JavaScript the status says only that JavaScript is needed — not "Opening…", not "Still loading"', () => {
    const noscript = [...doc.head.querySelectorAll('noscript')].map((n) => n.textContent).join('');
    const hidden = /([^{}]+)\{\s*display:\s*none/.exec(noscript)![1].split(',').map((x) => x.trim());
    const status = splash!.querySelector('[role="status"]')!;
    for (const child of status.children) {
      if (child.tagName === 'NOSCRIPT') continue;
      const cls = [...child.classList].map((c) => `.${c}`);
      expect(cls.some((c) => hidden.includes(c)), `${child.outerHTML.slice(0, 60)} is hidden without JavaScript`).toBe(true);
    }
  });

  it('says so if loading stalls, without a script (a CSS-delayed line, out of the layout)', () => {
    expect(splash!.querySelector('.boot-slow')?.textContent).toMatch(/Still loading/);
    expect(style).toMatch(/\.boot-slow\s*\{[^}]*position:\s*absolute[^}]*animation:\s*live-boot-slow[^;]*12s/);
  });

  it('keeps "Still loading" out of the status (and so out of screen readers) until it shows', () => {
    // Opacity alone leaves text in the accessibility tree: the line is visibility: hidden until its
    // own keyframes reveal it, so the status announces it at 12 s, not the moment the page opens.
    const rule = /\.boot-slow\s*\{([^}]*)\}/.exec(style)![1];
    expect(rule).toMatch(/visibility:\s*hidden/);
    expect(style).toMatch(/@keyframes live-boot-slow\s*\{\s*to\s*\{[^}]*opacity:\s*1[^}]*visibility:\s*visible/);
    // The shared progress-line keyframes stay opacity-only: a forwards-filled visibility there
    // would beat the reduced-motion `.boot-bar { visibility: hidden }`.
    expect(/@keyframes live-boot-show\s*\{([^}]*\})\s*\}/.exec(style)![1]).not.toMatch(/visibility/);
    // Reduced motion: it still appears after the delay (no transition, same 12 s).
    expect(style).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*?\.boot-slow\s*\{\s*animation-duration:\s*0s/);
  });

  it('is calm: no entrance; under reduced motion no moving line; dark without JavaScript when the OS is dark', () => {
    expect(style).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*?\.boot-bar\s*\{\s*visibility:\s*hidden/);
    expect(style).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*html:not\(\[data-theme\]\) \.boot-page\s*\{[^}]*#0a0a0a/);
    expect(style).not.toMatch(/\.boot-page\s*\{[^}]*animation/);
  });

  it('shares its rules with the account splash that follows it (SignInGate GateSplash), so nothing moves', () => {
    const gate = readFileSync(path('./views/account/SignInGate.tsx'), 'utf8');
    const fn = gate.slice(gate.indexOf('function GateSplash'), gate.indexOf('\n}\n', gate.indexOf('function GateSplash')));
    for (const cls of ['boot-page', 'boot', 'boot-mark', 'boot-word', 'boot-bar', 'boot-note']) {
      expect(fn, `GateSplash uses .${cls}`).toMatch(new RegExp(`className="[^"]*\\b${cls}\\b`));
      expect(style, `live.html styles .${cls}`).toMatch(new RegExp(`\\.${cls}[\\s{,]`));
    }
    // The same mark, looping the same way, picked up at the static one's phase.
    expect(fn).toMatch(/<StudioMark studio="stream" className="boot-mark" loading \/>/);
    expect(fn).toContain('continueBootMark(');
  });

  it('sets the wordmark like the StudioLogo lockup: Space Grotesk 600, tight, "Studio" at 500 and 55 %', () => {
    expect(style).toMatch(/\.boot-word\s*\{[^}]*font-weight:\s*600[^}]*letter-spacing:\s*-0\.025em/);
    expect(style).toMatch(/\.boot-word span\s*\{\s*font-weight:\s*500;\s*opacity:\s*0\.55/);
    // The lockup's rules sit in :where() (zero specificity), so the selector may close a paren before the brace.
    const brandCss = readFileSync(path('../components/brand/studio-marks.css'), 'utf8');
    expect(style).toMatch(/\.boot-word\s*\{[^}]*font-family:\s*"Space Grotesk"/);
    expect(brandCss).toMatch(/\.ds-logo-word\)?\s*\{[^}]*font-family:\s*"Space Grotesk"[^}]*font-weight:\s*600;[^}]*letter-spacing:\s*-0\.025em/);
    expect(brandCss).toMatch(/\.ds-logo-word-muted\)?\s*\{\s*font-weight:\s*500;\s*opacity:\s*0\.55/);
  });
});
