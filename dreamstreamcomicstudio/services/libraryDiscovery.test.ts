import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLibraryReads,
  libraryPicks,
  libraryReads,
  rememberLibraryPage,
  type DiscoveryComic
} from './libraryDiscovery';

const slug = (n: number) => 'Lib' + String(n).padStart(14, '0');
const comic = (n: number, title: string, extra: Partial<DiscoveryComic> = {}): DiscoveryComic => ({
  slug: slug(n),
  title,
  overview: '',
  likes: 0,
  publishedAt: 0,
  liked: false,
  ...extra
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('local Library reading', () => {
  it('keeps guest reads in the tab and member reads separated, without stored titles or unlisted slugs', () => {
    for (const [owner, n] of [
      [null, 1],
      ['alice', 2],
      ['bob', 3]
    ] as const) {
      rememberLibraryPage(owner, { slug: slug(n), visibility: 'public' }, 2, 5);
      rememberLibraryPage(owner, { slug: slug(9), visibility: 'unlisted' }, 3, 5);
    }
    expect(libraryReads(null).map((r) => r.slug)).toEqual([slug(1)]);
    expect(libraryReads('alice').map((r) => r.slug)).toEqual([slug(2)]);
    expect(libraryReads('bob').map((r) => r.slug)).toEqual([slug(3)]);
    expect(JSON.stringify(localStorage)).not.toContain(slug(1));
    expect(JSON.stringify(localStorage)).not.toContain(slug(9));
    clearLibraryReads('alice');
    expect(libraryReads('alice')).toEqual([]);
    expect(libraryReads('bob')).toHaveLength(1);
  });
  it('updates a page once, forgets stale readings and ignores corrupt values', () => {
    const pub = { slug: slug(1), visibility: 'public' as const };
    rememberLibraryPage('alice', pub, 2, 6);
    rememberLibraryPage('alice', pub, 4, 6);
    rememberLibraryPage('alice', pub, 20, 6);
    expect(libraryReads('alice')).toHaveLength(1);
    expect(libraryReads('alice')[0].page).toBe(4);
    expect(libraryReads('alice', Date.now() + 31 * 86_400_000)).toEqual([]);
    localStorage.setItem('ds.library.reads.v1.alice', '{}');
    expect(libraryReads('alice')).toEqual([]);
  });
});

describe('recommendations from currently listed cards', () => {
  const a = comic(1, 'Moonrise', { owner: 'a', overview: 'An astronomer maps starships in orbit.' });
  const b = comic(2, 'Night Watch', { owner: 'b', overview: 'Two starships rendezvous in orbit.' });
  const c = comic(3, 'Orchard', { owner: 'a', likes: 15, publishedAt: 3 });
  const d = comic(4, 'Grove', { owner: 'a', likes: 14, publishedAt: 2 });
  const e = comic(5, 'Snow', { owner: 'c', publishedAt: 4, rating: 'G' });
  it('combines popularity, recency and creator diversity in a cold start', () => {
    expect(libraryPicks([c, d, e, b], []).map((p) => p.slug)).toEqual([c.slug, e.slug, b.slug]);
  });
  it('resumes the actual page, recommends another story with a shared published topic, and skips repeated slugs', () => {
    rememberLibraryPage(null, { slug: a.slug, visibility: 'public' }, 3, 5);
    const picks = libraryPicks([a, b, b, c, d], libraryReads(null));
    expect(picks[0]).toMatchObject({ slug: a.slug, resumePage: 3 });
    expect(picks[1]).toMatchObject({ slug: b.slug, reason: 'Because you read “Moonrise”' });
    expect(new Set(picks.map((p) => p.slug)).size).toBe(picks.length);
    rememberLibraryPage(null, { slug: a.slug, visibility: 'public' }, 5, 5);
    expect(libraryPicks([a, b, c], libraryReads(null)).some((p) => p.resumePage)).toBe(false);
  });
  it('re-ranks after liking and unliking, including an older publicly revalidated seed', () => {
    const candidates = [c, d, b, e];
    expect(libraryPicks(candidates, [], [{ ...a, liked: true }])[0]).toMatchObject({
      slug: b.slug,
      reason: 'Because you liked “Moonrise”'
    });
    expect(libraryPicks(candidates, [], [a])[0].slug).toBe(c.slug);
  });
  it('cannot resurrect unavailable titles or slugs from history', () => {
    rememberLibraryPage(null, { slug: a.slug, visibility: 'public' }, 2, 5);
    const picks = libraryPicks([b, c], libraryReads(null));
    expect(picks.some((p) => p.resumePage || p.reason.startsWith('Because you'))).toBe(false);
    expect(JSON.stringify(picks)).not.toContain(a.slug);
    expect(libraryPicks([], libraryReads(null))).toEqual([]);
  });
});
