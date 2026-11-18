// @vitest-environment node
// The main site's front page → Comic Studio: every condition of frontPageToComicsUrl, the member hint cookie
// and its browser-side sync.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAIN_FRONT_PAGE_TO_COMICS,
  MEMBER_HINT_COOKIE,
  frontPageToComicsUrl,
  hasMemberHint,
  memberHintCookie,
  syncMemberHint,
} from './productHost';

const COMICS = 'https://comics.dreamstreamstudio.ai/';
const go = (url: string, init: { method?: string; cookie?: string | null } = {}) =>
  frontPageToComicsUrl({ url, method: init.method ?? 'GET', cookie: init.cookie ?? null }, true);

afterEach(() => vi.unstubAllGlobals());

describe('MAIN_FRONT_PAGE_TO_COMICS', () => {
  it('is on for this release', () => {
    expect(MAIN_FRONT_PAGE_TO_COMICS).toBe(true);
  });
});

describe('frontPageToComicsUrl', () => {
  const redirected: Array<[string, string, string?]> = [
    ['bare apex', 'https://dreamstreamstudio.ai/', COMICS],
    ['bare www', 'https://www.dreamstreamstudio.ai/', COMICS],
    ['mixed-case host, trailing dot', 'https://DreamStreamStudio.AI./', COMICS],
    ['empty query', 'https://dreamstreamstudio.ai/?', COMICS],
    ['utm keys carried', 'https://dreamstreamstudio.ai/?utm_source=x&utm_medium=email&utm_campaign=launch', `${COMICS}?utm_source=x&utm_medium=email&utm_campaign=launch`],
    ['other utm_* key', 'https://dreamstreamstudio.ai/?utm_whatever=1', `${COMICS}?utm_whatever=1`],
    ['ref', 'https://dreamstreamstudio.ai/?ref=producthunt', `${COMICS}?ref=producthunt`],
    ['click ids', 'https://dreamstreamstudio.ai/?fbclid=a&gclid=b&li_fat_id=c&msclkid=d', `${COMICS}?fbclid=a&gclid=b&li_fat_id=c&msclkid=d`],
  ];
  for (const [name, url, expected] of redirected) {
    it(`redirects: ${name}`, () => {
      expect(go(url)).toBe(expected);
      expect(go(url, { method: 'HEAD' })).toBe(expected);
    });
  }

  const served: Array<[string, string]> = [
    ['auth code', '/?code=abc'],
    ['auth token', '/?token=abc'],
    ['token hash + type', '/?token_hash=abc&type=magiclink'],
    ['auth error', '/?error=access_denied&error_description=x'],
    ['type alone', '/?type=recovery'],
    ['view deep link', '/?view=dashboard&source=pwa'],
    ['legacy reader', '/?view=read&id=11111111-1111-4111-8111-111111111111'],
    ['invite', '/?invite=abc'],
    ['next', '/?next=%2Fsettings'],
    ['connector return', '/?connected=drive'],
    ['tracking plus intent', '/?utm_source=x&view=gallery'],
    ['escape hatch', '/?home=1'],
    ['escape hatch with tracking', '/?utm_source=x&home=1'],
    ['empty key', '/?=x'],
    ['utm_ prefix only', '/?utm_=1'],
    ['index.html', '/index.html'],
    ['auth callback', '/auth/callback'],
    ['settings', '/settings'],
    ['models', '/models'],
    ['live', '/live'],
    ['share page', '/c/slug'],
    ['double slash', '//'],
  ];
  for (const [name, path] of served) {
    it(`serves: ${name}`, () => {
      expect(go(`https://dreamstreamstudio.ai${path}`)).toBeNull();
    });
  }

  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    it(`serves ${method}`, () => {
      expect(go('https://dreamstreamstudio.ai/', { method })).toBeNull();
    });
  }

  for (const host of [
    'comics.dreamstreamstudio.ai',
    'comic.dreamstreamstudio.ai',
    'stream.dreamstreamstudio.ai',
    'atlas.dreamstreamstudio.ai',
    'comic2.pages.dev',
    'abc123.comic2.pages.dev',
    'main.comic2.pages.dev',
    'localhost:5173',
    '127.0.0.1:8788',
    'dreamstreamstudio.ai.evil.example',
  ]) {
    it(`serves host ${host}`, () => {
      expect(go(`https://${host}/`)).toBeNull();
    });
  }

  it('serves a browser carrying the member hint', () => {
    expect(go('https://dreamstreamstudio.ai/', { cookie: 'ds_member=1' })).toBeNull();
    expect(go('https://dreamstreamstudio.ai/?utm_source=x', { cookie: 'a=b; ds_member=1; c=d' })).toBeNull();
    expect(go('https://www.dreamstreamstudio.ai/', { cookie: 'ds_member=1' })).toBeNull();
  });

  it('a hint with another value, or a look-alike name, does not count', () => {
    expect(go('https://dreamstreamstudio.ai/', { cookie: 'ds_member=0' })).toBe(COMICS);
    expect(go('https://dreamstreamstudio.ai/', { cookie: 'ds_member=' })).toBe(COMICS);
    expect(go('https://dreamstreamstudio.ai/', { cookie: 'xds_member=1' })).toBe(COMICS);
  });

  it('never redirects with the switch off', () => {
    for (const url of ['https://dreamstreamstudio.ai/', 'https://www.dreamstreamstudio.ai/', 'https://dreamstreamstudio.ai/?utm_source=x']) {
      expect(frontPageToComicsUrl({ url, method: 'GET' }, false)).toBeNull();
    }
  });

  it('never points at a host it would redirect again (no loop)', () => {
    const target = go('https://dreamstreamstudio.ai/?utm_source=x');
    expect(target).not.toBeNull();
    expect(go(target as string)).toBeNull();
  });

  it('a malformed URL is served', () => {
    expect(frontPageToComicsUrl({ url: 'not a url', method: 'GET' }, true)).toBeNull();
  });
});

describe('member hint cookie', () => {
  it('reads the hint from a Cookie header', () => {
    expect(hasMemberHint('ds_member=1')).toBe(true);
    expect(hasMemberHint(' foo=1 ;ds_member=1 ')).toBe(true);
    expect(hasMemberHint(null)).toBe(false);
    expect(hasMemberHint('ds_member=yes')).toBe(false);
  });

  it('is written only on the main site, with the agreed attributes', () => {
    expect(memberHintCookie(true, 'dreamstreamstudio.ai')).toBe(`${MEMBER_HINT_COOKIE}=1; Path=/; Secure; SameSite=Lax; Max-Age=31536000`);
    expect(memberHintCookie(false, 'dreamstreamstudio.ai')).toBe(`${MEMBER_HINT_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`);
    for (const host of ['comics.dreamstreamstudio.ai', 'localhost', 'abc.comic2.pages.dev', '']) {
      expect(memberHintCookie(true, host)).toBeNull();
      expect(memberHintCookie(false, host)).toBeNull();
    }
  });

  const stubBrowser = (hostname: string, cookie = '') => {
    const writes: string[] = [];
    const doc = {
      get cookie() {
        return cookie;
      },
      set cookie(value: string) {
        writes.push(value);
      },
    };
    vi.stubGlobal('window', { location: { hostname } });
    vi.stubGlobal('document', doc);
    return writes;
  };

  it('sets the hint while signed in on the main site', () => {
    const writes = stubBrowser('dreamstreamstudio.ai');
    syncMemberHint(true);
    expect(writes).toEqual([`${MEMBER_HINT_COOKIE}=1; Path=/; Secure; SameSite=Lax; Max-Age=31536000`]);
  });

  it('removes the hint on sign-out, and writes nothing for a visitor who never had one', () => {
    const removed = stubBrowser('dreamstreamstudio.ai', 'ds_member=1');
    syncMemberHint(false);
    expect(removed).toEqual([`${MEMBER_HINT_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`]);
    const untouched = stubBrowser('dreamstreamstudio.ai', 'theme=dark');
    syncMemberHint(false);
    expect(untouched).toEqual([]);
  });

  it('writes nothing off the main site or without a document', () => {
    for (const host of ['comics.dreamstreamstudio.ai', 'localhost', 'x.comic2.pages.dev']) {
      const writes = stubBrowser(host);
      syncMemberHint(true);
      expect(writes).toEqual([]);
    }
    vi.unstubAllGlobals();
    expect(() => syncMemberHint(true)).not.toThrow();
  });
});
