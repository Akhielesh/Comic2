// The design-skin scope (docs/design/atlas-skin.md): the Atlas skin attribute is set for the comics
// host and its alias, never for the apex, and the boot code does only what the brief allows (no
// inline script: the attribute and two font preloads). Since the wave 5 port the boot registers no
// typed tokens and arms no token cross-fade: the theme switch is one view transition
// (services/dsSkin.theme.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMIC_STUDIO_SKIN, DS_SKIN_ATTR, comicsSkin } from './productHost';
import * as dsSkin from './dsSkin';
import { ATLAS_PRELOAD_FONTS, bootDsSkin, preloadSkinFonts } from './dsSkin';

const COMICS = 'comics.dreamstreamstudio.ai';

afterEach(() => {
  document.documentElement.removeAttribute(DS_SKIN_ATTR);
  document.documentElement.removeAttribute('data-ds-skin-fade');
  document.head.querySelectorAll('link[rel="preload"]').forEach((l) => l.remove());
  delete (globalThis as { CSS?: unknown }).CSS;
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
  it('on the comics host: the attribute at once and two preloads; no token registration, no fade attribute', () => {
    const registerProperty = vi.fn();
    (globalThis as { CSS?: unknown }).CSS = { registerProperty };
    expect(bootDsSkin({ document, hostname: COMICS })).toBe('atlas');
    expect(document.documentElement.getAttribute(DS_SKIN_ATTR)).toBe('atlas');
    // Wave 5: registered, transitioned colour tokens restyled every element on every frame of the
    // fade (Atlas dropped them); the theme switch is a view transition now.
    expect(registerProperty).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute('data-ds-skin-fade')).toBe(false);

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
    expect(bootDsSkin({ document, hostname: 'comic.dreamstreamstudio.ai' })).toBe('atlas');
    expect(document.documentElement.getAttribute(DS_SKIN_ATTR)).toBe('atlas');
  });

  it('on the apex (and the page default, localhost): nothing is touched', () => {
    for (const hostname of ['dreamstreamstudio.ai', 'www.dreamstreamstudio.ai', undefined]) {
      expect(bootDsSkin({ document, hostname })).toBeNull();
    }
    expect(document.documentElement.hasAttribute(DS_SKIN_ATTR)).toBe(false);
    expect(document.head.querySelectorAll('link[rel="preload"]').length).toBe(0);
  });

  it('is idempotent and never throws (a second boot keeps one preload per font)', () => {
    expect(bootDsSkin({ document, hostname: COMICS })).toBe('atlas');
    expect(bootDsSkin({ document, hostname: COMICS })).toBe('atlas');
    expect(document.head.querySelectorAll('link[rel="preload"]').length).toBe(ATLAS_PRELOAD_FONTS.length);
    expect(preloadSkinFonts(document)).toBe(0);
  });

  it('the registration machinery is gone from the module', () => {
    const mod = dsSkin as Record<string, unknown>;
    expect(mod.registerDsColorTokens).toBeUndefined();
    expect(mod.DS_COLOR_TOKENS).toBeUndefined();
    expect(mod.DS_SKIN_FADE_ATTR).toBeUndefined();
  });
});
