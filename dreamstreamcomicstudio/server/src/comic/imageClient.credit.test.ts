// @vitest-environment node
// credit-safety.md: which image failures are a confirmed refusal of the KEY (a run stops or moves to the same payer's
// other key) and which are transient (a rate limit is never one), and the route a run excludes after one.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getImageModel } from '../../../shared/comic/models.js';
import { __resetSharedKeyCircuit } from '../ai/providerCircuit.js';
import { __resetImageClientForTests, classifyImageError, createImageGenerator, creditRefusalOf, fallbackRefusalOf, imageFailureInfo, type GeminiModelsLike } from './imageClient.js';
import { __setModelHealthForTests } from './models/health.js';
import { fakeModelHealth } from './models/health.fakes.js';
import type { ImageRequest, StudioKeys } from './types.js';

const NB21 = getImageModel('nano-banana-2.1')!;
const BOTH_OWN: StudioKeys = { openrouter: { key: 'sk-or-synthetic', byok: true }, gemini: { key: 'AIza-synthetic', byok: true } };
const OWN_OR: StudioKeys = { openrouter: { key: 'sk-or-synthetic', byok: true } };

const req = (over: Partial<ImageRequest> = {}): ImageRequest => ({ spec: NB21, resolution: '2K', aspect: '2:3', prompt: 'Draw a comic page.', references: [], ...over });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const geminiImage = () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'R0VN' } }] }, finishReason: 'STOP' }] });
const own = { route: 'openrouter' as const, byok: true };

beforeEach(() => {
  __resetImageClientForTests();
  __resetSharedKeyCircuit();
  __setModelHealthForTests(fakeModelHealth({ now: Date.now() }));
});

describe('a confirmed credit refusal (imageClient classification)', () => {
  it('402, and a 403 that says credit, limit or quota, are credit refusals of the key', () => {
    expect(creditRefusalOf(classifyImageError({ status: 402, message: 'Insufficient credits' }, own))).toBe('credit');
    expect(creditRefusalOf(classifyImageError({ status: 403, message: 'Key limit exceeded' }, own))).toBe('credit');
    expect(creditRefusalOf(classifyImageError({ status: 403, message: 'Quota exceeded for this project' }, { route: 'gemini', byok: true }))).toBe('credit');
    // The platform's own key out of credit is one too (the run stops, or moves to another platform route).
    expect(creditRefusalOf(classifyImageError({ status: 402, message: 'Insufficient credits' }, { route: 'openrouter', byok: false }))).toBe('credit');
  });

  it('a Google project with no image quota at all ("limit: 0") is a no-quota refusal, directly or through OpenRouter', () => {
    const unbilled = { status: 429, message: 'RESOURCE_EXHAUSTED generate_content_free_tier_requests, limit: 0' };
    expect(creditRefusalOf(classifyImageError(unbilled, { route: 'gemini', byok: true }))).toBe('no_quota');
    expect(creditRefusalOf(classifyImageError(unbilled, own))).toBe('no_quota');
  });

  it('never a transient rate limit, a per-minute quota, a moderation 403, a bad key or an outage', () => {
    for (const [err, ctx] of [
      [{ status: 429, message: 'Rate limited' }, own],
      [{ status: 429, message: 'RESOURCE_EXHAUSTED free_tier_requests, limit: 50' }, { route: 'gemini' as const, byok: true }],
      [{ message: 'Too many requests, please slow down' }, own],
      // OpenRouter's moderation refusal mentions credits but is not a capacity failure.
      [{ status: 403, message: 'Your input was flagged for "violence". No credits were charged.' }, own],
      [{ status: 401, message: 'No auth credentials found' }, own],
      [{ status: 503, message: 'upstream unavailable' }, own],
      [{ status: 504, message: 'gateway timeout' }, own]
    ] as const) {
      expect(creditRefusalOf(classifyImageError(err, ctx)), JSON.stringify(err)).toBeUndefined();
    }
    expect(creditRefusalOf(new Error('anything'))).toBeUndefined();
    expect(creditRefusalOf(null)).toBeUndefined();
  });

  it('a refusal on the wire reaches the run with its route and no further call (never retried, never sent elsewhere by itself)', async () => {
    const fetchMock = vi.fn(async () => json({ error: { message: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits' } }, 402));
    const generateContent = vi.fn().mockResolvedValue(geminiImage());
    const generate = createImageGenerator(BOTH_OWN, {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => undefined,
      createGemini: () => ({ generateContent }) as GeminiModelsLike,
      imageEndpoints: async () => null
    });
    const err = await generate(req()).catch((e) => e);
    expect(creditRefusalOf(err)).toBe('credit');
    expect(imageFailureInfo(err)).toMatchObject({ route: 'openrouter', status: 402 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The run decides whether the same payer's other key goes next; the client never moves money by itself here.
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe('excludeRoutes: a key refused in this run is never called again', () => {
  it('starts on the same payer\'s other route when the first one is excluded', async () => {
    const fetchMock = vi.fn(async () => json({}, 500));
    const generateContent = vi.fn().mockResolvedValue(geminiImage());
    const generate = createImageGenerator(BOTH_OWN, {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => undefined,
      createGemini: () => ({ generateContent }) as GeminiModelsLike,
      imageEndpoints: async () => null
    });
    await expect(generate(req({ excludeRoutes: ['openrouter'] }))).resolves.toMatchObject({ route: 'gemini', byok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never falls back onto an excluded route, even on a rate limit', async () => {
    const generateContent = vi.fn().mockRejectedValue(Object.assign(new Error('Rate limited'), { status: 429 }));
    const fetchMock = vi.fn(async () => json({}, 200));
    const generate = createImageGenerator(BOTH_OWN, {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => undefined,
      createGemini: () => ({ generateContent }) as GeminiModelsLike,
      imageEndpoints: async () => null
    });
    await expect(generate(req({ preferRoute: 'gemini', excludeRoutes: ['openrouter'] }))).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a busy first route whose fallback key is refused for credit reports the busy route and keeps the refusal, so a retry never calls that key', async () => {
    const fetchMock = vi.fn(async () => json({ error: { message: 'Rate limited' } }, 429));
    const generateContent = vi.fn().mockRejectedValue(Object.assign(new Error('RESOURCE_EXHAUSTED generate_content_free_tier_requests, limit: 0'), { status: 429 }));
    const generate = createImageGenerator(BOTH_OWN, {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => undefined,
      createGemini: () => ({ generateContent }) as GeminiModelsLike,
      imageEndpoints: async () => null
    });
    const err = await generate(req()).catch((e) => e);
    // The run retries the first route (a rate limit), and learns the other key must never be called again.
    expect(err).toMatchObject({ code: 'RATE_LIMIT' });
    expect(creditRefusalOf(err)).toBeUndefined();
    expect(fallbackRefusalOf(err)).toEqual({ route: 'gemini', refusal: 'no_quota' });
    expect(generateContent).toHaveBeenCalledTimes(1);
    // The run's next attempt excludes it: the first route is still busy (or paused by the breaker), and the refused key
    // is not called again.
    const again = await generate(req({ preferRoute: 'openrouter', excludeRoutes: ['gemini'] })).catch((e) => e);
    expect(again).toMatchObject({ code: expect.stringMatching(/^(RATE_LIMIT|PROVIDER_ERROR)$/) });
    expect(creditRefusalOf(again)).toBeUndefined();
    expect(fallbackRefusalOf(again)).toBeUndefined();
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('an outage on the first route and a 402 on the other key keep that key\'s credit refusal too', async () => {
    const fetchMock = vi.fn(async () => json({ error: { message: 'upstream unavailable' } }, 503));
    const generateContent = vi.fn().mockRejectedValue(Object.assign(new Error('Insufficient credits'), { status: 402 }));
    const generate = createImageGenerator(BOTH_OWN, {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => undefined,
      createGemini: () => ({ generateContent }) as GeminiModelsLike,
      imageEndpoints: async () => null
    });
    const err = await generate(req()).catch((e) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(creditRefusalOf(err)).toBeUndefined();
    expect(fallbackRefusalOf(err)).toEqual({ route: 'gemini', refusal: 'credit' });
  });

  it('a fallback that was only busy too carries no refusal', async () => {
    const fetchMock = vi.fn(async () => json({ error: { message: 'Rate limited' } }, 429));
    const generateContent = vi.fn().mockRejectedValue(Object.assign(new Error('Rate limited'), { status: 429 }));
    const generate = createImageGenerator(BOTH_OWN, {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => undefined,
      createGemini: () => ({ generateContent }) as GeminiModelsLike,
      imageEndpoints: async () => null
    });
    const err = await generate(req()).catch((e) => e);
    expect(err).toMatchObject({ code: 'RATE_LIMIT' });
    expect(fallbackRefusalOf(err)).toBeUndefined();
  });

  it('with every route excluded, nothing is called and nothing is charged', async () => {
    const fetchMock = vi.fn(async () => json({}, 200));
    const generate = createImageGenerator(OWN_OR, { fetch: fetchMock as unknown as typeof fetch, sleep: async () => undefined, imageEndpoints: async () => null });
    const err = await generate(req({ excludeRoutes: ['openrouter'] })).catch((e) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_ERROR', retryable: false, spentUsd: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
