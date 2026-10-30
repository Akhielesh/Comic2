// @vitest-environment node
//
// What the image proxy signs a signed-out reader of a public classic comic: what the comic shows to anyone (the
// reader's cover, panels and Page Studio pages, a card's style preview), never a character's reference photos, the
// cover template, item or location art or a panel's older renders; force-private and v4 rows authorize nothing.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MAX_PATHS_PER_OWNER,
  MAX_PATH_LENGTH,
  PUBLIC_READER_CACHE_DEFAULTS,
  createPublicReaderPathCache,
  loadPublicProjectStates,
  loadPublicReaderPaths,
  readerPathsOfState,
  showsIn,
  shownPathsOf
} from './publicReaderPaths.js';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const O3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A service-role client whose projects table answers select().eq().eq(), optionally without the moderation column. */
const fakeAdmin = (
  rows: Record<string, unknown>[],
  opts: { noModerationColumn?: boolean; fail?: boolean; failFirst?: string; failFallback?: boolean } = {}
) => {
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
          if (opts.failFirst && cols.includes('is_forced_private')) return Promise.resolve(resolve({ data: null, error: { code: opts.failFirst } }));
          if (opts.failFallback && !cols.includes('is_forced_private')) return Promise.resolve(resolve({ data: null, error: { code: 'XX001' } }));
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
  locations: [{ imageId: `${OWNER}/castle.png`, referenceImageIds: [`${OWNER}/place.jpg`] }],
  styleVariants: [{ imageId: `${OWNER}/style.png` }],
  pageStudio: {
    pages: [{ imageId: `${OWNER}/page1.png`, baseImageId: `${OWNER}/page1-base.png`, edits: [{ id: 'e1', imageId: `${OWNER}/page1-edit1.png` }] }, { edits: [] }]
  },
  imageTags: { [`${OWNER}/tagged.png`]: ['x'] }
};

describe('readerPathsOfState', () => {
  it('is the cover, panels, Page Studio pages and style previews: never history, base pages, page edits, references, the cover template, items, locations or tags', () => {
    expect(readerPathsOfState(classicState)).toEqual([`${OWNER}/cover.png`, `${OWNER}/p1.png`, `${OWNER}/p2`, `${OWNER}/page1.png`, `${OWNER}/style.png`]);
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

  it('rethrows any other error on the first query: never falls back to the query that cannot see moderation', async () => {
    const { admin, calls } = fakeAdmin(rows, { failFirst: '57014' });
    await expect(loadPublicProjectStates(admin, OWNER)).rejects.toMatchObject({ code: '57014' });
    expect(calls).toEqual(['state, is_forced_private']);
  });

  it('rethrows when the fallback query fails too', async () => {
    const { admin } = fakeAdmin(rows, { failFirst: '42703', failFallback: true });
    await expect(loadPublicReaderPaths(admin, OWNER)).rejects.toMatchObject({ code: 'XX001' });
  });

  it("keeps only the owner's legacy and tmp-lane ids (the only ones this check is asked about), of bounded length", async () => {
    const atLimit = `${OWNER}/${'x'.repeat(MAX_PATH_LENGTH - OWNER.length - 5)}.png`;
    const overLimit = `${OWNER}/${'x'.repeat(MAX_PATH_LENGTH - OWNER.length - 4)}.png`;
    expect(atLimit).toHaveLength(MAX_PATH_LENGTH);
    expect(overLimit).toHaveLength(MAX_PATH_LENGTH + 1);
    const { admin } = fakeAdmin([
      {
        user_id: OWNER,
        is_public: true,
        is_forced_private: false,
        state: {
          coverImageId: `${OTHER}/foreign.png`,
          panels: [
            { imageId: atLimit },
            { imageId: overLimit },
            { imageId: `u/${OWNER}/tmp/t.webp` },
            { imageId: `u/${OWNER}/p/${O3}/img/a.webp` },
            { imageId: `${OWNER}/nested/a.png` },
            { imageId: `x/${OWNER}/a.png` },
            { imageId: 'library/shared.webp' }
          ]
        }
      }
    ]);
    const paths = await loadPublicReaderPaths(admin, OWNER);
    expect([...paths].sort()).toEqual([atLimit, `u/${OWNER}/tmp/t.webp`].sort());
  });

  it('caps the kept ids per owner, counting only ids this check can be asked about', () => {
    const scoped = Array.from({ length: MAX_PATHS_PER_OWNER + 10 }, (_, i) => ({ imageId: `u/${OWNER}/p/${O3}/img/s${i}.webp` }));
    const legacyComic = { panels: [{ imageId: `${OWNER}/old.png` }] };
    // Thousands of project-scoped ids first never crowd out an older comic's legacy art.
    expect(shownPathsOf([{ panels: scoped }, legacyComic], OWNER).has(`${OWNER}/old.png`)).toBe(true);
    const many = Array.from({ length: MAX_PATHS_PER_OWNER + 50 }, (_, i) => ({ imageId: `${OWNER}/m${i}.png` }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const capped = shownPathsOf([{ panels: [...many, ...many] }], OWNER);
    expect(capped.size).toBe(MAX_PATHS_PER_OWNER);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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
    // Another owner's tmp lane is never this owner's twin.
    expect(await cache.shows(OWNER, `u/${OTHER}/tmp/p1.png`)).toBe(false);
  });

  it('a nested tmp path is never a legacy twin, even when that nested legacy-looking id is shown', async () => {
    const cache = createPublicReaderPathCache(async () => set(`${OWNER}/nested/p1.png`));
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

  it('a miss on an answer older than refreshAfterMs reloads once, so a comic published a moment ago is shown', async () => {
    let t = 0;
    let published = false;
    const load = vi.fn(async () => (published ? set(`${OWNER}/new.png`) : set(`${OWNER}/old.png`)));
    const cache = createPublicReaderPathCache(load, { ttlMs: 60_000, refreshAfterMs: 5_000, now: () => t });
    expect(await cache.shows(OWNER, `${OWNER}/old.png`)).toBe(true);
    published = true;
    t = 4_999; // too fresh to reload: a miss is final
    expect(await cache.shows(OWNER, `${OWNER}/new.png`)).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    t = 5_000;
    expect(await cache.shows(OWNER, `${OWNER}/new.png`)).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    // Concurrent misses share one reload; a miss on the fresh answer is final.
    t = 11_000;
    const misses = await Promise.all([1, 2, 3].map(() => cache.shows(OWNER, `${OWNER}/never.png`)));
    expect(misses).toEqual([false, false, false]);
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

describe('showsIn', () => {
  it('is the same matcher the cache uses: stored, extension form, tmp twin; never another owner or spelling', () => {
    const paths = new Set([`${OWNER}/p1.png`, `${OWNER}/p2`]);
    expect(showsIn(paths, OWNER, `${OWNER}/p1.png`)).toBe(true);
    expect(showsIn(paths, OWNER, `${OWNER}/p2.jpg`)).toBe(true);
    expect(showsIn(paths, OWNER, `u/${OWNER}/tmp/p1.png`)).toBe(true);
    expect(showsIn(paths, OWNER, `${OWNER}/p1.png.png`)).toBe(false);
    expect(showsIn(paths, OWNER.toUpperCase(), `${OWNER.toUpperCase()}/p1.png`)).toBe(false);
    expect(showsIn(paths, OTHER, `u/${OTHER}/tmp/p1.png`)).toBe(false);
  });
});

describe('production cache settings', () => {
  it('are a 60 s TTL, a reload after 5 s on a miss, and 500 owners', async () => {
    expect(PUBLIC_READER_CACHE_DEFAULTS).toEqual({ ttlMs: 60_000, refreshAfterMs: 5_000, maxOwners: 500 });
    let t = 0;
    const load = vi.fn(async (owner: string) => new Set([`${owner}/a.png`]));
    const cache = createPublicReaderPathCache(load, { now: () => t }); // the defaults, as system.ts builds it
    await cache.shows(OWNER, `${OWNER}/a.png`);
    t = 4_999;
    await cache.shows(OWNER, `${OWNER}/miss.png`);
    expect(load).toHaveBeenCalledTimes(1);
    t = 5_000;
    await cache.shows(OWNER, `${OWNER}/miss.png`);
    expect(load).toHaveBeenCalledTimes(2);
    t = 5_000 + 59_999;
    await cache.shows(OWNER, `${OWNER}/a.png`);
    expect(load).toHaveBeenCalledTimes(2);
    t = 5_000 + 60_000;
    await cache.shows(OWNER, `${OWNER}/a.png`);
    expect(load).toHaveBeenCalledTimes(3);
    // 500 owners fit; the 501st evicts the least recently read.
    const owners = Array.from({ length: 501 }, (_, i) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`);
    const big = createPublicReaderPathCache(load, { now: () => t });
    for (const o of owners.slice(0, 500)) await big.shows(o, `${o}/a.png`);
    const before = load.mock.calls.length;
    await big.shows(owners[0], `${owners[0]}/a.png`);
    expect(load.mock.calls.length).toBe(before);
    await big.shows(owners[500], `${owners[500]}/a.png`); // evicts owners[1]
    await big.shows(owners[1], `${owners[1]}/a.png`);
    expect(load.mock.calls.length).toBe(before + 2);
  });
});
