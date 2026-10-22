import { describe, expect, it } from 'vitest';
import {
  COMICS_AUTH_CALLBACK_URL,
  COMICS_ORIGIN,
  comicShareUrl,
  comicsUrl,
  comicsEntryUrl,
  isComicsHost,
  isMainSiteHost,
  mainAppUrl,
  resolveAuthRedirectUrl
} from './productHost';

describe('productHost', () => {
  it('recognises the comics host and its alias, case-insensitively', () => {
    expect(isComicsHost('comics.dreamstreamstudio.ai')).toBe(true);
    expect(isComicsHost('COMICS.dreamstreamstudio.ai.')).toBe(true);
    expect(isComicsHost('comic.dreamstreamstudio.ai')).toBe(true);
  });

  it('rejects the apex, other products and look-alikes', () => {
    for (const host of [
      'dreamstreamstudio.ai',
      'atlas.dreamstreamstudio.ai',
      'comic2.pages.dev',
      'localhost',
      'comics.dreamstreamstudio.ai.evil.com',
      'evilcomics.dreamstreamstudio.ai',
      ''
    ]) expect(isComicsHost(host)).toBe(false);
  });

  it('builds absolute URLs on each origin', () => {
    expect(comicsUrl()).toBe(`${COMICS_ORIGIN}/`);
    expect(comicsUrl('?view=studio&id=1')).toBe(`${COMICS_ORIGIN}/?view=studio&id=1`);
    expect(mainAppUrl('/account')).toBe('https://dreamstreamstudio.ai/account');
  });

  it('builds share links on the comics host and encodes the slug', () => {
    expect(comicShareUrl('aB3dE5fG7hJ9kL1mN')).toBe('https://comics.dreamstreamstudio.ai/c/aB3dE5fG7hJ9kL1mN');
    expect(comicShareUrl('a/../b')).toBe('https://comics.dreamstreamstudio.ai/c/a%2F..%2Fb');
  });

  it('uses the exact comics callback on the comics host, never the apex env value', () => {
    expect(COMICS_AUTH_CALLBACK_URL).toBe('https://comics.dreamstreamstudio.ai/auth/callback');
    expect(
      resolveAuthRedirectUrl({
        explicit: 'https://dreamstreamstudio.ai/auth/callback',
        hostname: 'comics.dreamstreamstudio.ai',
        origin: 'https://comics.dreamstreamstudio.ai'
      })
    ).toBe('https://comics.dreamstreamstudio.ai/auth/callback');
    // The alias never gets its own callback (Supabase only allows the canonical one).
    expect(resolveAuthRedirectUrl({ hostname: 'comic.dreamstreamstudio.ai', origin: 'https://comic.dreamstreamstudio.ai' })).toBe(
      'https://comics.dreamstreamstudio.ai/auth/callback'
    );
  });

  it('keeps the apex behaviour elsewhere: env value first, then the current origin', () => {
    expect(
      resolveAuthRedirectUrl({ explicit: ' https://dreamstreamstudio.ai/auth/callback ', hostname: 'dreamstreamstudio.ai', origin: 'https://dreamstreamstudio.ai' })
    ).toBe('https://dreamstreamstudio.ai/auth/callback');
    expect(resolveAuthRedirectUrl({ explicit: '', hostname: 'localhost', origin: 'http://localhost:3000' })).toBe('http://localhost:3000/auth/callback');
    expect(resolveAuthRedirectUrl({ hostname: 'evilcomics.dreamstreamstudio.ai', origin: 'https://evilcomics.dreamstreamstudio.ai' })).toBe(
      'https://evilcomics.dreamstreamstudio.ai/auth/callback'
    );
    expect(resolveAuthRedirectUrl({})).toBe('/auth/callback');
  });

  it('points main-site Comic Studio entries at the comics host only from the production main site', () => {
    expect(isMainSiteHost('dreamstreamstudio.ai')).toBe(true);
    expect(isMainSiteHost('WWW.dreamstreamstudio.ai')).toBe(true);
    expect(comicsEntryUrl('dreamstreamstudio.ai')).toBe('https://comics.dreamstreamstudio.ai/');
    for (const host of ['localhost', 'comic2.pages.dev', 'abc.comic2.pages.dev', 'comics.dreamstreamstudio.ai', 'dreamstreamstudio.ai.evil.com']) {
      expect(comicsEntryUrl(host)).toBeNull();
    }
  });
});
