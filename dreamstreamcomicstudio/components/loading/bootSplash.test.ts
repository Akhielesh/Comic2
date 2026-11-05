// @vitest-environment node
/**
 * The index.html boot splash and head (app-level loading, step 3). The splash is plain HTML and inline CSS,
 * painted before any script runs, so no component test sees it: this reads the file.
 *
 * - It is the DreamStream mark and wordmark over a thin indeterminate bar on the page canvas, in the Atlas
 *   language: tokens with fallbacks, dark from `.dark` (theme-boot.js), still under reduced motion.
 * - Its numbers are AppLoader's (bootGeometry.ts), so React's boot screen replaces it without a visible change.
 * - The watchdog contract holds: `#app-splash .slow` and `#app-splash-reload` exist for the page's single
 *   CSP-hashed inline script (securityHeaders.test.ts checks the hash itself).
 * - No comic-era chrome is left: no blue polka dots, yellow scrollbar or yellow selection.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { MARK_POINT_RADIUS, MARK_STROKE, MARK_TILE_RADIUS, MARK_VIEWBOX, STUDIO_MARKS } from '../brand/studios';
import { BOOT, SPLASH_BAR_SELECTOR } from './bootGeometry';

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(path.join(APP_ROOT, rel), 'utf8');
const HTML = read('index.html');
const HEAD = HTML.slice(0, HTML.indexOf('</head>'));
const doc = new JSDOM(HTML).window.document;
/** The page's own inline stylesheet (the first <style>; the second is the <noscript> one). */
const CSS = doc.querySelector('head > style')!.textContent ?? '';
const NOSCRIPT_CSS = HEAD.match(/<noscript><style>([\s\S]*?)<\/style><\/noscript>/)?.[1] ?? '';

/** The declarations of the rule whose selector is exactly `selector` (first match). */
const rule = (selector: string, css = CSS): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return m?.[1] ?? '';
};
const decl = (body: string, prop: string): string | undefined =>
  body.match(new RegExp(`(?:^|[;\\s{])${prop}\\s*:\\s*([^;]+);`))?.[1]?.trim();

describe('index.html head', () => {
  it('names the studios that ship (Comics, Live and Chat), never the retired Code Studio', () => {
    expect(doc.title).toBe('DreamStream Studio — Comics, Live and Chat');
    const description = doc.querySelector('meta[name="description"]')!.getAttribute('content')!;
    expect(description).toMatch(/comics/i);
    expect(description).toMatch(/Stream Studio/);
    expect(description).toMatch(/Chat Studio/);
    expect(`${doc.title} ${description}`).not.toMatch(/\bcode\b/i);
    expect(doc.querySelector('meta[name="application-name"]')!.getAttribute('content')).toBe('DreamStream Studio');
  });

  it('colours the dark browser chrome with the Atlas dark canvas', () => {
    expect(doc.querySelector('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]')!.getAttribute('content')).toBe('#0a0a0a');
  });

  it('keeps exactly one inline script (the CSP-hashed watchdog) and the external theme boot before the CSS', () => {
    const inline = [...doc.querySelectorAll('script:not([src])')];
    expect(inline).toHaveLength(1);
    expect(inline[0].textContent).toContain("document.querySelector('#app-splash .slow')");
    expect(inline[0].textContent).toContain("document.getElementById('app-splash-reload')");
    expect(HEAD.indexOf('<script src="/theme-boot.js"></script>')).toBeLessThan(HEAD.indexOf('<link rel="stylesheet" href="/index.css">'));
  });

  it('has no comic-era chrome left: polka dots, the yellow scrollbar, yellow selection, the blue splash', () => {
    expect(HTML).not.toMatch(/#3B82F6|#60A5FA|#FACC15|#18181b/i);
    expect(HTML).not.toMatch(/radial-gradient|custom-scrollbar|::-webkit-scrollbar/);
    expect(HTML).not.toMatch(/brand-yellow|selection:/);
    expect(doc.body.className.split(/\s+/)).not.toContain('selection:bg-brand-yellow');
  });

  it('paints the page canvas from the first frame, on the tokens, light and dark', () => {
    expect(decl(rule('html, body'), 'background-color')).toBe('var(--ds-canvas, #ffffff)');
    expect(decl(rule('html.dark, html.dark body'), 'background-color')).toBe('var(--ds-canvas, #0a0a0a)');
  });
});

describe('the boot splash', () => {
  const splash = doc.getElementById('app-splash')!;

  it('sits in #root, so React replaces it on mount, and is a status region that says what is loading', () => {
    expect(splash.parentElement!.id).toBe('root');
    expect(splash.getAttribute('role')).toBe('status');
    expect(splash.querySelector('.ds-boot-sr')!.textContent).toBe('Loading DreamStream Studio…');
    expect(splash.querySelector('.ds-boot-lockup')!.getAttribute('aria-hidden')).toBe('true');
    expect(splash.querySelector('.ds-boot-track')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws the DreamStream mark exactly as components/brand does (one tile, one cut, one point)', () => {
    const svg = splash.querySelector('svg.ds-boot-mark')!;
    const spec = STUDIO_MARKS.dreamstream;
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`);
    const mask = svg.querySelector('mask')!;
    const maskId = mask.getAttribute('id')!;
    expect(mask.querySelector('rect')!.getAttribute('rx')).toBe(String(MARK_TILE_RADIUS));
    expect(mask.querySelector('path')!.getAttribute('d')).toBe(spec.cut);
    expect(mask.querySelector('path')!.getAttribute('stroke-width')).toBe(String(MARK_STROKE));
    const point = mask.querySelector('circle')!;
    expect([Number(point.getAttribute('cx')), Number(point.getAttribute('cy'))]).toEqual([...spec.point]);
    expect(point.getAttribute('r')).toBe(String(MARK_POINT_RADIUS));
    const tile = svg.querySelector(':scope > rect')!;
    expect(tile.getAttribute('fill')).toBe('currentColor');
    expect(tile.getAttribute('mask')).toBe(`url(#${maskId})`);
    expect(splash.querySelector('.ds-boot-word')!.textContent).toBe('DreamStream Studio');
  });

  it('uses AppLoader’s numbers (bootGeometry.ts), so the hand-off to React does not move a pixel', () => {
    expect(decl(rule('#app-splash .ds-boot'), 'gap')).toBe(`${BOOT.stackGapPx}px`);
    expect(decl(rule('#app-splash .ds-boot-lockup'), 'gap')).toBe(`${BOOT.lockupGapPx}px`);
    const mark = rule('#app-splash .ds-boot-mark');
    expect(decl(mark, 'width')).toBe(`${BOOT.markPx}px`);
    expect(decl(mark, 'height')).toBe(`${BOOT.markPx}px`);
    expect(decl(rule('#app-splash .ds-boot-word'), 'font-size')).toBe(`${BOOT.wordPx}px`);
    // The wordmark's face is StudioLogo's (.ds-logo-word in studio-marks.css), read from the skin's display
    // token, so index.html names no font (atlasSkin.test.ts: it links only the lettering faces).
    expect(decl(rule('#app-splash .ds-boot-word'), 'font-family')).toBe('var(--ds-font-display, system-ui, sans-serif)');
    const logoFace = read('components/brand/studio-marks.css').match(/:where\(\.ds-logo-word\) \{[^}]*font-family: ("[^"]+")/)?.[1];
    const skinDisplay = read('index.css').match(/\[data-ds-skin="atlas"\] \{[^}]*--ds-font-display: ("[^"]+")/)?.[1];
    expect(logoFace).toBeTruthy();
    expect(skinDisplay).toBe(logoFace);
    expect(decl(rule('#app-splash .ds-boot-word'), 'font-weight')).toBe('600');
    const track = rule('#app-splash .ds-boot-track');
    expect(decl(track, 'width')).toBe(`${BOOT.trackWidthPx}px`);
    expect(decl(track, 'height')).toBe(`${BOOT.trackHeightPx}px`);
    const bar = rule('#app-splash .ds-boot-bar');
    expect(decl(bar, 'width')).toBe(`${BOOT.barShare * 100}%`);
    expect(decl(bar, 'animation')).toMatch(new RegExp(`^ds-boot-sweep ${BOOT.sweepMs}ms `));
    expect(decl(rule('#app-splash .ds-boot-below'), 'top')).toBe(`calc(100% + ${BOOT.captionGapPx}px)`);
    expect(doc.querySelector(SPLASH_BAR_SELECTOR)).not.toBeNull();
  });

  it('sweeps like .ds-progress-indeterminate (styles/ds-motion.css), and holds still, centred, under reduced motion', () => {
    const keyframes = (css: string, name: string) => css.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?\\})\\s*\\}`))?.[1].replace(/\s+/g, ' ').trim();
    const motion = read('styles/ds-motion.css');
    expect(keyframes(CSS, 'ds-boot-sweep')).toBe(keyframes(motion, 'ds-progress-indeterminate'));
    const reduced = CSS.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
    const bar = rule('#app-splash .ds-boot-bar', reduced);
    expect(decl(bar, 'animation')).toBe('none');
    expect(decl(bar, 'transform')).toBe('translateX(75%)');
  });

  it('is light or dark exactly as the app will be: tokens with Atlas fallbacks, dark keyed on html.dark', () => {
    const base = rule('#app-splash');
    expect(decl(base, 'background-color')).toBe('var(--ds-canvas, #ffffff)');
    expect(decl(base, 'color')).toBe('var(--ds-ink, #0a0a0a)');
    expect(decl(base, 'position')).toBe('fixed');
    const dark = rule('html.dark #app-splash');
    expect(decl(dark, 'background-color')).toBe('var(--ds-canvas, #0a0a0a)');
    expect(decl(dark, 'color')).toBe('var(--ds-ink, #fafafa)');
    // No z-index ladder number on the page shell.
    expect(CSS).not.toMatch(/z-index/);
  });

  it('keeps the watchdog contract: a hidden "taking longer" prompt with a real Reload button', () => {
    const slow = splash.querySelector('.slow')!;
    expect(decl(rule('#app-splash .slow'), 'display')).toBe('none');
    expect(slow.textContent).toMatch(/taking longer than usual/);
    const reload = slow.querySelector('button#app-splash-reload')!;
    expect(reload.getAttribute('type')).toBe('button');
    expect(reload.textContent).toBe('Reload');
    // Out of the flow under the bar, so the lockup never jumps when it appears; a 44 px target on touch.
    expect(slow.parentElement!.className).toBe('ds-boot-below');
    expect(decl(rule('#app-splash .ds-boot-below'), 'position')).toBe('absolute');
    expect(CSS).toMatch(/@media \(pointer: coarse\) \{ #app-splash \.slow button \{ height: 44px;/);
    expect(decl(rule('#app-splash .slow button:focus-visible'), 'outline')).toBe('2px solid currentColor');
  });

  it('without JavaScript: says so, stops the bar, and follows the OS scheme (theme-boot.js never ran)', () => {
    expect(splash.querySelector('noscript')!.textContent).toMatch(/needs JavaScript/);
    expect(decl(rule('#app-splash .ds-boot-track', NOSCRIPT_CSS), 'visibility')).toBe('hidden');
    expect(NOSCRIPT_CSS).toMatch(/@media \(prefers-color-scheme: dark\)/);
  });
});
