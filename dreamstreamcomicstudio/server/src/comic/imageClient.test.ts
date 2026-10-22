// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getImageModel, type ImageModelSpec } from '../../../shared/comic/models.js';
import { __resetSharedKeyCircuit, isSharedKeyCapped } from '../ai/providerCircuit.js';
import {
  __resetImageClientForTests,
  classifyImageError,
  createImageGenerator,
  looksLikeRefusal,
  pickAlternateRoute,
  pickImageRoute,
  providerDetail,
  prepareImageRequest,
  stripUnsupported,
  type GeminiModelsLike
} from './imageClient.js';
import { StudioError, type ImageRequest, type StudioKeys } from './types.js';

const NB21 = getImageModel('nano-banana-2.1')!;
const PRO = getImageModel('nano-banana-pro')!;
const LEGACY = getImageModel('nano-banana-legacy')!;
const GPT = getImageModel('gpt-image-2.5')!;

const OR: StudioKeys = { openrouter: { key: 'sk-or-platform', byok: false } };
const OR_BYOK: StudioKeys = { openrouter: { key: 'sk-or-mine', byok: true } };
const GEM: StudioKeys = { gemini: { key: 'AIza-mine', byok: true } };

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const ref = (label: string, dataUrl = PNG) => ({ label, dataUrl });

const baseReq = (over: Partial<ImageRequest> = {}): ImageRequest => ({
  spec: NB21,
  resolution: '2K',
  aspect: '2:3',
  prompt: 'Draw a comic page.',
  references: [],
  ...over
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const imagesOk = (over: Record<string, unknown> = {}) =>
  json({ model: 'google/gemini-nano-banana-2.1', data: [{ b64_json: 'QUJD', media_type: 'image/webp' }], usage: { cost: 0.0504 }, ...over });

const chatOk = (url = 'data:image/png;base64,WFla', extra: Record<string, unknown> = {}) =>
  json({
    model: 'google/gemini-nano-banana-2.1',
    choices: [{ finish_reason: 'stop', message: { content: 'Here you go', images: [{ type: 'image_url', image_url: { url } }] } }],
    usage: { cost: 0.051 },
    ...extra
  });

type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

const setup = (keys: StudioKeys, responses: Array<Response | Error | (() => Promise<Response>)>, gemini?: GeminiModelsLike) => {
  const queue = [...responses];
  const fetchMock: FetchMock = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next;
  });
  const sleep = vi.fn(async () => undefined);
  const generate = createImageGenerator(keys, {
    fetch: fetchMock as unknown as typeof fetch,
    sleep,
    createGemini: () => gemini || { generateContent: vi.fn() },
    now: () => Date.now()
  });
  const bodyOf = (i: number) => JSON.parse(String(fetchMock.mock.calls[i][1]?.body));
  const urlOf = (i: number) => String(fetchMock.mock.calls[i][0]);
  return { generate, fetchMock, sleep, bodyOf, urlOf };
};

beforeEach(() => {
  __resetImageClientForTests();
  __resetSharedKeyCircuit();
});
afterEach(() => vi.useRealTimers());

describe('pickImageRoute', () => {
  it('prefers OpenRouter, but a BYOK Gemini key beats a PLATFORM OpenRouter key', () => {
    // Platform OpenRouter key + the user's own Gemini key → draw on the user's key, not the
    // platform's (findings 19/28: a BYOK key must not be ignored and silently platform-billed).
    expect(pickImageRoute(NB21, { ...OR, ...GEM })).toMatchObject({ route: 'gemini', model: 'gemini-nano-banana-2.1', key: GEM.gemini });
    // The user's OWN OpenRouter key still wins over their Gemini key (OpenRouter preferred).
    expect(pickImageRoute(NB21, { ...OR_BYOK, ...GEM })).toMatchObject({ route: 'openrouter', model: 'google/gemini-nano-banana-2.1' });
    // Gemini-only → Gemini.
    expect(pickImageRoute(NB21, GEM)).toMatchObject({ route: 'gemini', model: 'gemini-nano-banana-2.1', key: GEM.gemini });
  });

  it('throws NO_IMAGE_KEY without a usable key (and never switches model)', () => {
    expect(() => pickImageRoute(NB21, {})).toThrow(StudioError);
    try {
      pickImageRoute(GPT, GEM);
    } catch (err) {
      expect((err as StudioError).code).toBe('NO_IMAGE_KEY');
      expect((err as StudioError).userMessage).toMatch(/OpenRouter/);
    }
  });
});

describe('prepareImageRequest / stripUnsupported', () => {
  it('snaps unsupported aspects to the nearest supported one', () => {
    expect(prepareImageRequest(baseReq({ spec: PRO, aspect: '1:4' })).aspect).toBe('9:16');
    expect(prepareImageRequest(baseReq({ spec: NB21, aspect: '1:4' })).aspect).toBe('1:4');
  });

  it('only sends a resolution the model takes', () => {
    expect(prepareImageRequest(baseReq({ spec: NB21, resolution: '2K' })).resolution).toBe('2K');
    expect(prepareImageRequest(baseReq({ spec: LEGACY, resolution: '2K' })).resolution).toBeUndefined();
    expect(prepareImageRequest(baseReq({ spec: NB21, resolution: '512' })).resolution).toBeUndefined();
  });

  it('caps references at the model total, dropping from the end', () => {
    const prepared = prepareImageRequest(baseReq({ spec: LEGACY, references: ['A', 'B', 'C', 'D', 'E'].map((l) => ref(l)) }));
    expect(prepared.references.map((r) => r.label)).toEqual(['A', 'B', 'C']);
    expect(prepared.droppedReferences).toBe(2);
  });

  it('rejects empty prompts and unreadable references', () => {
    expect(() => prepareImageRequest(baseReq({ prompt: '  ' }))).toThrow(/empty/);
    expect(() => prepareImageRequest(baseReq({ references: [ref('X', 'not-a-url')] }))).toThrow(/Reference image 1 \(X\)/);
    expect(() => prepareImageRequest(baseReq({ references: [ref('X', 'data:image/png;base64,')] }))).toThrow(StudioError);
    expect(prepareImageRequest(baseReq({ references: [ref('X', 'https://cdn.example.com/a.png')] })).references).toHaveLength(1);
  });

  it('strips unsupported params at the top level and inside image config, including aliases', () => {
    const body = { model: 'm', seed: 3, temperature: 1, image_config: { aspect_ratio: '2:3', image_size: '2K' } };
    expect(stripUnsupported(body, ['seed', 'temperature'])).toEqual({ model: 'm', image_config: { aspect_ratio: '2:3', image_size: '2K' } });
    expect(stripUnsupported(body, ['resolution'])).toEqual({ model: 'm', seed: 3, temperature: 1, image_config: { aspect_ratio: '2:3' } });
    expect(stripUnsupported({ imageConfig: { imageSize: '1K' } }, ['image_size'])).toEqual({});
    expect(body.seed).toBe(3); // input untouched
  });
});

describe('createImageGenerator — OpenRouter', () => {
  it('calls the Unified Image API with ordered references and attribution headers', async () => {
    const { generate, fetchMock, bodyOf, urlOf } = setup(OR, [imagesOk()]);
    const result = await generate(baseReq({ references: [ref('CHARACTER SHEET: MAYA'), ref('STYLE BOARD', 'data:image/webp;base64,UklGRg==')] }));
    expect(urlOf(0)).toMatch(/\/images$/);
    const body = bodyOf(0);
    expect(body).toEqual({
      model: 'google/gemini-nano-banana-2.1',
      prompt: 'Draw a comic page.',
      aspect_ratio: '2:3',
      resolution: '2K',
      n: 1,
      input_references: [
        { type: 'image_url', image_url: { url: PNG } },
        { type: 'image_url', image_url: { url: 'data:image/webp;base64,UklGRg==' } }
      ]
    });
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-or-platform');
    expect(headers['HTTP-Referer']).toBeTruthy();
    expect(headers['X-Title']).toBeTruthy();
    expect(result).toMatchObject({
      dataUrl: 'data:image/webp;base64,QUJD',
      model: 'google/gemini-nano-banana-2.1',
      route: 'openrouter',
      byok: false,
      costUsd: 0.0504
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('omits resolution for fixed-size models', async () => {
    const { generate, bodyOf } = setup(OR, [imagesOk()]);
    await generate(baseReq({ spec: GPT, resolution: '2K' }));
    expect(bodyOf(0).resolution).toBeUndefined();
    expect(bodyOf(0).model).toBe('openai/gpt-image-2.5-sunburst');
  });

  it('falls back once to chat completions when /images is unavailable, and remembers it', async () => {
    const { generate, bodyOf, urlOf } = setup(OR, [json({ error: { message: 'Not Found' } }, 404), chatOk(), chatOk()]);
    const result = await generate(baseReq({ aspect: '3:2', resolution: '1K', references: [ref('PREVIOUS PAGE')] }));
    expect(urlOf(1)).toMatch(/\/chat\/completions$/);
    expect(bodyOf(1)).toMatchObject({
      model: 'google/gemini-nano-banana-2.1',
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: '3:2', image_size: '1K' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Draw a comic page.' }, { type: 'image_url', image_url: { url: PNG } }] }]
    });
    expect(result.dataUrl).toBe('data:image/png;base64,WFla');
    expect(result.text).toBe('Here you go');
    expect(result.costUsd).toBe(0.051);
    // Second call goes straight to chat.
    await generate(baseReq());
    expect(urlOf(2)).toMatch(/\/chat\/completions$/);
  });

  it('downloads hosted image URLs into data URLs', async () => {
    const png = new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });
    const { generate } = setup(OR, [json({ data: [{ url: 'https://img.example.com/x.png' }] }), png]);
    const result = await generate(baseReq());
    expect(result.dataUrl).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
  });

  it('retries once on 429 (honouring Retry-After within bounds), then succeeds', async () => {
    const { generate, sleep, fetchMock } = setup(OR, [json({ error: { message: 'rate limited' } }, 429, { 'retry-after': '7' }), imagesOk()]);
    const result = await generate(baseReq());
    expect(result.dataUrl).toContain('QUJD');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7000, undefined);
  });

  it('gives up after one retry with RATE_LIMIT', async () => {
    const { generate, fetchMock } = setup(OR, [json({}, 429), json({}, 429)]);
    await expect(generate(baseReq())).rejects.toMatchObject({ code: 'RATE_LIMIT', retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on 5xx and network errors', async () => {
    const a = setup(OR, [json({ error: { message: 'upstream' } }, 502), imagesOk()]);
    await expect(a.generate(baseReq())).resolves.toMatchObject({ costUsd: 0.0504 });
    const b = setup(OR, [new TypeError('fetch failed'), new TypeError('fetch failed')]);
    await expect(b.generate(baseReq())).rejects.toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    expect(b.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('nudges once when the model answers with text only, summing the cost', async () => {
    const textOnly = json({ choices: [{ message: { content: 'Sure! I will draw it.' } }], usage: { cost: 0.001 } });
    const { generate, bodyOf } = setup(OR, [json({}, 405), textOnly, chatOk()]);
    const result = await generate(baseReq());
    expect(bodyOf(2).messages[0].content[0].text).toBe('Draw a comic page.\n\nGenerate the image now.');
    expect(result.costUsd).toBeCloseTo(0.052, 6);
  });

  it('reports NO_IMAGE (with what was spent) after the nudge also fails', async () => {
    const textOnly = () => Promise.resolve(json({ choices: [{ message: { content: 'Hmm.' } }], usage: { cost: 0.002 } }));
    const { generate } = setup(OR, [json({}, 404), textOnly, textOnly]);
    const err = await generate(baseReq()).catch((e) => e);
    expect(err.code).toBe('NO_IMAGE');
    expect(err.spentUsd).toBeCloseTo(0.004, 6);
  });

  it('treats a repeated written refusal as SAFETY_BLOCKED', async () => {
    const refusal = () => Promise.resolve(json({ choices: [{ message: { content: "I can't create images that violate the safety policy." } }] }));
    const { generate } = setup(OR, [json({}, 404), refusal, refusal]);
    await expect(generate(baseReq())).rejects.toMatchObject({ code: 'SAFETY_BLOCKED', retryable: false });
  });

  it('stops immediately on a structured safety finish reason', async () => {
    const blocked = json({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] });
    const { generate, fetchMock } = setup(OR, [json({}, 404), blocked]);
    await expect(generate(baseReq())).rejects.toMatchObject({ code: 'SAFETY_BLOCKED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps a 400 content-policy rejection to SAFETY_BLOCKED without retry', async () => {
    const { generate, fetchMock } = setup(OR, [json({ error: { message: 'Request was flagged by moderation (content policy)' } }, 400)]);
    await expect(generate(baseReq())).rejects.toMatchObject({ code: 'SAFETY_BLOCKED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('trips the shared-key circuit on a platform capacity error, never on BYOK', async () => {
    const a = setup(OR, [json({ error: { message: 'Key limit exceeded (total limit)' } }, 403)]);
    const err = await a.generate(baseReq()).catch((e) => e);
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.userMessage).toMatch(/shared image service/);
    expect(isSharedKeyCapped()).toBe(true);

    __resetSharedKeyCircuit();
    const b = setup(OR_BYOK, [json({ error: { message: 'Insufficient credits' } }, 402)]);
    const byokErr = await b.generate(baseReq()).catch((e) => e);
    expect(byokErr.userMessage).toMatch(/Your OpenRouter key is out of credits/);
    expect(isSharedKeyCapped()).toBe(false);
  });

  it('treats a 403 moderation rejection as SAFETY_BLOCKED and never trips the shared-key circuit', async () => {
    const body = {
      error: {
        code: 403,
        message:
          'openai/gpt-image-2.5-sunburst requires moderation on OpenAI. Your input was flagged for "violence". No credits were charged.',
        metadata: { reasons: ['violence'], flagged_input: '...', provider_name: 'OpenAI', model_slug: 'openai/gpt-image-2.5-sunburst' }
      }
    };
    const { generate, fetchMock } = setup(OR, [json(body, 403)]);
    await expect(generate(baseReq({ spec: GPT }))).rejects.toMatchObject({ code: 'SAFETY_BLOCKED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isSharedKeyCapped()).toBe(false);
  });

  it('times out at spec.timeoutMs with an honest TIMEOUT (no retry)', async () => {
    const spec: ImageModelSpec = { ...NB21, timeoutMs: 20 };
    const hang = () => new Promise<Response>(() => undefined);
    const { generate, fetchMock } = setup(OR, [hang, hang]);
    const err = await generate(baseReq({ spec })).catch((e) => e);
    expect(err.code).toBe('TIMEOUT');
    expect(err.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels promptly when the caller aborts', async () => {
    const controller = new AbortController();
    const hang = () => new Promise<Response>(() => undefined);
    const { generate } = setup(OR, [hang]);
    const pending = generate(baseReq({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('createImageGenerator — Gemini direct', () => {
  const geminiImage = (over: Record<string, unknown> = {}) => ({
    candidates: [
      {
        finishReason: 'STOP',
        content: { parts: [{ text: 'Page done.' }, { inlineData: { mimeType: 'image/png', data: 'R0VN' } }] }
      }
    ],
    ...over
  });

  it('interleaves labels with references and sends imageConfig', async () => {
    const generateContent = vi.fn(async (_params: Record<string, unknown>) => geminiImage());
    const { generate } = setup(GEM, [], { generateContent });
    const result = await generate(
      baseReq({ spec: PRO, aspect: '2:3', resolution: '2K', references: [ref('CHARACTER SHEET: MAYA'), ref('STYLE BOARD', 'data:image/webp;base64,UklGRg==')] })
    );
    const params = generateContent.mock.calls[0][0] as any;
    expect(params.model).toBe('gemini-3-pro-image');
    expect(params.contents[0].parts).toEqual([
      { text: 'Draw a comic page.' },
      { text: 'Image 1: CHARACTER SHEET: MAYA' },
      { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
      { text: 'Image 2: STYLE BOARD' },
      { inlineData: { mimeType: 'image/webp', data: 'UklGRg==' } }
    ]);
    expect(params.config.responseModalities).toEqual(['IMAGE', 'TEXT']);
    expect(params.config.imageConfig).toEqual({ aspectRatio: '2:3', imageSize: '2K' });
    expect(params.config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({
      dataUrl: 'data:image/png;base64,R0VN',
      route: 'gemini',
      byok: true,
      model: 'gemini-3-pro-image',
      text: 'Page done.'
    });
    expect(result.costUsd).toBeUndefined();
  });

  it('omits imageSize for models without a resolution parameter', async () => {
    const generateContent = vi.fn(async (_params: Record<string, unknown>) => geminiImage());
    const { generate } = setup(GEM, [], { generateContent });
    await generate(baseReq({ spec: LEGACY, resolution: '2K', aspect: '2:3' }));
    expect((generateContent.mock.calls[0][0] as any).config.imageConfig).toEqual({ aspectRatio: '2:3' });
  });

  it('maps IMAGE_SAFETY and prompt blocks to SAFETY_BLOCKED without retrying', async () => {
    const generateContent = vi.fn(async () => ({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] }));
    const { generate } = setup(GEM, [], { generateContent });
    await expect(generate(baseReq())).rejects.toMatchObject({ code: 'SAFETY_BLOCKED' });
    expect(generateContent).toHaveBeenCalledTimes(1);

    const blocked = vi.fn(async () => ({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }));
    const b = setup(GEM, [], { generateContent: blocked });
    await expect(b.generate(baseReq())).rejects.toMatchObject({ code: 'SAFETY_BLOCKED' });
  });

  it('nudges once on a text-only answer, keeping imageConfig', async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValueOnce({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'I will draw it.' }] } }] })
      .mockResolvedValueOnce(geminiImage());
    const { generate } = setup(GEM, [], { generateContent });
    await generate(baseReq());
    const second = generateContent.mock.calls[1][0] as any;
    expect(second.contents[0].parts[0].text).toBe('Draw a comic page.\n\nGenerate the image now.');
    expect(second.config.imageConfig).toEqual({ aspectRatio: '2:3', imageSize: '2K' });
  });

  it('retries a 429 from the SDK once, and never drops imageConfig on INVALID_ARGUMENT', async () => {
    const rate = Object.assign(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'), { status: 429 });
    const generateContent = vi.fn().mockRejectedValueOnce(rate).mockResolvedValueOnce(geminiImage());
    const { generate } = setup(GEM, [], { generateContent });
    await expect(generate(baseReq())).resolves.toMatchObject({ route: 'gemini' });

    const invalid = Object.assign(new Error('INVALID_ARGUMENT: imageSize'), { status: 400 });
    const failing = vi.fn().mockRejectedValue(invalid);
    const b = setup(GEM, [], { generateContent: failing });
    await expect(b.generate(baseReq())).rejects.toMatchObject({ code: 'PROVIDER_ERROR', retryable: false });
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('reports a billing error (no retry, no wait) when a Gemini image model has no free-tier quota', async () => {
    const quota = Object.assign(
      new Error(
        '{"error":{"code":429,"message":"Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-flash-image","status":"RESOURCE_EXHAUSTED"}}'
      ),
      { status: 429 }
    );
    const generateContent = vi.fn().mockRejectedValue(quota);
    const { generate, sleep } = setup(GEM, [], { generateContent });
    const err = await generate(baseReq()).catch((e) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_ERROR', retryable: false });
    expect(err.userMessage).toMatch(/billing/i);
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('maps an invalid Gemini key', async () => {
    const generateContent = vi.fn().mockRejectedValue(Object.assign(new Error('API key not valid. Please pass a valid API key.'), { status: 400 }));
    const { generate } = setup(GEM, [], { generateContent });
    await expect(generate(baseReq())).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      userMessage: 'Your Gemini key was rejected. Check it in Settings → API keys.'
    });
  });

  it('requires inline data for references', async () => {
    const { generate } = setup(GEM, [], { generateContent: vi.fn(async () => geminiImage()) });
    await expect(generate(baseReq({ references: [ref('X', 'https://example.com/x.png')] }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('createImageGenerator — same-model route fallback and shared cooldown', () => {
  const BOTH_BYOK: StudioKeys = { ...OR_BYOK, ...GEM };
  const geminiImage = () => ({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'R0VN' } }] }, finishReason: 'STOP' }],
    modelVersion: 'gemini-nano-banana-2.1'
  });

  it('only pairs routes with the same payer and the same model', () => {
    const primary = pickImageRoute(NB21, BOTH_BYOK);
    expect(primary.route).toBe('openrouter');
    expect(pickAlternateRoute(NB21, BOTH_BYOK, primary)).toMatchObject({ route: 'gemini', model: 'gemini-nano-banana-2.1', key: GEM.gemini });
    // The user's own OpenRouter key never falls back onto a PLATFORM Gemini key (DreamStream would pay)…
    const platformGemini: StudioKeys = { ...OR_BYOK, gemini: { key: 'AIza-platform', byok: false } };
    expect(pickAlternateRoute(NB21, platformGemini, pickImageRoute(NB21, platformGemini))).toBeNull();
    // …and a model with no Gemini route has nowhere to go.
    expect(pickAlternateRoute(GPT, BOTH_BYOK, pickImageRoute(GPT, BOTH_BYOK))).toBeNull();
  });

  it('draws the same model through the user\'s Gemini key when their OpenRouter route stays rate-limited', async () => {
    const generateContent = vi.fn().mockResolvedValue(geminiImage());
    const { generate, fetchMock } = setup(BOTH_BYOK, [json({ error: { message: 'Provider returned error' } }, 429), json({}, 429)], {
      generateContent
    });
    const result = await generate(baseReq());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0][0]).toMatchObject({ model: 'gemini-nano-banana-2.1' });
    expect(result).toMatchObject({ route: 'gemini', byok: true, dataUrl: 'data:image/png;base64,R0VN' });
  });

  it('falls back on a provider outage too, but never on a safety block or a rejected key', async () => {
    const generateContent = vi.fn().mockResolvedValue(geminiImage());
    const outage = setup(BOTH_BYOK, [json({}, 503), json({}, 503)], { generateContent });
    await expect(outage.generate(baseReq())).resolves.toMatchObject({ route: 'gemini' });

    const blocked = vi.fn().mockResolvedValue(geminiImage());
    const safety = setup(BOTH_BYOK, [json({ error: { message: 'flagged for content policy' } }, 403)], { generateContent: blocked });
    await expect(safety.generate(baseReq())).rejects.toMatchObject({ code: 'SAFETY_BLOCKED' });
    const badKey = setup(BOTH_BYOK, [json({ error: { message: 'No auth credentials found' } }, 401)], { generateContent: blocked });
    await expect(badKey.generate(baseReq())).rejects.toMatchObject({ code: 'PROVIDER_ERROR', retryable: false });
    expect(blocked).not.toHaveBeenCalled();
  });

  it('reports the preferred route\'s error when the fallback fails as well', async () => {
    const unbilled = Object.assign(new Error('RESOURCE_EXHAUSTED free_tier_requests, limit: 0'), { status: 429 });
    const generateContent = vi.fn().mockRejectedValue(unbilled);
    const { generate } = setup(BOTH_BYOK, [json({}, 429), json({}, 429)], { generateContent });
    await expect(generate(baseReq())).rejects.toMatchObject({ code: 'RATE_LIMIT', retryable: true });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('reads OpenRouter\'s error metadata (object raw, provider, BYOK flag) end to end', async () => {
    const body = {
      error: {
        code: 429,
        message: 'Provider returned error',
        metadata: { raw: { error: { message: 'google/gemini-nano-banana-2.1 is temporarily rate-limited upstream.' } }, provider_name: 'Google AI Studio', is_byok: false }
      }
    };
    const { generate } = setup(OR_BYOK, [json(body, 429), json(body, 429)]);
    const err = await generate(baseReq()).catch((e) => e);
    expect(err).toMatchObject({ code: 'RATE_LIMIT' });
    expect(err.userMessage).toMatch(/^Nano Banana 2\.1 is being throttled by its provider \(Google AI Studio\)/);
    expect(err.userMessage).toMatch(/OpenRouter said: .*temporarily rate-limited upstream/);
  });

  it('makes the next call on the same route+model+key wait out a 429 instead of piling on', async () => {
    let clock = 1_000_000;
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '9' }))
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '9' }))
      .mockResolvedValueOnce(imagesOk());
    const sleep = vi.fn(async () => undefined);
    const generate = createImageGenerator(OR, { fetch: fetchMock as unknown as typeof fetch, sleep, now: () => clock });
    await expect(generate(baseReq())).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    sleep.mockClear();
    clock += 2000;
    await expect(generate(baseReq())).resolves.toMatchObject({ dataUrl: expect.stringContaining('QUJD') });
    // Waited the rest of the provider's 9 s before sending anything.
    expect(sleep).toHaveBeenCalledWith(7000, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not make other keys wait for someone else\'s 429', async () => {
    const clock = 5_000_000;
    const sleep = vi.fn(async () => undefined);
    const limited = createImageGenerator(OR, {
      fetch: vi.fn(async () => json({}, 429, { 'retry-after': '9' })) as unknown as typeof fetch,
      sleep,
      now: () => clock
    });
    await expect(limited(baseReq())).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    sleep.mockClear();
    const other = createImageGenerator(OR_BYOK, { fetch: vi.fn(async () => imagesOk()) as unknown as typeof fetch, sleep, now: () => clock });
    await expect(other(baseReq())).resolves.toMatchObject({ byok: true });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('classifyImageError / looksLikeRefusal', () => {
  it('shows what the provider said on a rate limit, without keys or JSON noise', () => {
    const raw =
      'OpenRouter /images 429: Provider returned error — {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota). key=sk-or-v1-abcdef0123456789","status":"RESOURCE_EXHAUSTED"}}';
    const err = classifyImageError(Object.assign(new Error(raw), { status: 429 }), { route: 'openrouter', byok: true });
    expect(err.code).toBe('RATE_LIMIT');
    expect(err.userMessage).toBe(
      'The image model is busy right now (rate limited). Wait a minute and try again. (OpenRouter said: Resource has been exhausted (e.g. check quota). key=….)'
    );
    expect(err.userMessage).not.toMatch(/sk-or|abcdef0123456789/);
  });

  it('says who refused a 429: the upstream provider, the user\'s OpenRouter-integration key, or OpenRouter itself', () => {
    const ctx = { route: 'openrouter' as const, byok: true, model: 'Nano Banana 2.1' };
    const upstream = Object.assign(new Error('OpenRouter /images 429: Provider returned error'), {
      status: 429,
      meta: { providerName: 'Google AI Studio', isByok: false }
    });
    expect(classifyImageError(upstream, ctx).userMessage).toMatch(
      /^Nano Banana 2\.1 is being throttled by its provider \(Google AI Studio\) for everyone on OpenRouter right now — your key and limits are fine\./
    );
    const integration = Object.assign(new Error('OpenRouter /images 429: Provider returned error'), { status: 429, meta: { isByok: true } });
    expect(classifyImageError(integration, ctx).userMessage).toMatch(/Google key in your OpenRouter Integrations/);
    const platform = Object.assign(new Error('OpenRouter /images 429: Rate limit exceeded'), { status: 429 });
    expect(classifyImageError(platform, ctx).userMessage).toMatch(/^The image model is busy right now \(rate limited\)/);
    // Every variant is still a retryable RATE_LIMIT.
    for (const e of [upstream, integration, platform]) expect(classifyImageError(e, ctx)).toMatchObject({ code: 'RATE_LIMIT', retryable: true });
  });

  it('adds no detail when the provider said nothing useful, and keeps long plain words', () => {
    expect(classifyImageError(Object.assign(new Error('OpenRouter /images 429: rate limited'), { status: 429 }), { route: 'openrouter', byok: true }).userMessage).toBe(
      'The image model is busy right now (rate limited). Wait a minute and try again.'
    );
    expect(providerDetail('Quota exceeded for metric generate_content_free_tier_requests, limit: 50')).toBe(
      'Quota exceeded for metric generate_content_free_tier_requests, limit: 50'
    );
    expect(providerDetail('token 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc rejected')).toBe('token … rejected');
    expect(providerDetail('x'.repeat(400)).length).toBeLessThanOrEqual(180);
  });

  it('explains a "limit: 0" quota error that comes back through OpenRouter (BYOK Google key, no billing)', () => {
    const err = Object.assign(new Error('OpenRouter /images 429: Provider returned error — RESOURCE_EXHAUSTED free_tier_requests, limit: 0'), { status: 429 });
    const mine = classifyImageError(err, { route: 'openrouter', byok: true });
    expect(mine).toMatchObject({ code: 'PROVIDER_ERROR', retryable: false });
    expect(mine.userMessage).toMatch(/OpenRouter integrations/);
    expect(classifyImageError(err, { route: 'openrouter', byok: false }).userMessage).toMatch(/shared image service/);
  });

  it('classifies statuses', () => {
    const ctx = { route: 'openrouter' as const, byok: false };
    expect(classifyImageError({ status: 404, message: 'no such model' }, ctx).userMessage).toMatch(/isn't available/);
    expect(classifyImageError({ status: 504, message: 'gateway' }, ctx).code).toBe('TIMEOUT');
    expect(classifyImageError({ name: 'AbortError', message: 'aborted' }, ctx).code).toBe('CANCELLED');
    expect(classifyImageError({ status: 401, message: 'No auth credentials found' }, ctx).retryable).toBe(false);
  });

  it('recognises refusals but not ordinary chatter', () => {
    expect(looksLikeRefusal("I'm unable to generate that because it violates our content policy")).toBe(true);
    expect(looksLikeRefusal('Here is the page you asked for.')).toBe(false);
  });
});
