// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { TtlCache } from './cache.js';

it.each(['clear', 'delete'] as const)('a stale account credential load cannot reappear after %s', async mode => {
  const cache = new TtlCache<string>();
  let finishOld!: (value: string) => void;
  let finishNew!: (value: string) => void;
  const old = cache.getOrSet('owner', () => new Promise(resolve => { finishOld = resolve; }));
  await Promise.resolve();
  if (mode === 'delete') cache.delete('owner');
  else cache.clear();
  const fresh = cache.getOrSet('owner', () => new Promise(resolve => { finishNew = resolve; }));
  await Promise.resolve();
  finishOld('previous');
  await old;
  expect(cache.get('owner')).toBeUndefined();
  const duplicate = vi.fn(async () => 'wrong');
  const join = cache.getOrSet('owner', duplicate);
  finishNew('replacement');
  expect(await fresh).toBe('replacement');
  expect(await join).toBe('replacement');
  expect(duplicate).not.toHaveBeenCalled();
  expect(cache.get('owner')).toBe('replacement');
});
