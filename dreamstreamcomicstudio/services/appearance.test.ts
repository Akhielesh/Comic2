// @vitest-environment jsdom
// The one appearance choice (navtheme NT-Q): Light, Dark, Paper or System, written to the two stores that already exist
// (ds.theme.v1 for light/dark/system, ds.comic-theme.v1 for the Atlas/Paper material) by one writer, applied to the
// whole page at once, followed by the browser's status-bar colour, and on System following the OS with nothing mounted.
import { readFileSync } from 'node:fs';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAppearance, setAppearance, type Appearance } from './appearance';
import { DS_SKIN_ATTR } from './productHost';
import { holdThemeColor, initTheme, useTheme } from './theme';
import { useThemeColor } from '../components/comicstudio/mobile/useThemeColor';
import { useComicThemeScope } from '../components/comicstudio/useComicTheme';

const MODE_KEY = 'ds.theme.v1';
const MATERIAL_KEY = 'ds.comic-theme.v1';
const root = document.documentElement;
const realMatchMedia = window.matchMedia;

/** The canvas per look, as index.css and styles/comic-theme.css set it (literal stand-ins). */
const CANVAS_CSS = ':root { --ds-canvas: #ffffff; } .dark { --ds-canvas: #0a0a0a; } html[data-comic-theme="paper"] { --ds-canvas: #fbf8f0; }';

const metas = () => Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')).map((m) => m.getAttribute('content'));

/** The App-level scope the comics host mounts for the whole app (App.tsx -> useComicsHost -> useComicThemeScope). */
const mountComicsHostScope = () => renderHook(() => useComicThemeScope(true));

/** A startViewTransition stand-in that records the page as it was when the transition began, and keeps the update for later. */
const recordViewTransition = () => {
  const updates: Array<() => void> = [];
  const atStart: Array<{ material: string | null; dark: boolean; metas: Array<string | null> }> = [];
  (document as { startViewTransition?: unknown }).startViewTransition = vi.fn((update: () => void) => {
    atStart.push({ material: root.getAttribute('data-comic-theme'), dark: root.classList.contains('dark'), metas: metas() });
    updates.push(update);
    return { ready: Promise.resolve(), finished: new Promise(() => undefined), updateCallbackDone: new Promise(() => undefined) };
  });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
  root.setAttribute(DS_SKIN_ATTR, 'atlas');
  return { atStart, runUpdates: () => updates.splice(0).forEach((u) => u()) };
};

beforeEach(() => {
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
  cleanup();
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
  it('with the comics host scope mounted (as App does), Paper then Light leaves no data-comic-theme on <html>', () => {
    mountComicsHostScope();
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

  it('setAppearance never writes <html data-comic-theme> itself: the scope hook is its one writer (off the comics host it is Comic Studio only)', () => {
    setAppearance('paper');
    expect(root.hasAttribute('data-comic-theme')).toBe(false);
    expect(localStorage.getItem(MATERIAL_KEY)).toBe('paper');
    root.setAttribute('data-comic-theme', 'paper');
    setAppearance('light');
    expect(root.getAttribute('data-comic-theme')).toBe('paper');
  });

  it('the material store has its own module, so appearance.ts and useComicTheme.ts do not import each other', () => {
    const appearance = readFileSync('services/appearance.ts', 'utf8');
    const material = readFileSync('services/comicMaterial.ts', 'utf8');
    expect(appearance).not.toMatch(/from '[^']*useComicTheme'/);
    expect(appearance).toMatch(/from '\.\/comicMaterial'/);
    expect(material).not.toMatch(/^import /m);
  });

  it('the theme-color metas equal --ds-canvas after each change', () => {
    mountComicsHostScope();
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
    const vt = recordViewTransition();
    setAppearance('dark');
    expect(vt.atStart).toEqual([{ material: null, dark: false, metas: ['#ffffff', '#0a0a0a'] }]);
    // Until the update runs, nothing has moved: not the class, not the chrome.
    expect(root.classList.contains('dark')).toBe(false);
    expect(metas()).toEqual(['#ffffff', '#0a0a0a']);
    vt.runUpdates();
    expect(root.classList.contains('dark')).toBe(true);
    expect(metas()).toEqual(['#0a0a0a', '#0a0a0a']);
  });

  it('under the skin Paper to Dark is one cross-fade: the material and the chrome change inside it, not before it starts', () => {
    mountComicsHostScope();
    setAppearance('paper');
    expect(metas()).toEqual(['#fbf8f0', '#fbf8f0']);
    const vt = recordViewTransition();
    setAppearance('dark');
    // When the browser takes its "before" picture the page is still Paper, with the Paper chrome.
    expect(vt.atStart).toEqual([{ material: 'paper', dark: false, metas: ['#fbf8f0', '#fbf8f0'] }]);
    expect(root.getAttribute('data-comic-theme')).toBe('paper');
    expect(metas()).toEqual(['#fbf8f0', '#fbf8f0']);
    vt.runUpdates();
    expect(root.hasAttribute('data-comic-theme')).toBe(false);
    expect(root.classList.contains('dark')).toBe(true);
    expect(metas()).toEqual(['#0a0a0a', '#0a0a0a']);
    // Back to Paper: the same single flip the other way.
    setAppearance('paper');
    expect(vt.atStart[1]).toEqual({ material: null, dark: true, metas: ['#0a0a0a', '#0a0a0a'] });
    vt.runUpdates();
    expect(root.getAttribute('data-comic-theme')).toBe('paper');
    expect(root.classList.contains('dark')).toBe(false);
    expect(metas()).toEqual(['#fbf8f0', '#fbf8f0']);
  });

  it('when the mode does not change (Light to Paper) the material lands at once, with no transition', () => {
    mountComicsHostScope();
    const vt = recordViewTransition();
    setAppearance('paper');
    expect(vt.atStart).toEqual([]);
    expect(root.getAttribute('data-comic-theme')).toBe('paper');
    expect(metas()).toEqual(['#fbf8f0', '#fbf8f0']);
  });

  it('Paper picked in another tab with the mode unchanged repaints this tab and its chrome', () => {
    mountComicsHostScope();
    expect(metas()).toEqual(['#ffffff', '#ffffff']);
    localStorage.setItem(MATERIAL_KEY, 'paper');
    window.dispatchEvent(new StorageEvent('storage', { key: MATERIAL_KEY }));
    expect(root.getAttribute('data-comic-theme')).toBe('paper');
    expect(metas()).toEqual(['#fbf8f0', '#fbf8f0']);
  });
});

describe('the chrome colour: only the look\'s own metas, never one another screen owns', () => {
  it('a share page keeps its comic\'s colour: initTheme and a change leave an unscoped theme-color alone', () => {
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((n) => n.remove());
    const card = document.createElement('meta');
    card.name = 'theme-color';
    card.setAttribute('content', '#5a2d82');
    document.head.appendChild(card);
    initTheme();
    expect(card.getAttribute('content')).toBe('#5a2d82');
    setAppearance('dark');
    expect(card.getAttribute('content')).toBe('#5a2d82');
  });

  it('while a screen holds the chrome (an explicit colour) a change of look leaves it, and its release gives the current look', () => {
    const { unmount } = renderHook(() => useThemeColor('#101010'));
    expect(metas()).toEqual(['#101010', '#101010']);
    setAppearance('dark');
    expect(metas()).toEqual(['#101010', '#101010']);
    unmount();
    // Not the light colours it found when it opened: the look changed meanwhile.
    expect(metas()).toEqual(['#0a0a0a', '#0a0a0a']);
  });

  it('holdThemeColor counts holders: the sync waits for the last release, and a release runs once', () => {
    const a = holdThemeColor();
    const b = holdThemeColor();
    setAppearance('dark');
    expect(metas()).toEqual(['#ffffff', '#0a0a0a']);
    a();
    a();
    setAppearance('system');
    expect(metas()).toEqual(['#ffffff', '#0a0a0a']);
    b();
    setAppearance('dark');
    expect(metas()).toEqual(['#0a0a0a', '#0a0a0a']);
  });

  it("Chat's own Light/Dark/System (useTheme) writes Atlas with the mode, so no new Dark + Paper pair is made", () => {
    setAppearance('paper');
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPreference('dark'));
    expect([localStorage.getItem(MODE_KEY), localStorage.getItem(MATERIAL_KEY)]).toEqual(['dark', 'atlas']);
    expect(loadAppearance()).toBe('dark');
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

  it('picking System registers the same one listener even where initTheme never ran (an embed, the QA harness)', async () => {
    const listeners: Array<() => void> = [];
    const mq = { matches: false, media: '(prefers-color-scheme: dark)', addEventListener: vi.fn((_t: string, fn: () => void) => listeners.push(fn)), removeEventListener: vi.fn() };
    window.matchMedia = vi.fn(() => mq) as unknown as typeof window.matchMedia;
    vi.resetModules();
    const fresh = await import('./appearance');
    fresh.setAppearance('system');
    fresh.setAppearance('light');
    fresh.setAppearance('system');
    expect(listeners).toHaveLength(1);
    mq.matches = true;
    listeners.forEach((fn) => fn());
    expect(root.classList.contains('dark')).toBe(true);
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
