// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDALONE_MODEL } from '../../../shared/standaloneImage.js';
import { rememberImageKeyValidation, selectStandaloneRoute } from './standaloneImageRoute.js';

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
    await expect(selectStandaloneRoute('owner-rotation', keys, STANDALONE_MODEL, false)).rejects.toMatchObject({ status: 422 });
    expect(network).toHaveBeenCalledTimes(1);
    await expect(selectStandaloneRoute('owner-rotation', { gemini: keys.gemini, openrouter: { key: 'platform', byok: false } }, STANDALONE_MODEL, false))
      .rejects.toMatchObject({ status: 422 });
    expect(await selectStandaloneRoute('owner-rotation', { ...keys, gemini: personal('replacement') }, STANDALONE_MODEL, false))
      .toMatchObject({ provider: 'gemini', payer: 'personal' });
  });

  it('skips a model circuit known to be down and never checks one user’s platform key as a personal credential', async () => {
    const readiness = vi.fn().mockResolvedValue('ready');
    const circuit = vi.fn(provider => ({ state: provider === 'gemini' ? 'down' : 'ok' } as const));
    expect(await selectStandaloneRoute('owner-circuit', keys, STANDALONE_MODEL, false, { circuit, readiness })).toMatchObject({ provider: 'openrouter' });
    expect(readiness).toHaveBeenCalledTimes(1);
  });
});
