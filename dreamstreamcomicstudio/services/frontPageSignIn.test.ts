// @vitest-environment node
// A main-site sign-in link in the fragment (the Supabase Site URL fallback on the bare front page) still finishes on
// the main site while the front page redirect is on: the edge cannot see the fragment and sends the page to Comic
// Studio, the browser keeps the fragment, and the comics host sends that page straight back to the main site's
// /?home=1 with the same fragment, before anything renders (index.tsx). Comic Studio's own pages are never moved.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMainAuthLink } from './authLink';
import { signInLinkBackToMain } from './frontPageSignIn';
import { frontPageToComicsUrl } from './productHost';

const FRAGMENT_LINKS = [
  'https://dreamstreamstudio.ai/#access_token=aaa&refresh_token=bbb&expires_in=3600&token_type=bearer&type=recovery',
  'https://dreamstreamstudio.ai/#access_token=aaa&refresh_token=bbb&type=invite',
  'https://dreamstreamstudio.ai/#access_token=aaa&refresh_token=bbb&type=magiclink',
  'https://dreamstreamstudio.ai/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid',
  'https://dreamstreamstudio.ai/?utm_source=mail#access_token=aaa&refresh_token=bbb&type=invite',
];

/** What a browser without the member hint does with a link: the edge sees no fragment; a 302 keeps the fragment. */
const browse = (href: string): string => {
  const url = new URL(href);
  const moved = frontPageToComicsUrl({ url: `${url.origin}${url.pathname}${url.search}`, method: 'GET', cookie: null }, true);
  return moved ? `${moved}${url.hash}` : href;
};

describe('a main-site sign-in link in the fragment', () => {
  for (const href of FRAGMENT_LINKS) {
    it(`finishes on the main site: ${new URL(href).hash.slice(1, 30)}…`, () => {
      const original = readMainAuthLink(new URL(href));
      expect(original).not.toBeNull();
      // The edge moves the bare front page (it never sees the fragment)…
      const onComics = browse(href);
      expect(new URL(onComics).hostname).toBe('comics.dreamstreamstudio.ai');
      // …and the comics host sends it back to the main front page's escape hatch, fragment and all.
      const back = signInLinkBackToMain(onComics, true);
      expect(back).toBe(`https://dreamstreamstudio.ai/?home=1${new URL(href).hash}`);
      // The edge serves that page (no second redirect), and the main app reads the very same sign-in link there.
      expect(browse(back!)).toBe(back);
      expect(readMainAuthLink(new URL(back!))).toEqual({ ...original, next: null });
    });
  }
});

describe('everything else stays where it is', () => {
  const stays: Array<[string, string]> = [
    ['comics front page with a section link', 'https://comics.dreamstreamstudio.ai/#looks'],
    ['comics front page, no fragment', 'https://comics.dreamstreamstudio.ai/'],
    ['comics front page, empty fragment', 'https://comics.dreamstreamstudio.ai/#'],
    ['comics own callback', 'https://comics.dreamstreamstudio.ai/auth/callback#access_token=aaa&refresh_token=bbb'],
    ['a share link carrying auth-looking params', 'https://comics.dreamstreamstudio.ai/c/AbCdEfGhIjKlMnOpQ#access_token=aaa&refresh_token=bbb'],
    ['a query the redirect never carries', 'https://comics.dreamstreamstudio.ai/?view=gallery#access_token=aaa&refresh_token=bbb'],
    ['a fragment with no sign-in in it', 'https://comics.dreamstreamstudio.ai/#type=recovery'],
    ['the main site itself', 'https://dreamstreamstudio.ai/#access_token=aaa&refresh_token=bbb'],
    ['a preview deploy', 'https://abc.comic2.pages.dev/#access_token=aaa&refresh_token=bbb'],
    ['localhost', 'http://localhost:5173/#access_token=aaa&refresh_token=bbb'],
    ['not a URL', 'not a url'],
  ];
  for (const [name, href] of stays) {
    it(name, () => expect(signInLinkBackToMain(href, true)).toBeNull());
  }

  it('the comics alias host is treated like the comics host', () => {
    expect(signInLinkBackToMain('https://comic.dreamstreamstudio.ai/#access_token=aaa&refresh_token=bbb', true)).toBe(
      'https://dreamstreamstudio.ai/?home=1#access_token=aaa&refresh_token=bbb'
    );
  });

  it('with the redirect switched off nothing is moved', () => {
    expect(signInLinkBackToMain('https://comics.dreamstreamstudio.ai/#access_token=aaa&refresh_token=bbb', false)).toBeNull();
  });
});

describe('index.tsx asks before anything renders', () => {
  it('replaces the page and renders nothing when the link goes back', () => {
    const src = readFileSync(path.resolve(__dirname, '..', 'index.tsx'), 'utf8');
    const ask = src.indexOf('signInLinkBackToMain(window.location.href)');
    const render = src.indexOf('root.render(');
    expect(ask).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(ask);
    expect(src.slice(ask, render)).toMatch(/window\.location\.replace\(/);
  });
});
