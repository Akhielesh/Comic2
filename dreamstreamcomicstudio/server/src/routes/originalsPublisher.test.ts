// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createOriginalsPublisher } from './originalsPublisher.js';

vi.mock('../comic/originals/import.js', () => ({ publishBundledOriginal: vi.fn() }));
vi.mock('../middleware/rateLimit.js', () => ({ createRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next() }));

async function fixture(publish: Parameters<typeof createOriginalsPublisher>[1]) {
  const authenticate = vi.fn(async (token: string) => {
    if (token !== 'test-operator') throw new Error('Unauthorized');
    return {runId: '41', attempt: '1'};
  });
  const {router, busy} = createOriginalsPublisher(authenticate, publish);
  const post = (path: string, body?: object, token = 'test-operator'): Promise<Response> => new Promise((resolve, reject) => {
    let status = 200;
    const headers = new Headers();
    const request = { method: 'POST', url: path, body,
      query: Object.fromEntries(new URL(path, 'http://fixture').searchParams),
      header: (name: string) => name === 'authorization' ? 'Bearer ' + token : undefined };
    const response = {
      setHeader: (name: string, value: string) => headers.set(name,value),
      status: (value: number) => { status = value; return response; },
      sendStatus: (value: number) => resolve(new Response(null,{status:value, headers})),
      json: (value: unknown) => resolve(Response.json(value,{status, headers}))
    };
    (router as any).handle(request,response,(err?: unknown) => err ? reject(err) : resolve(new Response(null,{status:404})));
  });
  return {post, busy};
}

describe('Studio Originals publication requests', () => {
  it('starts one fixed bundled book and polls the original publication', async () => {
    const slug = 'DSOriginalPort001';
    let finish!: (v: {slug: string}) => void;
    const publish = vi.fn(() => new Promise<{slug: string}>(resolve => { finish = resolve; }));
    const {post,busy} = await fixture(publish);
    expect((await post('/harbor')).status).toBe(202);
    expect((await post('/harbor')).status).toBe(202);
    expect((await post('/fox')).status).toBe(409);
    expect(busy()).toBe(true);
    expect(publish.mock.calls).toEqual([['harbor', '/app/editorial-originals']]);
    finish({slug});
    const response = await post('/harbor');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({state:'published', slug});
    expect(busy()).toBe(false);
  });

  it('rejects unrecognized books, credentials and caller-supplied content', async () => {
    const publish = vi.fn();
    const {post} = await fixture(publish);
    expect((await post('/unapproved')).status).toBe(404);
    expect((await post('/tide',undefined,'invalid')).status).toBe(401);
    const held=await post('/tide'); expect(held.status).toBe(410);
    expect(await held.json()).toEqual({state:'held',code:'EDITION_HELD'});
    expect((await post('/fox', undefined, 'invalid')).status).toBe(401);
    expect((await post('/fox', {url:'https://example.invalid'})).status).toBe(400);
    expect((await post('/fox?owner=1')).status).toBe(400);
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps a failed attempt stopped and reveals no provider details', async () => {
    const publish = vi.fn(async () => {throw new Error('upstream details');});
    const {post} = await fixture(publish);
    expect((await post('/harbor')).status).toBe(202);
    const response = await post('/harbor');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({state:'failed',code:'PUBLICATION_FAILED'});
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
