// @vitest-environment node
// The Pages middleware's front-page rule: the main site's bare `/` → Comic Studio, wired through
// createOnRequest and the production onRequest (services/productHost.ts holds the conditions).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOnRequest, onRequest } from './_middleware';
import { MAIN_FRONT_PAGE_TO_COMICS } from '../services/productHost';

const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const COMICS = 'https://comics.dreamstreamstudio.ai/';

type Init = { ua?: string; method?: string; cookie?: string; forwarded?: string };

const make = (handler: ReturnType<typeof createOnRequest>) => {
  const next = vi.fn(async () => new Response('<!doctype html><title>app</title>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
  const go = (url: string, init: Init = {}) => {
    const headers: Record<string, string> = { 'user-agent': init.ua ?? HUMAN };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.forwarded) headers['x-forwarded-host'] = init.forwarded;
    return handler({ request: new Request(url, { method: init.method ?? 'GET', headers }), next, env: {} });
  };
  return { go, next };
};

afterEach(() => vi.unstubAllGlobals());

for (const streamHostOn of [false, true]) {
  describe(`front page → comics (STREAM_HOST_ON=${streamHostOn})`, () => {
    const on = () => make(createOnRequest({ streamHostOn, frontPageToComics: true }));

    const redirects: Array<[string, string, Init, string]> = [
      ['GET /', 'https://dreamstreamstudio.ai/', {}, COMICS],
      ['HEAD /', 'https://dreamstreamstudio.ai/', { method: 'HEAD' }, COMICS],
      ['tracking keys carried', 'https://dreamstreamstudio.ai/?utm_source=news&gclid=1&ref=x', {}, `${COMICS}?utm_source=news&gclid=1&ref=x`],
      ['link-preview bot', 'https://dreamstreamstudio.ai/', { ua: 'facebookexternalhit/1.1' }, COMICS],
      ['search engine', 'https://dreamstreamstudio.ai/', { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }, COMICS],
      ['Slackbot', 'https://dreamstreamstudio.ai/', { ua: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' }, COMICS],
      ['other cookie only', 'https://dreamstreamstudio.ai/', { cookie: 'theme=dark' }, COMICS],
    ];
    for (const [name, url, init, location] of redirects) {
      it(`302s: ${name}`, async () => {
        const { go, next } = on();
        const res = await go(url, init);
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(location);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(next).not.toHaveBeenCalled();
      });
    }

    it('www goes to the apex first (where the member hint lives), then on to comics', async () => {
      const { go } = on();
      const first = await go('https://www.dreamstreamstudio.ai/?utm_source=x');
      expect(first.status).toBe(301);
      expect(first.headers.get('location')).toBe('https://dreamstreamstudio.ai/?utm_source=x');
      const second = await go(first.headers.get('location') as string);
      expect(second.status).toBe(302);
      expect(second.headers.get('location')).toBe(`${COMICS}?utm_source=x`);
      const member = await go(first.headers.get('location') as string, { cookie: 'ds_member=1' });
      expect(member.status).toBe(200);
    });

    const served: Array<[string, string, Init]> = [
      ['member hint', 'https://dreamstreamstudio.ai/', { cookie: 'a=1; ds_member=1' }],
      ['member hint with tracking', 'https://dreamstreamstudio.ai/?utm_source=x', { cookie: 'ds_member=1' }],
      ['escape hatch', 'https://dreamstreamstudio.ai/?home=1', {}],
      ['auth code', 'https://dreamstreamstudio.ai/?code=abc', {}],
      ['auth token', 'https://dreamstreamstudio.ai/?token=abc', {}],
      ['token hash', 'https://dreamstreamstudio.ai/?token_hash=abc&type=signup', {}],
      ['auth error', 'https://dreamstreamstudio.ai/?error=access_denied', {}],
      ['invite', 'https://dreamstreamstudio.ai/?invite=abc', {}],
      ['view deep link', 'https://dreamstreamstudio.ai/?view=privacy', {}],
      ['installed app', 'https://dreamstreamstudio.ai/?view=dashboard&source=pwa', {}],
      ['tracking plus another key', 'https://dreamstreamstudio.ai/?utm_source=x&next=%2Fsettings', {}],
      ['index.html', 'https://dreamstreamstudio.ai/index.html', {}],
      ['auth callback', 'https://dreamstreamstudio.ai/auth/callback?code=abc', {}],
      ['settings', 'https://dreamstreamstudio.ai/settings', {}],
      ['share page', 'https://dreamstreamstudio.ai/c/abc', {}],
      ['POST', 'https://dreamstreamstudio.ai/', { method: 'POST' }],
      ['preview deploy', 'https://abc123.comic2.pages.dev/', {}],
      ['branch deploy', 'https://main.comic2.pages.dev/', {}],
      ['localhost', 'http://localhost:8788/', {}],
      ['comics front door proxy', 'https://comic2.pages.dev/', { forwarded: 'comics.dreamstreamstudio.ai' }],
      ['comics front door proxy with tracking', 'https://comic2.pages.dev/?utm_source=x', { forwarded: 'comics.dreamstreamstudio.ai' }],
      ['apex with a forged comics forwarded host', 'https://dreamstreamstudio.ai/', { forwarded: 'comics.dreamstreamstudio.ai' }],
    ];
    for (const [name, url, init] of served) {
      it(`serves: ${name}`, async () => {
        const { go } = on();
        const res = await go(url, init);
        expect(res.status).toBe(200);
        expect(res.headers.get('location')).toBeNull();
      });
    }

    it('the Stream Studio host is never sent to comics', async () => {
      const { go } = on();
      const res = await go('https://stream.dreamstreamstudio.ai/');
      expect(res.headers.get('location') ?? '').not.toContain('comics.');
    });

    it('AI agents still go to the check-in, as before', async () => {
      const { go } = on();
      const res = await go('https://dreamstreamstudio.ai/', { ua: 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('/api/agent-gate');
    });

    it('with the switch off, the front page is served', async () => {
      const { go } = make(createOnRequest({ streamHostOn, frontPageToComics: false }));
      for (const url of ['https://dreamstreamstudio.ai/', 'https://dreamstreamstudio.ai/?utm_source=x']) {
        const res = await go(url);
        expect(res.status).toBe(200);
      }
      const { go: goDefault } = make(createOnRequest({ streamHostOn }));
      expect((await goDefault('https://dreamstreamstudio.ai/')).status).toBe(200);
    });
  });
}

describe('production onRequest follows the switch', () => {
  it('reads MAIN_FRONT_PAGE_TO_COMICS from services/productHost.ts', async () => {
    const next = vi.fn(async () => new Response('app', { status: 200, headers: { 'content-type': 'text/html' } }));
    const res = await onRequest({ request: new Request('https://dreamstreamstudio.ai/', { headers: { 'user-agent': HUMAN } }), next, env: {} });
    if (MAIN_FRONT_PAGE_TO_COMICS) {
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(COMICS);
    } else {
      expect(res.status).toBe(200);
    }
  });
});
