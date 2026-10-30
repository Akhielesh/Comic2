// @vitest-environment node
//
// What a signed-out reader of a public classic comic may sign: what the comic shows to anyone (the reader's cover and
// panels, a card's style preview), never a character's reference photos, the cover template or a panel's older
// renders; force-private and v4 rows authorize nothing.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPublicReaderPathCache, loadPublicProjectStates, loadPublicReaderPaths, readerPathsOfState } from './publicReaderPaths.js';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const O3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A service-role client whose projects table answers select().eq().eq(), optionally without the moderation column. */
const fakeAdmin = (rows: Record<string, unknown>[], opts: { noModerationColumn?: boolean; fail?: boolean } = {}) => {
  const calls: string[] = [];
  const admin = {
    from: () => {
      let cols = '';
      const filters: [string, unknown][] = [];
      const q = {
        select: (c: string) => {
          cols = c;
          calls.push(c);
          return q;
        },
        eq: (col: string, v: unknown) => {
          filters.push([col, v]);
          return q;
        },
        then: (resolve: (r: { data: unknown; error: unknown }) => unknown) => {
          if (opts.fail) return Promise.resolve(resolve({ data: null, error: { code: 'XX000', message: 'down' } }));
          if (opts.noModerationColumn && cols.includes('is_forced_private')) return Promise.resolve(resolve({ data: null, error: { code: '42703' } }));
          const out = rows
            .filter((r) => filters.every(([c, v]) => r[c] === v))
            .map((r) => (cols.includes('is_forced_private') ? { state: r.state, is_forced_private: r.is_forced_private } : { state: r.state }));
          return Promise.resolve(resolve({ data: out, error: null }));
        }
      };
      return q;
    }
  };
  return { admin: admin as unknown as SupabaseClient, calls };
};

const classicState = {
  coverImageId: `${OWNER}/cover.png`,
  coverTemplateImageId: `${OWNER}/template.png`,
  panels: [
    { imageId: `${OWNER}/p1.png`, imageIdHistory: [`${OWNER}/p1-old.png`] },
    { imageId: `${OWNER}/p2` },
    { imageId: '' },
    {}
  ],
  characters: [{ imageId: `${OWNER}/hero.png`, referenceImageIds: [`${OWNER}/selfie.jpg`] }],
  items: [{ imageId: `${OWNER}/sword.png` }],
  styleVariants: [{ imageId: `${OWNER}/style.png` }],
  imageTags: { [`${OWNER}/tagged.png`]: ['x'] }
};

describe('readerPathsOfState', () => {
  it('is the cover, each panel image and the style previews: never history, references, the cover template, items or tags', () => {
    expect(readerPathsOfState(classicState)).toEqual([`${OWNER}/cover.png`, `${OWNER}/p1.png`, `${OWNER}/p2`, `${OWNER}/style.png`]);
  });

  it('a v4 listing state and malformed states authorize nothing', () => {
    expect(readerPathsOfState({ ...classicState, studioVersion: 4 })).toEqual([]);
    expect(readerPathsOfState(null)).toEqual([]);
    expect(readerPathsOfState('x')).toEqual([]);
    expect(readerPathsOfState({ panels: 'nope', coverImageId: 7 })).toEqual([]);
  });
});

describe('loadPublicReaderPaths', () => {
  const rows = [
    { user_id: OWNER, is_public: true, is_forced_private: false, state: classicState },
    { user_id: OWNER, is_public: true, is_forced_private: true, state: { coverImageId: `${OWNER}/moderated.png` } },
    { user_id: OWNER, is_public: false, is_forced_private: false, state: { coverImageId: `${OWNER}/draft.png` } },
    { user_id: OTHER, is_public: true, is_forced_private: false, state: { coverImageId: `${OTHER}/theirs.png` } }
  ];

  it("collects the owner's public, not force-private comics only", async () => {
    const { admin } = fakeAdmin(rows);
    const paths = await loadPublicReaderPaths(admin, OWNER);
    expect(paths.has(`${OWNER}/cover.png`)).toBe(true);
    expect(paths.has(`${OWNER}/p1.png`)).toBe(true);
    expect(paths.has(`${OWNER}/moderated.png`)).toBe(false);
    expect(paths.has(`${OWNER}/draft.png`)).toBe(false);
    expect(paths.has(`${OTHER}/theirs.png`)).toBe(false);
    expect(paths.has(`${OWNER}/selfie.jpg`)).toBe(false);
    expect(paths.has(`${OWNER}/template.png`)).toBe(false);
  });

  it('tolerates a database without the moderation column', async () => {
    const { admin, calls } = fakeAdmin(rows, { noModerationColumn: true });
    expect(await loadPublicProjectStates(admin, OWNER)).toHaveLength(2);
    expect(calls).toEqual(['state, is_forced_private', 'state']);
  });

  it('throws on any other error (the route answers 500, never "allowed")', async () => {
    const { admin } = fakeAdmin(rows, { fail: true });
    await expect(loadPublicReaderPaths(admin, OWNER)).rejects.toMatchObject({ code: 'XX000' });
  });
});

describe('createPublicReaderPathCache', () => {
  const set = (...paths: string[]) => new Set(paths);

  it('matches the stored path, the extension the client adds to an id stored without one, and the tmp-lane twin', async () => {
    const cache = createPublicReaderPathCache(async () => set(`${OWNER}/p1.png`, `${OWNER}/p2`));
    expect(await cache.shows(OWNER, `${OWNER}/p1.png`)).toBe(true);
    expect(await cache.shows(OWNER, `${OWNER}/p2.webp`)).toBe(true);
    expect(await cache.shows(OWNER, `u/${OWNER}/tmp/p1.png`)).toBe(true);
    expect(await cache.shows(OWNER, `u/${OWNER}/tmp/p2.png`)).toBe(true);
    expect(await cache.shows(OWNER, `${OWNER}/p1-old.png`)).toBe(false);
    // Another owner's tmp lane is never this owner's twin, nor a nested tmp path.
    expect(await cache.shows(OWNER, `u/${OTHER}/tmp/p1.png`)).toBe(false);
    expect(await cache.shows(OWNER, `u/${OWNER}/tmp/nested/p1.png`)).toBe(false);
  });

  it('never stacks or re-cases an extension: a stored "a.png" authorizes "a.png" only', async () => {
    const cache = createPublicReaderPathCache(async () => set(`${OWNER}/p1.png`, `${OWNER}/p2`));
    for (const path of [`${OWNER}/p1.png.png`, `${OWNER}/p1.png.jpeg`, `u/${OWNER}/tmp/p1.png.jpeg`, `${OWNER}/p2.PNG`, `${OWNER}/p2.png.webp`, `${OWNER}/p2.gif`]) {
      expect(await cache.shows(OWNER, path)).toBe(false);
    }
  });

  it('refuses an owner id not spelled as storage writes it, without a query', async () => {
    const load = vi.fn(async () => set(`${OWNER}/p1.png`));
    const cache = createPublicReaderPathCache(load);
    const upper = OWNER.toUpperCase();
    expect(await cache.shows(upper, `${upper}/p1.png`)).toBe(false);
    expect(await cache.shows('-'.repeat(36), `${'-'.repeat(36)}/p1.png`)).toBe(false);
    expect(await cache.shows('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/p1.png')).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('loads once per owner per TTL, shared by concurrent requests', async () => {
    let t = 0;
    const load = vi.fn(async (owner: string) => set(`${owner}/a.png`));
    const cache = createPublicReaderPathCache(load, { ttlMs: 1000, now: () => t });
    await Promise.all([cache.shows(OWNER, `${OWNER}/a.png`), cache.shows(OWNER, `${OWNER}/b.png`), cache.shows(OWNER, `${OWNER}/a.png`)]);
    expect(load).toHaveBeenCalledTimes(1);
    t = 999;
    await cache.shows(OWNER, `${OWNER}/a.png`);
    expect(load).toHaveBeenCalledTimes(1);
    t = 1000; // an unpublished comic stops authorizing once the TTL is up
    await cache.shows(OWNER, `${OWNER}/a.png`);
    expect(load).toHaveBeenCalledTimes(2);
    await cache.shows(OTHER, `${OTHER}/a.png`);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('never caches a failed load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(set(`${OWNER}/a.png`));
    const cache = createPublicReaderPathCache(load);
    await expect(cache.shows(OWNER, `${OWNER}/a.png`)).rejects.toThrow('down');
    expect(await cache.shows(OWNER, `${OWNER}/a.png`)).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps at most maxOwners owners, the least recently read leaving first', async () => {
    const load = vi.fn(async (owner: string) => set(`${owner}/a.png`));
    const cache = createPublicReaderPathCache(load, { maxOwners: 2 });
    await cache.shows(OWNER, `${OWNER}/a.png`);
    await cache.shows(OTHER, `${OTHER}/a.png`);
    await cache.shows(OWNER, `${OWNER}/a.png`); // read again: OTHER is now the least recent
    await cache.shows(O3, `${O3}/a.png`); // OTHER leaves
    expect(load).toHaveBeenCalledTimes(3);
    await cache.shows(OWNER, `${OWNER}/a.png`);
    expect(load).toHaveBeenCalledTimes(3);
    await cache.shows(OTHER, `${OTHER}/a.png`);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('clear() forgets every owner', async () => {
    const load = vi.fn(async () => set());
    const cache = createPublicReaderPathCache(load);
    await cache.shows(OWNER, `${OWNER}/x.png`);
    cache.clear();
    await cache.shows(OWNER, `${OWNER}/x.png`);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
