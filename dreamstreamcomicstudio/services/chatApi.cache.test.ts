// readArticle / unfurlLink memoise per URL, but only what the server answered. The news list prefetches
// an article on hover, and the per-caller limit on /api/chat/read-url (60/min) can refuse a fast sweep
// down a long list; that 429 must not become the URL's answer for the rest of the session, so a later
// click asks again. An article the server could not read (`ok: false` in a 200) stays cached.
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock('./apiClient', () => ({
  get: (...args: unknown[]) => getMock(...args),
  post: vi.fn(),
  postStream: vi.fn(),
  ApiError: class ApiError extends Error {}
}));

import { readArticle, unfurlLink } from './chatApi';

afterEach(() => getMock.mockReset());

const refused = () => Object.assign(new Error('Rate limit exceeded for chat_read_url. Retry in 12s.'), { status: 429 });

describe('readArticle cache', () => {
  it('a refused prefetch does not poison the later click', async () => {
    const url = 'https://news.example.com/a-1';
    getMock.mockRejectedValueOnce(refused());
    const prefetch = await readArticle(url);
    expect(prefetch).toMatchObject({ ok: false, error: 'fetch failed' });

    getMock.mockResolvedValueOnce({ url, host: 'news.example.com', blocks: [{ type: 'p', text: 'Body' }], ok: true });
    const click = await readArticle(url);
    expect(click.ok).toBe(true);
    expect(getMock).toHaveBeenCalledTimes(2);
    // …and the good answer is cached from then on.
    expect((await readArticle(url)).ok).toBe(true);
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('concurrent calls share one request', async () => {
    const url = 'https://news.example.com/a-2';
    getMock.mockResolvedValueOnce({ url, host: 'news.example.com', blocks: [], ok: true });
    const [a, b] = await Promise.all([readArticle(url), readArticle(url)]);
    expect(a).toBe(b);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('an article the server could not read stays cached (no re-fetch of a page that cannot be read)', async () => {
    const url = 'https://paywalled.example.com/a-3';
    getMock.mockResolvedValueOnce({ url, host: 'paywalled.example.com', blocks: [], ok: false, error: 'blocked' });
    expect((await readArticle(url)).ok).toBe(false);
    expect((await readArticle(url)).error).toBe('blocked');
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});

describe('unfurlLink cache', () => {
  it('a refused unfurl is retried on the next call', async () => {
    const url = 'https://site.example.com/p';
    getMock.mockRejectedValueOnce(refused());
    expect(await unfurlLink(url)).toEqual({ url });
    getMock.mockResolvedValueOnce({ url, title: 'A page' });
    expect(await unfurlLink(url)).toEqual({ url, title: 'A page' });
    expect(await unfurlLink(url)).toEqual({ url, title: 'A page' });
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});
