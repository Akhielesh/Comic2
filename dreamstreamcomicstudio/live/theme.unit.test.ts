// @vitest-environment jsdom
// Appearance in both looks (live/theme.ts). With the Atlas skin (data-ds-skin="atlas" on <html>,
// static in live.html): no inline accent ever, the stored accent kept, the browser chrome white /
// near-black, new events on the ink cover. Without it (the build's kill switch): exactly as before —
// the accent written inline, the cream theme colours, clay covers. Theme, density and corners work
// the same in both.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCENTS,
  APPEARANCE_KEY,
  INK_COVER,
  LEGACY_THEME_KEY,
  applyAppearance,
  atlasSkin,
  defaultCover,
  loadAppearance,
  parseAppearance,
  saveAppearance,
  switchTheme,
  themeColorFor,
  type Appearance,
} from './theme';

const html = document.documentElement;
const ACCENT_PROPS = ['--accent', '--accent-2', '--accent-ink', '--accent-wash'];
const base: Appearance = { theme: 'light', accent: 'clay', density: 'calm', corners: 'soft', studioLayout: 'chat-right' };

function setSkin(on: boolean) {
  if (on) html.setAttribute('data-ds-skin', 'atlas');
  else html.removeAttribute('data-ds-skin');
}
function addThemeMetas() {
  for (const scheme of ['light', 'dark']) {
    const m = document.createElement('meta');
    m.name = 'theme-color';
    m.content = scheme === 'light' ? '#ffffff' : '#0a0a0a';
    m.media = `(prefers-color-scheme: ${scheme})`;
    document.head.appendChild(m);
  }
}
const metaColors = () => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => m.content);

beforeEach(() => {
  localStorage.clear();
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  addThemeMetas();
  html.removeAttribute('style');
  for (const a of ['data-theme', 'data-density', 'data-corners', 'data-ds-skin']) html.removeAttribute(a);
  html.className = '';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseAppearance (and the boot script, which mirrors it)', () => {
  it('defaults to light, calm, soft — whatever the OS says', () => {
    expect(parseAppearance(null, null)).toEqual(base);
  });

  it('migrates the legacy single-key theme only when there is no appearance yet', () => {
    expect(parseAppearance(null, 'dark').theme).toBe('dark');
    expect(parseAppearance(null, 'light').theme).toBe('light');
    expect(parseAppearance(null, 'anything').theme).toBe('dark'); // as before: not "light" → dark
    expect(parseAppearance(JSON.stringify({ density: 'pro' }), 'dark').theme).toBe('light');
  });

  it('keeps every valid stored choice, the accent included', () => {
    const a: Appearance = { theme: 'dark', accent: 'plum', density: 'pro', corners: 'sharp', studioLayout: 'cinema' };
    expect(parseAppearance(JSON.stringify(a), null)).toEqual(a);
  });

  it('falls back per field on values this build does not know, and on unreadable JSON', () => {
    expect(parseAppearance(JSON.stringify({ theme: 'blue', density: 'max', corners: 1, studioLayout: 'x', accent: 'teal' }), null)).toEqual({ ...base, accent: 'teal' });
    expect(parseAppearance('{not json', null)).toEqual(base);
    expect(parseAppearance('"dark"', null)).toEqual(base);
    expect(parseAppearance('[1,2]', null)).toEqual(base);
    expect(parseAppearance('null', 'dark')).toEqual(base); // an appearance exists (if empty): legacy ignored
  });

  it('loadAppearance reads the same storage keys, and survives storage that throws', () => {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme: 'dark', corners: 'sharp' }));
    expect(loadAppearance()).toEqual({ ...base, theme: 'dark', corners: 'sharp' });
    localStorage.clear();
    localStorage.setItem(LEGACY_THEME_KEY, 'dark');
    expect(loadAppearance().theme).toBe('dark');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadAppearance()).toEqual(base);
  });
});

describe('without the Atlas skin (the kill switch): exactly as before', () => {
  it('writes the accent inline for the theme, and the attributes', () => {
    expect(atlasSkin()).toBe(false);
    applyAppearance({ ...base, accent: 'sage', theme: 'dark', density: 'pro', corners: 'sharp' });
    expect(html.getAttribute('data-theme')).toBe('dark');
    expect(html.getAttribute('data-density')).toBe('pro');
    expect(html.getAttribute('data-corners')).toBe('sharp');
    expect(html.style.getPropertyValue('--accent')).toBe(ACCENTS.sage.d.a);
    expect(html.style.getPropertyValue('--accent-2')).toBe(ACCENTS.sage.d.a2);
    expect(html.style.getPropertyValue('--accent-ink')).toBe(ACCENTS.sage.d.ink);
    expect(html.style.getPropertyValue('--accent-wash')).toBe(ACCENTS.sage.d.wash);
  });

  it('an unknown accent falls back to clay', () => {
    applyAppearance({ ...base, accent: 'teal' });
    expect(html.style.getPropertyValue('--accent')).toBe(ACCENTS.clay.l.a);
  });

  it('the browser chrome takes the cream studio’s page colour', () => {
    applyAppearance(base);
    expect(metaColors()).toEqual(['#f4f2ea', '#f4f2ea']);
    applyAppearance({ ...base, theme: 'dark' });
    expect(metaColors()).toEqual(['#211e1a', '#211e1a']);
  });

  it('new events start on clay', () => {
    expect(defaultCover()).toBe(0);
  });
});

describe('with the Atlas skin: hue never decorates', () => {
  beforeEach(() => setSkin(true));

  it('writes no inline accent — and clears one left by an earlier call', () => {
    setSkin(false);
    applyAppearance({ ...base, accent: 'plum' });
    expect(html.style.getPropertyValue('--accent')).not.toBe('');
    setSkin(true);
    applyAppearance({ ...base, accent: 'plum' });
    for (const p of ACCENT_PROPS) expect(html.style.getPropertyValue(p), p).toBe('');
  });

  it('keeps theme, density and corners as the person’s choice', () => {
    applyAppearance({ ...base, theme: 'dark', density: 'pro', corners: 'sharp' });
    expect(html.getAttribute('data-theme')).toBe('dark');
    expect(html.getAttribute('data-density')).toBe('pro');
    expect(html.getAttribute('data-corners')).toBe('sharp');
  });

  it('ignores the stored accent but never deletes it', () => {
    const a = { ...base, accent: 'slate' };
    saveAppearance(a);
    applyAppearance(loadAppearance());
    expect(html.style.getPropertyValue('--accent')).toBe('');
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!).accent).toBe('slate');
  });

  it('the browser chrome is white / near-black, following the in-app theme over the OS', () => {
    applyAppearance(base);
    expect(metaColors()).toEqual(['#ffffff', '#ffffff']);
    applyAppearance({ ...base, theme: 'dark' });
    expect(metaColors()).toEqual(['#0a0a0a', '#0a0a0a']);
    expect(themeColorFor('dark', true)).toBe('#0a0a0a');
    expect(themeColorFor('light', false)).toBe('#f4f2ea');
  });

  it('new events start on the ink cover', () => {
    expect(defaultCover()).toBe(INK_COVER);
  });
});

describe('switchTheme: one cross-fade under the skin', () => {
  it('without the skin, applies at once (no view transition)', () => {
    const start = vi.fn();
    Object.assign(document, { startViewTransition: start });
    const apply = vi.fn();
    switchTheme(apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('under the skin, flips inside a view transition with element transitions held, then cleans up', async () => {
    setSkin(true);
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    const start = vi.fn((cb: () => void) => {
      expect(html.classList.contains('live-theme-transition')).toBe(true);
      expect(html.classList.contains('live-no-transitions')).toBe(true);
      cb();
      return { finished };
    });
    Object.assign(document, { startViewTransition: start });
    const apply = vi.fn();
    switchTheme(apply);
    expect(start).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    finish();
    await finished;
    await Promise.resolve();
    expect(html.classList.contains('live-theme-transition')).toBe(false);
    expect(html.classList.contains('live-no-transitions')).toBe(false);
  });

  it('under reduced motion, applies at once', () => {
    setSkin(true);
    const start = vi.fn();
    Object.assign(document, { startViewTransition: start });
    vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ matches: q.includes('reduce'), media: q } as MediaQueryList));
    const apply = vi.fn();
    switchTheme(apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });
});
