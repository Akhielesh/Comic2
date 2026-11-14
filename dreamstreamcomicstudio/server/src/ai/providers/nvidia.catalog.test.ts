// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { nvidiaProvider } from './nvidia.js';
afterEach(() => vi.unstubAllGlobals());
it('discovers public NVIDIA models without sending a key or asserting account callability', async () => {
  const fetcher = vi.fn(async () => Response.json({ data: [{ id: 'nvidia/test-model' }] }));
  vi.stubGlobal('fetch', fetcher);
  const models = await nvidiaProvider.listModels({ apiKey: 'private-key-must-not-be-sent', byok: true });
  expect(models).toHaveLength(1);
  expect(new Headers((fetcher.mock.calls[0] as any)[1].headers).has('authorization')).toBe(false);
  expect(models[0].pricingKnown).toBe(false);
  expect(models[0].isFree).toBe(false);
  expect(models[0].costClass).not.toBe('free_verified');
  expect('apiCallable' in models[0]).toBe(false);
  await expect(nvidiaProvider.listModels()).resolves.toHaveLength(1);
});
