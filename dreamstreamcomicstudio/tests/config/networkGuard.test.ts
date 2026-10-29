// @vitest-environment node
// tests/setup.ts refuses every fetch to a non-loopback host, so no test's money, quote or verdict can depend on a
// live provider (stage B: the Model Lab route test read OpenRouter's live endpoint list). This pins the guard.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const take = (): string[] => {
  const fn = (globalThis as { __takeRefusedRequestsForTests?: () => string[] }).__takeRefusedRequestsForTests;
  if (!fn) throw new Error('tests/setup.ts no longer installs the network guard');
  return fn();
};

let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer((_req, res) => res.end('local'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('the test network guard', () => {
  it('refuses a fetch to a provider before it leaves, and records it without the query', async () => {
    await expect(fetch('https://openrouter.ai/api/v1/images/models/x/y/endpoints?key=sk-or-test')).rejects.toThrow(
      'Tests may not reach the network: GET https://openrouter.ai/api/v1/images/models/x/y/endpoints'
    );
    await expect(fetch(new Request('https://generativelanguage.googleapis.com/v1beta/models', { method: 'POST', body: '{}' }))).rejects.toThrow(
      'Tests may not reach the network: POST https://generativelanguage.googleapis.com/v1beta/models'
    );
    expect(take()).toEqual([
      'GET https://openrouter.ai/api/v1/images/models/x/y/endpoints',
      'POST https://generativelanguage.googleapis.com/v1beta/models'
    ]);
  });

  it('a name that can never exist (cdn.test, *.example, example.com) fails like an unreachable host, at once and without being counted', async () => {
    for (const url of ['https://cdn.test/u/p1.png', 'https://cdn.example/x.png', 'https://www.example.com/', 'http://nowhere.invalid/']) {
      await expect(fetch(url)).rejects.toThrow(TypeError);
    }
    expect(take()).toEqual([]);
  });

  it("lets a test reach its own loopback server", async () => {
    expect(await (await fetch(`${base}/ping`)).text()).toBe('local');
    expect(take()).toEqual([]);
  });
});
