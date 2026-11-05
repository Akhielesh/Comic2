// @vitest-environment node
// live.html as a browser receives it, before any script: the Atlas skin attribute (static, so it
// can't flash and needs no script), no inline script at all (the page's CSP is script-src 'self';
// tests/edge/liveCsp.built.test.ts checks the BUILT page against the served header), the
// theme-color pair, the self-hosted chrome fonts, and the static boot splash React replaces —
// whose rules the account splash reuses, so the hand-over moves nothing.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

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

  it('preloads the self-hosted chrome fonts it paints first (files that exist), crossorigin', () => {
    const preloads = [...doc.querySelectorAll('link[rel="preload"][as="font"]')];
    expect(preloads.map((l) => l.getAttribute('href'))).toEqual([
      '/fonts/ibm-plex-sans-latin-400-normal.woff2',
      '/fonts/ibm-plex-sans-latin-600-normal.woff2',
      '/fonts/space-grotesk-latin-600-normal.woff2',
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

  it('draws the approved Stream Studio mark (one rx 16 tile in currentColor, the on-air cut through a mask)', () => {
    const mask = splash!.querySelector('mask')!;
    expect(mask.getAttribute('maskUnits')).toBe('userSpaceOnUse');
    expect(mask.querySelector('rect')?.getAttribute('rx')).toBe('16');
    const cut = mask.querySelector('path')!;
    expect(cut.getAttribute('d')).toBe('M40.99 18.16 A16.5 16.5 0 0 1 40.99 45.84 M23.01 45.84 A16.5 16.5 0 0 1 23.01 18.16');
    expect(cut.getAttribute('stroke-width')).toBe('7');
    expect(mask.querySelector('circle')?.getAttribute('r')).toBe('3.6');
    const tile = splash!.querySelector('svg > rect')!;
    expect(tile.getAttribute('fill')).toBe('currentColor');
    expect(tile.getAttribute('mask')).toBe(`url(#${mask.id})`);
  });

  it('tells a visitor without JavaScript what to do (and hides the progress line for them)', () => {
    expect(splash!.querySelector('noscript')?.textContent).toMatch(/needs JavaScript/);
    expect([...doc.head.querySelectorAll('noscript')].map((n) => n.textContent).join('')).toMatch(/\.boot-bar[^{]*\{\s*display:\s*none/);
  });

  it('says so if loading stalls, without a script (a CSS-delayed line, out of the layout)', () => {
    expect(splash!.querySelector('.boot-slow')?.textContent).toMatch(/Still loading/);
    expect(style).toMatch(/\.boot-slow\s*\{[^}]*position:\s*absolute[^}]*animation:\s*live-boot-show[^;]*12s/);
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
  });
});
