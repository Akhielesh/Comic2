// The design-skin scope since bridge D5, "Atlas everywhere" (docs/design/atlas-skin.md "Wave 9 (bridge)"):
// index.html ships `data-ds-skin="atlas"` on <html> for every host, and the build kill switch
// VITE_DS_SKIN_EVERYWHERE=off strips it (vite.config.ts; tests/config/dsSkinEverywhere.test.ts). So the boot
// keeps the shipped skin on the apex and always sets it on the comics host; with the switch off the page
// arrives without the attribute and the old comics-only rule applies. The boot does only what the brief
// allows (no inline script: the attribute and two font preloads); since the wave 5 port it registers no typed
// tokens and arms no token cross-fade: the theme switch is one view transition (services/dsSkin.theme.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMIC_STUDIO_SKIN, DS_SKIN_ATTR, comicsSkin, hostSkin } from './productHost';
import * as dsSkin from './dsSkin';
import { ATLAS_PRELOAD_FONTS, bootDsSkin, preloadSkinFonts } from './dsSkin';

const COMICS = 'comics.dreamstreamstudio.ai';
const APEX_HOSTS = ['dreamstreamstudio.ai', 'www.dreamstreamstudio.ai', 'atlas.dreamstreamstudio.ai', 'comic2.pages.dev', 'localhost', 'comics.dreamstreamstudio.ai.evil.com', ''];

/** The page as the build ships it: index.html's static attribute (kill switch on, the default) or none (off). */
const shipPage = (killSwitch: 'on' | 'off') => {
  if (killSwitch === 'on') document.documentElement.setAttribute(DS_SKIN_ATTR, 'atlas');
  else document.documentElement.removeAttribute(DS_SKIN_ATTR);
};
const preloads = () => [...document.head.querySelectorAll('link[rel="preload"]')] as HTMLLinkElement[];

afterEach(() => {
  document.documentElement.removeAttribute(DS_SKIN_ATTR);
  document.documentElement.removeAttribute('data-ds-skin-fade');
  document.head.querySelectorAll('link[rel="preload"]').forEach((l) => l.remove());
  delete (globalThis as { CSS?: unknown }).CSS;
});

describe('comicsSkin — the comics host is always skinned', () => {
  it('is the Atlas skin on the comics host and its alias (any case, trailing dot)', () => {
    expect(comicsSkin(COMICS)).toBe('atlas');
    expect(comicsSkin('COMICS.dreamstreamstudio.ai.')).toBe('atlas');
    expect(comicsSkin('comic.dreamstreamstudio.ai')).toBe('atlas');
    expect(COMIC_STUDIO_SKIN).toBe('atlas');
  });

  it('is null elsewhere (the host alone never skins the apex; the shipped attribute does)', () => {
    for (const host of APEX_HOSTS) expect(comicsSkin(host), host).toBeNull();
    expect(comicsSkin()).toBeNull(); // jsdom: localhost
  });
});

describe('hostSkin — the skin a page runs under', () => {
  it('kill switch on (the attribute shipped): the Atlas skin on every host, the apex included', () => {
    for (const host of [COMICS, 'comic.dreamstreamstudio.ai', ...APEX_HOSTS]) expect(hostSkin(host, 'atlas'), host).toBe('atlas');
  });

  it('kill switch off (nothing shipped): the comics host only, as before the bridge', () => {
    expect(hostSkin(COMICS, null)).toBe('atlas');
    expect(hostSkin('comic.dreamstreamstudio.ai', null)).toBe('atlas');
    for (const host of APEX_HOSTS) expect(hostSkin(host, null), host).toBeNull();
  });

  it('honours only a skin it knows (a stray value is not a skin)', () => {
    for (const shipped of ['', 'fun', 'ATLAS', 'atlas ', 'none']) expect(hostSkin('dreamstreamstudio.ai', shipped), shipped).toBeNull();
    expect(hostSkin(COMICS, 'fun')).toBe('atlas');
  });
});

describe('bootDsSkin — kill switch on (index.html ships the attribute)', () => {
  it('on the apex: keeps the attribute and preloads the two body weights; no script, no token registration', () => {
    shipPage('on');
    const registerProperty = vi.fn();
    (globalThis as { CSS?: unknown }).CSS = { registerProperty };
    for (const hostname of ['dreamstreamstudio.ai', 'www.dreamstreamstudio.ai', undefined]) expect(bootDsSkin({ document, hostname }), String(hostname)).toBe('atlas');
    expect(document.documentElement.getAttribute(DS_SKIN_ATTR)).toBe('atlas');
    expect(preloads().map((l) => l.getAttribute('href'))).toEqual([...ATLAS_PRELOAD_FONTS]);
    expect(registerProperty).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute('data-ds-skin-fade')).toBe(false);
    expect(document.querySelectorAll('script').length).toBe(0);
  });

  it('on the comics host: the same', () => {
    shipPage('on');
    expect(bootDsSkin({ document, hostname: COMICS })).toBe('atlas');
    expect(document.documentElement.getAttribute(DS_SKIN_ATTR)).toBe('atlas');
    expect(preloads()).toHaveLength(ATLAS_PRELOAD_FONTS.length);
  });
});

describe('bootDsSkin — kill switch off (the build stripped the attribute): the comics-only rule', () => {
  it('on the comics host and its alias: the attribute at once and two preloads; no token registration, no fade attribute', () => {
    shipPage('off');
    const registerProperty = vi.fn();
    (globalThis as { CSS?: unknown }).CSS = { registerProperty };
    expect(bootDsSkin({ document, hostname: COMICS })).toBe('atlas');
    expect(document.documentElement.getAttribute(DS_SKIN_ATTR)).toBe('atlas');
    // Wave 5: registered, transitioned colour tokens restyled every element on every frame of the
    // fade (Atlas dropped them); the theme switch is a view transition now.
    expect(registerProperty).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute('data-ds-skin-fade')).toBe(false);
    const links = preloads();
    expect(links.map((l) => l.getAttribute('href'))).toEqual([...ATLAS_PRELOAD_FONTS]);
    for (const l of links) {
      expect(l.getAttribute('as')).toBe('font');
      expect(l.getAttribute('type')).toBe('font/woff2');
      expect(l.getAttribute('crossorigin')).toBe('anonymous');
    }
    expect(document.querySelectorAll('script').length).toBe(0);
    document.documentElement.removeAttribute(DS_SKIN_ATTR);
    expect(bootDsSkin({ document, hostname: 'comic.dreamstreamstudio.ai' })).toBe('atlas');
    expect(document.documentElement.getAttribute(DS_SKIN_ATTR)).toBe('atlas');
  });

  it('on the apex (and the page default, localhost): nothing is touched', () => {
    shipPage('off');
    for (const hostname of ['dreamstreamstudio.ai', 'www.dreamstreamstudio.ai', undefined]) {
      expect(bootDsSkin({ document, hostname }), String(hostname)).toBeNull();
    }
    expect(document.documentElement.hasAttribute(DS_SKIN_ATTR)).toBe(false);
    expect(preloads()).toHaveLength(0);
  });
});

describe('bootDsSkin — either way', () => {
  it('is idempotent and never throws (a second boot keeps one preload per font)', () => {
    for (const killSwitch of ['on', 'off'] as const) {
      shipPage(killSwitch);
      expect(bootDsSkin({ document, hostname: COMICS })).toBe('atlas');
      expect(bootDsSkin({ document, hostname: COMICS })).toBe('atlas');
      expect(preloads()).toHaveLength(ATLAS_PRELOAD_FONTS.length);
      expect(preloadSkinFonts(document)).toBe(0);
    }
  });

  it('the registration machinery is gone from the module', () => {
    const mod = dsSkin as Record<string, unknown>;
    expect(mod.registerDsColorTokens).toBeUndefined();
    expect(mod.DS_COLOR_TOKENS).toBeUndefined();
    expect(mod.DS_SKIN_FADE_ATTR).toBeUndefined();
  });
});
