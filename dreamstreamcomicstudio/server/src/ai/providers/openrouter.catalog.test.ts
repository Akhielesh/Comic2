// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRouterProvider } from './openrouter.js';

afterEach(() => vi.unstubAllGlobals());
describe('OpenRouter catalog price provenance', () => {
  it('keeps missing and malformed quotes unknown instead of free', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: 'maker/missing' },
      { id: 'maker/malformed', pricing: { prompt: '0', completion: 'unavailable' } },
      { id: 'maker/known', pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: 'maker/free:free' }
    ] }))));
    const [missing, malformed, known, free] = await openRouterProvider.listModels();
    expect(missing).toMatchObject({ pricingKnown: false, pricingOrigin: 'unknown', isFree: false });
    expect(malformed).toMatchObject({ pricingKnown: false, pricingOrigin: 'unknown', isFree: false });
    expect(known).toMatchObject({ pricingKnown: true, pricingOrigin: 'provider', isFree: false });
    expect(free).toMatchObject({ pricingKnown: true, pricingOrigin: 'provider', isFree: true });
  });
});
