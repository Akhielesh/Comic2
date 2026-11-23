import { expect, it, vi } from 'vitest';
import { extendForStudioWork } from './studioActivity';

it('only extends a genuinely busy container, for at most three idle windows', async () => {
  const probe = vi.fn(async () => new Response(null, { status: 204 }));
  expect(await extendForStudioWork(0, probe)).toBe(true);
  expect(await extendForStudioWork(2, probe)).toBe(true);
  expect(await extendForStudioWork(3, probe)).toBe(false);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(await extendForStudioWork(1, async () => new Response(null, { status: 200 }))).toBe(false);
  expect(await extendForStudioWork(1, async () => { throw new Error('unreachable'); })).toBe(false);
});
