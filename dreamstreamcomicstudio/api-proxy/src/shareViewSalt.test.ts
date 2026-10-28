import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetShareViewSaltCache, resolveShareViewSalt, withShareViewSalt } from './shareViewSalt';

const SALT = 'a'.repeat(40);
const fakeDb = (rows: { value?: unknown }[] | Error) => {
  const all = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return { results: rows };
  });
  return { db: { prepare: vi.fn(() => ({ all })) }, all };
};

describe('SHARE_VIEW_SALT resolution', () => {
  beforeEach(() => resetShareViewSaltCache());

  it('a usable Worker secret wins and D1 is never read', async () => {
    const { db, all } = fakeDb([{ value: 'b'.repeat(40) }]);
    expect(await resolveShareViewSalt({ SHARE_VIEW_SALT: SALT, BACKEND_ENV: db })).toBe(SALT);
    expect(all).not.toHaveBeenCalled();
  });

  it('falls back to the D1 backend_env row and caches it for 5 minutes', async () => {
    const { db, all } = fakeDb([{ value: SALT }]);
    expect(await resolveShareViewSalt({ BACKEND_ENV: db }, 1_000)).toBe(SALT);
    expect(await resolveShareViewSalt({ BACKEND_ENV: db }, 2_000)).toBe(SALT);
    expect(all).toHaveBeenCalledTimes(1);
    expect(await resolveShareViewSalt({ BACKEND_ENV: db }, 1_000 + 5 * 60_000 + 1)).toBe(SALT);
    expect(all).toHaveBeenCalledTimes(2);
  });

  it('a short or missing row, or a D1 error, means tracking stays off (undefined), and no throw escapes', async () => {
    expect(await resolveShareViewSalt({ BACKEND_ENV: fakeDb([{ value: 'short' }]).db })).toBeUndefined();
    resetShareViewSaltCache();
    expect(await resolveShareViewSalt({ BACKEND_ENV: fakeDb([]).db })).toBeUndefined();
    resetShareViewSaltCache();
    expect(await resolveShareViewSalt({ BACKEND_ENV: fakeDb(new Error('d1 down')).db })).toBeUndefined();
    expect(await resolveShareViewSalt({})).toBeUndefined();
  });

  it('withShareViewSalt returns the same env object when nothing changes, else a copy with the salt filled in', async () => {
    const env = { SHARE_VIEW_SALT: SALT, OTHER: 'x' };
    expect(await withShareViewSalt(env)).toBe(env);
    const { db } = fakeDb([{ value: SALT }]);
    const filled = await withShareViewSalt({ BACKEND_ENV: db, OTHER: 'x' });
    expect(filled.SHARE_VIEW_SALT).toBe(SALT);
    expect(filled.OTHER).toBe('x');
    resetShareViewSaltCache();
    const bare = { BACKEND_ENV: fakeDb([]).db };
    expect(await withShareViewSalt(bare)).toBe(bare);
  });
});
