// @vitest-environment jsdom
// The one appearance choice (navtheme NT-Q): Light, Dark, Paper or System, written to the two stores that already exist
// (ds.theme.v1 for light/dark/system, ds.comic-theme.v1 for the Atlas/Paper material) by one writer, applied to the
// whole page at once, followed by the browser's status-bar colour, and on System following the OS with nothing mounted.
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ comics: false }));
vi.mock('./productHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./productHost')>();
  return { ...actual, isComicsHost: (hostname?: string) => (hostname === undefined ? host.comics : actual.isComicsHost(hostname)) };
});

import { loadAppearance, setAppearance, type Appearance } from './appearance';
import { DS_SKIN_ATTR } from './productHost';
import { useThemeColor } from '../components/comicstudio/mobile/useThemeColor';

const MODE_KEY = 'ds.theme.v1';
const MATERIAL_KEY = 'ds.comic-theme.v1';
const root = document.documentElement;
const realMatchMedia = window.matchMedia;

/** The canvas per look, as index.css and styles/comic-theme.css set it (literal stand-ins). */
const CANVAS_CSS = ':root { --ds-canvas: #ffffff; } .dark { --ds-canvas: #0a0a0a; } html[data-comic-theme="paper"] { --ds-canvas: #fbf8f0; }';

const metas = () => Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')).map((m) => m.getAttribute('content'));

beforeEach(() => {
  host.comics = false;
  localStorage.clear();
  const style = document.createElement('style');
  style.setAttribute('data-test', 'canvas');
  style.textContent = CANVAS_CSS;
  document.head.appendChild(style);
  for (const media of ['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)']) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.setAttribute('media', media);
    meta.setAttribute('content', media.includes('dark') ? '#0a0a0a' : '#ffffff');
    document.head.appendChild(meta);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  window.matchMedia = realMatchMedia;
  localStorage.clear();
  root.classList.remove('dark', 'ds-no-transitions', 'ds-theme-transition');
  root.removeAttribute('data-comic-theme');
  root.removeAttribute(DS_SKIN_ATTR);
  delete (document as { startViewTransition?: unknown }).startViewTransition;
  document.head.querySelectorAll('style[data-test], meta[name="theme-color"]').forEach((n) => n.remove());
});

describe('appearance: one choice over the two stores', () => {
  it('maps the four choices to (mode, material) and reads each back', () => {
    const table: Array<[Appearance, string, string]> = [
      ['light', 'light', 'atlas'],
      ['dark', 'dark', 'atlas'],
      ['system', 'system', 'atlas'],
      ['paper', 'light', 'paper']
    ];
    for (const [appearance, mode, material] of table) {
      setAppearance(appearance);
      expect(localStorage.getItem(MODE_KEY), appearance).toBe(mode);
      expect(localStorage.getItem(MATERIAL_KEY), appearance).toBe(material);
      expect(loadAppearance(), appearance).toBe(appearance);
    }
  });

  it('reads what is stored today: nothing is Light, Paper only on the light mode, and a legacy Paper + Dark reads Dark without being rewritten', () => {
    expect(loadAppearance()).toBe('light');
    const cases: Array<[string, string, Appearance]> = [
      ['light', 'paper', 'paper'],
      ['light', 'atlas', 'light'],
      ['dark', 'atlas', 'dark'],
      ['system', 'atlas', 'system'],
      ['dark', 'paper', 'dark'],
      ['system', 'paper', 'system']
    ];
    for (const [mode, material, expected] of cases) {
      localStorage.setItem(MODE_KEY, mode);
      localStorage.setItem(MATERIAL_KEY, material);
      expect(loadAppearance(), `${mode} + ${material}`).toBe(expected);
      // Reading never normalises: the legacy pair stays until the person picks again.
      expect(localStorage.getItem(MODE_KEY)).toBe(mode);
      expect(localStorage.getItem(MATERIAL_KEY)).toBe(material);
    }
  });

  it('every write sets both keys: Dark after Paper clears the Paper material, Paper after Dark sets the light mode', () => {
    setAppearance('paper');
    setAppearance('dark');
    expect([localStorage.getItem(MODE_KEY), localStorage.getItem(MATERIAL_KEY)]).toEqual(['dark', 'atlas']);
    expect(root.classList.contains('dark')).toBe(true);
    setAppearance('paper');
    expect([localStorage.getItem(MODE_KEY), localStorage.getItem(MATERIAL_KEY)]).toEqual(['light', 'paper']);
    expect(root.classList.contains('dark')).toBe(false);
  });

  it('a blocked localStorage throws nothing, and the choice still applies for this tab', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => loadAppearance()).not.toThrow();
    expect(() => setAppearance('dark')).not.toThrow();
    expect(root.classList.contains('dark')).toBe(true);
    expect(loadAppearance()).toBe('dark');
    expect(() => setAppearance('paper')).not.toThrow();
    expect(loadAppearance()).toBe('paper');
    expect(root.classList.contains('dark')).toBe(false);
  });
});

describe('appearance: the page changes at once', () => {
  it('on a comics host, Paper then Light leaves no data-comic-theme on <html>', () => {
    host.comics = true;
    setAppearance('paper');
    expect(root.getAttribute('data-comic-theme')).toBe('paper');
    setAppearance('light');
    expect(root.hasAttribute('data-comic-theme')).toBe(false);
    // A Paper boot (theme-boot.js set the attribute) is undone the same way, with no reload.
    root.setAttribute('data-comic-theme', 'paper');
    setAppearance('dark');
    expect(root.hasAttribute('data-comic-theme')).toBe(false);
    expect(root.classList.contains('dark')).toBe(true);
  });

  it('off the comics host <html> keeps no material (the studio scope hook owns it there)', () => {
    host.comics = false;
    setAppearance('paper');
    expect(root.hasAttribute('data-comic-theme')).toBe(false);
    expect(localStorage.getItem(MATERIAL_KEY)).toBe('paper');
  });

  it('the theme-color metas equal --ds-canvas after each change', () => {
    host.comics = true;
    setAppearance('dark');
    expect(metas()).toEqual(['#0a0a0a', '#0a0a0a']);
    setAppearance('paper');
    expect(metas()).toEqual(['#fbf8f0', '#fbf8f0']);
    setAppearance('light');
    expect(metas()).toEqual(['#ffffff', '#ffffff']);
  });

  it('leaving the studio leaves the chrome on the current look, not the colour it had when the studio opened', () => {
    const { unmount } = renderHook(() => useThemeColor());
    expect(metas()).toEqual(['#ffffff', '#ffffff']);
    // The person picks Dark inside the comic (Comic settings → Appearance), then goes back to their comics.
    setAppearance('dark');
    unmount();
    expect(metas()).toEqual(['#0a0a0a', '#0a0a0a']);
  });

  it('under the skin the metas follow the cross-fade: they change when the new theme lands, not before', () => {
    root.setAttribute(DS_SKIN_ATTR, 'atlas');
    const updates: Array<() => void> = [];
    (document as { startViewTransition?: unknown }).startViewTransition = vi.fn((update: () => void) => {
      updates.push(update);
      return { ready: Promise.resolve(), finished: new Promise(() => undefined), updateCallbackDone: new Promise(() => undefined) };
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    setAppearance('dark');
    expect(updates).toHaveLength(1);
    expect(root.classList.contains('dark')).toBe(false);
    updates.splice(0).forEach((u) => u());
    expect(root.classList.contains('dark')).toBe(true);
    expect(metas()).toEqual(['#0a0a0a', '#0a0a0a']);
  });
});

describe('System follows the OS with no hook mounted', () => {
  it('re-applies on a change event only while the choice is System, from one listener however often initTheme runs', async () => {
    const listeners: Array<() => void> = [];
    const mq = {
      matches: false,
      media: '(prefers-color-scheme: dark)',
      addEventListener: vi.fn((_type: string, fn: () => void) => listeners.push(fn)),
      removeEventListener: vi.fn(),
      addListener: vi.fn((fn: () => void) => listeners.push(fn)),
      removeListener: vi.fn()
    };
    window.matchMedia = vi.fn(() => mq) as unknown as typeof window.matchMedia;
    vi.resetModules();
    const theme = await import('./theme');
    localStorage.setItem(MODE_KEY, 'system');
    theme.initTheme();
    theme.initTheme();
    theme.initTheme();
    expect(listeners).toHaveLength(1);
    expect(root.classList.contains('dark')).toBe(false);

    mq.matches = true;
    listeners.forEach((fn) => fn());
    expect(root.classList.contains('dark')).toBe(true);
    expect(metas()).toEqual(['#0a0a0a', '#0a0a0a']);
    mq.matches = false;
    listeners.forEach((fn) => fn());
    expect(root.classList.contains('dark')).toBe(false);

    // Light stays light whatever the OS does.
    localStorage.setItem(MODE_KEY, 'light');
    mq.matches = true;
    listeners.forEach((fn) => fn());
    expect(root.classList.contains('dark')).toBe(false);
  });

  it('THEME_DEFAULT is Light and is what an empty or unknown store reads as', async () => {
    const theme = await import('./theme');
    expect(theme.THEME_DEFAULT).toBe('light');
    expect(theme.loadThemePreference()).toBe(theme.THEME_DEFAULT);
    localStorage.setItem(MODE_KEY, 'sepia');
    expect(theme.loadThemePreference()).toBe(theme.THEME_DEFAULT);
    localStorage.setItem(MODE_KEY, 'light');
    expect(theme.loadThemePreference()).toBe('light');
  });
});
