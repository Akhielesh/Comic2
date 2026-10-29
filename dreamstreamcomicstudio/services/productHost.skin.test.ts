// The design-skin scope (docs/design/atlas-skin.md): the Atlas skin attribute is set for the comics
// host and its alias, never for the apex, and the boot code does only what the brief allows (no
// inline script: attribute, typed-token registration, two font preloads, the gated cross-fade).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMIC_STUDIO_SKIN, DS_SKIN_ATTR, comicsSkin } from './productHost';
import { ATLAS_PRELOAD_FONTS, DS_COLOR_TOKENS, DS_SKIN_FADE_ATTR, bootDsSkin, preloadSkinFonts, registerDsColorTokens } from './dsSkin';

const COMICS = 'comics.dreamstreamstudio.ai';

const fakeCss = () => ({ registerProperty: vi.fn() });
/** A requestAnimationFrame stand-in whose frames run only when asked. */
const fakeRaf = () => {
  const queue: Array<() => void> = [];
  const raf = (cb: () => void) => {
    queue.push(cb);
  };
  const frame = () => {
    const cbs = queue.splice(0);
    cbs.forEach((cb) => cb());
  };
  return { raf, frame };
};

afterEach(() => {
  document.documentElement.removeAttribute(DS_SKIN_ATTR);
  document.documentElement.removeAttribute(DS_SKIN_FADE_ATTR);
  document.head.querySelectorAll('link[rel="preload"]').forEach((l) => l.remove());
});

describe('comicsSkin — which hosts run under the Atlas skin', () => {
  it('is the Atlas skin on the comics host and its alias (any case, trailing dot)', () => {
    expect(comicsSkin(COMICS)).toBe('atlas');
    expect(comicsSkin('COMICS.dreamstreamstudio.ai.')).toBe('atlas');
    expect(comicsSkin('comic.dreamstreamstudio.ai')).toBe('atlas');
    expect(COMIC_STUDIO_SKIN).toBe('atlas');
  });

  it('is nothing on the apex, previews, localhost and look-alikes', () => {
    for (const host of ['dreamstreamstudio.ai', 'www.dreamstreamstudio.ai', 'atlas.dreamstreamstudio.ai', 'comic2.pages.dev', 'localhost', 'comics.dreamstreamstudio.ai.evil.com', '']) {
      expect(comicsSkin(host), host).toBeNull();
    }
  });

  it('reads the page hostname by default (jsdom: localhost → no skin)', () => {
    expect(comicsSkin()).toBeNull();
  });
});

describe('bootDsSkin — the attribute is set on the comics host, never on the apex', () => {
  it('on the comics host: attribute at once, tokens registered, two preloads, cross-fade two frames later', () => {
    const css = fakeCss();
    const { raf, frame } = fakeRaf();
    expect(bootDsSkin({ document, hostname: COMICS, css, raf })).toBe('atlas');
    expect(document.documentElement.getAttribute(DS_SKIN_ATTR)).toBe('atlas');
    expect(document.documentElement.hasAttribute(DS_SKIN_FADE_ATTR)).toBe(false);
    frame();
    expect(document.documentElement.hasAttribute(DS_SKIN_FADE_ATTR)).toBe(false);
    frame();
    expect(document.documentElement.hasAttribute(DS_SKIN_FADE_ATTR)).toBe(true);

    expect(css.registerProperty).toHaveBeenCalledTimes(DS_COLOR_TOKENS.length);
    for (const { name, initialValue } of DS_COLOR_TOKENS) {
      expect(css.registerProperty).toHaveBeenCalledWith({ name, syntax: '<color>', inherits: true, initialValue });
    }

    const links = [...document.head.querySelectorAll('link[rel="preload"]')] as HTMLLinkElement[];
    expect(links.map((l) => l.getAttribute('href'))).toEqual([...ATLAS_PRELOAD_FONTS]);
    for (const l of links) {
      expect(l.getAttribute('as')).toBe('font');
      expect(l.getAttribute('type')).toBe('font/woff2');
      expect(l.getAttribute('crossorigin')).toBe('anonymous');
    }
    expect(document.querySelectorAll('script').length).toBe(0);
  });

  it('on the alias host too', () => {
    expect(bootDsSkin({ document, hostname: 'comic.dreamstreamstudio.ai', css: fakeCss(), raf: null })).toBe('atlas');
    expect(document.documentElement.getAttribute(DS_SKIN_ATTR)).toBe('atlas');
    expect(document.documentElement.hasAttribute(DS_SKIN_FADE_ATTR)).toBe(true);
  });

  it('on the apex (and the page default, localhost): nothing is touched', () => {
    const css = fakeCss();
    for (const hostname of ['dreamstreamstudio.ai', 'www.dreamstreamstudio.ai', undefined]) {
      expect(bootDsSkin({ document, hostname, css, raf: null })).toBeNull();
    }
    expect(document.documentElement.hasAttribute(DS_SKIN_ATTR)).toBe(false);
    expect(document.documentElement.hasAttribute(DS_SKIN_FADE_ATTR)).toBe(false);
    expect(css.registerProperty).not.toHaveBeenCalled();
    expect(document.head.querySelectorAll('link[rel="preload"]').length).toBe(0);
  });

  it('is idempotent and never throws (a second boot, a registry that rejects duplicates, no CSS API)', () => {
    const css = { registerProperty: vi.fn(() => { throw new DOMException('already registered', 'InvalidModificationError'); }) };
    expect(bootDsSkin({ document, hostname: COMICS, css, raf: null })).toBe('atlas');
    expect(bootDsSkin({ document, hostname: COMICS, css, raf: null })).toBe('atlas');
    expect(document.head.querySelectorAll('link[rel="preload"]').length).toBe(ATLAS_PRELOAD_FONTS.length);
    expect(registerDsColorTokens(null)).toBe(0);
    expect(registerDsColorTokens(undefined)).toBe(0);
    expect(preloadSkinFonts(document)).toBe(0);
    expect(bootDsSkin({ document, hostname: COMICS, css: null, raf: null })).toBe('atlas');
  });

  it('registers every token the cross-fade lists, as inherited colours with the light defaults', () => {
    const names = DS_COLOR_TOKENS.map((t) => t.name);
    expect(names).toEqual([...new Set(names)]);
    expect(names).toEqual(expect.arrayContaining(['--ds-canvas', '--ds-ink', '--ds-muted', '--ds-accent', '--ds-on-accent', '--ds-accent-soft', '--ds-ring']));
    for (const t of DS_COLOR_TOKENS) expect(t.initialValue, t.name).toMatch(/^(#[0-9a-fA-F]{6}|rgba?\([^)]*\))$/);
  });
});
