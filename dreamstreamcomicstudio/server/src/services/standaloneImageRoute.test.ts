// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDALONE_MODEL } from '../../../shared/standaloneImage.js';
import { reportImageRouteRefusal, rememberImageKeyValidation, selectStandaloneRoute } from './standaloneImageRoute.js';

const personal = (key: string) => ({ key, byok: true });
const keys = { gemini: personal('google-fake'), openrouter: personal('or-fake') };
afterEach(() => vi.unstubAllGlobals());

describe('read-only selection of an image route', () => {
  it('prefers an available personal Gemini key, probes alternatives concurrently and returns only public fields', async () => {
    const reached = new Set<string>();
    let done!: () => void;
    const barrier = new Promise<void>(r => { done = r; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      reached.add(new URL(url).hostname);
      if (reached.size === 2) done();
      await barrier;
      return Response.json({ data: { limit_remaining: null } });
    }));
    const result = await selectStandaloneRoute('owner-both', keys, STANDALONE_MODEL, false);
    expect(result).toEqual({ provider: 'gemini', payer: 'personal', model: STANDALONE_MODEL });
    expect(await selectStandaloneRoute('owner-both', keys, STANDALONE_MODEL, false)).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('switches between personal keys before spend when Google rejects the key; free-only requests need one-action consent', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('googleapis') ? new Response(null, { status: 403 }) : Response.json({ data: { limit_remaining: 3 } })));
    await expect(selectStandaloneRoute('owner-expired', keys, STANDALONE_MODEL, true)).rejects.toMatchObject({
      code: 'NO_FREE_MODEL_AVAILABLE', details: { payer: 'personal', provider: 'openrouter' }
    });
    expect((await selectStandaloneRoute('owner-expired', keys, STANDALONE_MODEL, false)).provider).toBe('openrouter');
  });

  it('does not try a known-exhausted personal credential, retire a replacement key, or spend on a different payer', async () => {
    rememberImageKeyValidation('owner-rotation', 'gemini', keys.gemini.key, 'invalid');
    const network = vi.fn(async (url: string) => Response.json({ data: { limit_remaining: url.includes('openrouter') ? 0 : null } }));
    vi.stubGlobal('fetch', network);
    await expect(selectStandaloneRoute('owner-rotation', keys, STANDALONE_MODEL, false)).rejects.toMatchObject({ status: 402, publicCode: 'IMAGE_KEY_EXHAUSTED' });
    expect(network).toHaveBeenCalledTimes(1);
    await expect(selectStandaloneRoute('owner-rotation', { gemini: keys.gemini, openrouter: { key: 'platform', byok: false } }, STANDALONE_MODEL, false))
      .rejects.toMatchObject({ status: 422, publicCode: 'IMAGE_KEY_INVALID' });
    expect(await selectStandaloneRoute('owner-rotation', { ...keys, gemini: personal('replacement') }, STANDALONE_MODEL, false))
      .toMatchObject({ provider: 'gemini', payer: 'personal' });
  });

  it.each([
    ['no spending capacity', 200, 0, 'IMAGE_KEY_EXHAUSTED', 402],
    ['credit exhaustion', 402, null, 'IMAGE_KEY_EXHAUSTED', 402],
    ['rejected credential', 401, null, 'IMAGE_KEY_INVALID', 422],
    ['temporary outage', 503, null, 'IMAGE_ROUTE_UNAVAILABLE', 503],
    ['provider throttle', 429, null, 'IMAGE_ROUTE_UNAVAILABLE', 503]
  ] as const)('distinguishes %s without a generation call', async (label, status, remaining, code, expectedStatus) => {
    const metadata = vi.fn(async () => status === 200 ? Response.json({data:{limit_remaining:remaining}}) : new Response(null, {status}));
    vi.stubGlobal('fetch', metadata);
    await expect(selectStandaloneRoute('owner-' + label, {openrouter:keys.openrouter}, STANDALONE_MODEL, true)).rejects.toMatchObject({status:expectedStatus, publicCode:code});
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledWith('https://openrouter.ai/api/v1/key', expect.objectContaining({redirect:'error'}));
  });

  it('distinguishes an inaccessible Gemini model from a confirmed invalid credential', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null,{status:404})));
    await expect(selectStandaloneRoute('owner-model-access', {gemini:keys.gemini}, STANDALONE_MODEL, false))
      .rejects.toMatchObject({status:422,publicCode:'IMAGE_MODEL_ACCESS_DENIED'});
  });

  it('suppresses only a refused owner, payer, model and credential tuple before expiry', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const deps = { readiness: vi.fn().mockResolvedValue('ready'), circuit: vi.fn().mockReturnValue({state:'ok'}) };
      const original = await selectStandaloneRoute('member-refusal', keys, STANDALONE_MODEL, false, deps);
      reportImageRouteRefusal('member-refusal', original, keys.gemini.key, 'exhausted');
      expect((await selectStandaloneRoute('member-refusal', keys, STANDALONE_MODEL, false, deps)).provider).toBe('openrouter');
      await expect(selectStandaloneRoute('member-refusal', keys, STANDALONE_MODEL, true, deps)).rejects.toMatchObject({code:'NO_FREE_MODEL_AVAILABLE',details:{payer:'personal'}});
      expect((await selectStandaloneRoute('other-refusal', keys, STANDALONE_MODEL, false, deps)).provider).toBe('gemini');
      expect((await selectStandaloneRoute('member-refusal', keys, 'gemini-nano-banana-2.1', false, deps)).provider).toBe('gemini');
      expect((await selectStandaloneRoute('member-refusal', {...keys,gemini:personal('replacement')}, STANDALONE_MODEL, false, deps)).provider).toBe('gemini');
      const platforms = {gemini:{key:keys.gemini.key,byok:false},openrouter:{key:'platform-router',byok:false}};
      const platform = await selectStandaloneRoute('member-refusal', platforms, STANDALONE_MODEL, false, deps);
      expect(platform).toMatchObject({provider:'gemini',payer:'platform'});
      reportImageRouteRefusal('member-refusal', platform, platforms.gemini.key, 'model_denied');
      expect(await selectStandaloneRoute('member-refusal', platforms, STANDALONE_MODEL, false, deps)).toMatchObject({provider:'openrouter',payer:'platform'});
      now.mockReturnValue(61_001);
      expect((await selectStandaloneRoute('member-refusal', keys, STANDALONE_MODEL, false, deps)).provider).toBe('gemini');
    } finally { now.mockRestore(); }
  });

  it('skips a model circuit known to be down and never checks one user’s platform key as a personal credential', async () => {
    const readiness = vi.fn().mockResolvedValue('ready');
    const circuit = vi.fn(provider => ({ state: provider === 'gemini' ? 'down' : 'ok' } as const));
    expect(await selectStandaloneRoute('owner-circuit', keys, STANDALONE_MODEL, false, { circuit, readiness })).toMatchObject({ provider: 'openrouter' });
    expect(readiness).toHaveBeenCalledTimes(1);
  });
});
