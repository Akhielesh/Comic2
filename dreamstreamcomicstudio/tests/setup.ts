import '@testing-library/jest-dom';
import { afterAll, afterEach } from 'vitest';

// jsdom doesn't implement matchMedia, which responsive components (ComicReader,
// AIChatPlatform, …) call to detect viewport width. Provide a desktop-defaulting stub
// so they render in tests instead of throwing.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
}

// No test reaches the network. A spend, quote or verdict that depends on a live provider breaks the day the
// provider's prices or status change (stage B: the Model Lab route test read OpenRouter's live endpoint list).
// Any fetch to a real http(s) host is refused before it leaves, and the test that was running fails and names the
// request. Inject a fake instead: deps.fetch / imageEndpoints / network, a health port (__setModelHealthForTests),
// or vi.stubGlobal('fetch', …). Loopback (a test's own http server) still works. Names that can never exist
// (RFC 2606 / 6761: *.test, *.example, *.invalid, example.com/.net/.org) fail at once the way an unreachable host
// does, without a DNS lookup: fixtures use them on purpose (cdn.test images a reader fails to load).
const realFetch = globalThis.fetch;
if (typeof realFetch === 'function') {
  const refused: string[] = [];
  const isLoopback = (host: string): boolean =>
    host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  const isReservedName = (host: string): boolean =>
    /\.(?:test|example|invalid)$/i.test(host) || /^(?:test|example|invalid)$/i.test(host) || /(?:^|\.)example\.(?:com|net|org)$/i.test(host);
  const urlOf = (input: RequestInfo | URL): URL | null => {
    try {
      return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    } catch {
      return null;
    }
  };
  globalThis.fetch = function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = urlOf(input);
    if (url && (url.protocol === 'http:' || url.protocol === 'https:') && isReservedName(url.hostname)) {
      return Promise.reject(new TypeError('fetch failed', { cause: new Error(`getaddrinfo ENOTFOUND ${url.hostname} (a reserved test name; nothing was sent)`) }));
    }
    if (url && (url.protocol === 'http:' || url.protocol === 'https:') && !isLoopback(url.hostname)) {
      const method = (init?.method || (typeof input === 'object' && 'method' in input ? input.method : '') || 'GET').toUpperCase();
      const where = `${method} ${url.origin}${url.pathname}`; // never the query (it could carry a key)
      refused.push(where);
      return Promise.reject(new TypeError(`Tests may not reach the network: ${where}`));
    }
    return realFetch(input, init);
  } as typeof fetch;
  // The guard's own test (tests/config/networkGuard.test.ts) takes what it tried, so its refusals don't fail it.
  (globalThis as { __takeRefusedRequestsForTests?: () => string[] }).__takeRefusedRequestsForTests = () => refused.splice(0);
  const failOnRefused = (): void => {
    if (!refused.length) return;
    const list = refused.splice(0);
    throw new Error(`A test tried to reach the network (refused, nothing was sent): ${[...new Set(list)].join(', ')}. Inject a fake fetch instead.`);
  };
  afterEach(failOnRefused);
  afterAll(failOnRefused);
}
