// @vitest-environment node
// The Discover listing codec (redesign DS-R2): strict queries, the canonical cache key, the keyset cursor and the
// item allow-list on both sides (RPC → wire in the Worker, wire → UI in the client).
import { describe, expect, it } from 'vitest';
import {
  DISCOVER_ASPECTS,
  DISCOVER_KINDS,
  DISCOVER_LIMIT_MAX,
  DISCOVER_RATINGS,
  DISCOVER_RELATED_PATH,
  DISCOVER_RELATED_SIZE,
  DISCOVER_SHELF_IDS,
  DISCOVER_SHELF_MIN,
  DISCOVER_SHELF_SIZE,
  DISCOVER_SLUGS_MAX,
  DISCOVER_THIN_SHELVES,
  DISCOVER_TOP10_SIZE,
  decodeDiscoverCursor,
  decodeDiscoverPage,
  decodeDiscoverRelated,
  decodeDiscoverShelves,
  discoverListRpcArgs,
  discoverListUrl,
  discoverPageFromRpc,
  discoverRelatedFromRpc,
  discoverRelatedRpcArgs,
  discoverRelatedSearch,
  discoverRelatedUrl,
  discoverSearch,
  discoverShelvesFromRpc,
  discoverShelvesRpcArgs,
  discoverShelvesUrl,
  discoverSlugsUrl,
  encodeDiscoverCursor,
  isPublicAvatarUrl,
  isPublicCoverUrl,
  parseDiscoverQuery,
  parseDiscoverRelatedQuery,
  parseDiscoverShelvesQuery,
  type DiscoverItem,
  type DiscoverPage,
  type DiscoverQuery,
  type DiscoverRelated
} from './discovery';
import { CONTENT_RATINGS } from './safety';

const SUPA = 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co';
const KEY = 'K1234567890abcdefghijk';
const SLUG = 'Ab3dEf6hIj9kLm2nP';
const coverUrl = (p: string) => `${SUPA}/storage/v1/object/public/comic-assets/${p}`;
const opts = { coverUrl, avatarOrigin: SUPA };

/** One item as comic_discover_list sends it, plus every internal field a careless RPC could add. */
const rpcItem = (over: Record<string, unknown> = {}) => ({
  slug: SLUG,
  title: 'Spice Run',
  description: 'A courier races the monsoon.',
  kind: 'manga',
  pageCount: 12,
  aspect: '2:3',
  cover: { w480: `pub/${KEY}/cover-0123456789ab-w480.webp`, w1080: `pub/${KEY}/cover-0123456789ab-w1080.webp` },
  rating: 'PG',
  languages: ['en', 'hi'],
  publishedAt: 1_762_000_000_000,
  firstPublishedAt: 1_761_000_000_000,
  likes: 7,
  themeColor: '#aabbcc',
  creator: { username: 'alice', avatarUrl: `${SUPA}/storage/v1/object/public/comic-assets/avatars/alice.webp` },
  ...over
});
const INTERNALS = {
  userId: '00000000-0000-4000-8000-00000000000a',
  user_id: '00000000-0000-4000-8000-00000000000a',
  snapshot: { pages: [] },
  safety: { rating: 'PG', status: 'cleared' },
  assetKey: KEY,
  asset_key: KEY,
  views: 900,
  email: 'alice@example.com'
};
const ALLOWED = ['slug', 'title', 'description', 'kind', 'pageCount', 'aspect', 'cover', 'rating', 'languages', 'publishedAt', 'firstPublishedAt', 'likes', 'themeColor', 'creator'];

describe('parseDiscoverQuery: strict, with defaults', () => {
  it('defaults to trending, 24 per page, no filters', () => {
    expect(parseDiscoverQuery('')).toEqual({ ok: true, value: { sort: 'trending', limit: 24 } });
  });

  it('reads every filter and normalises the language and the search', () => {
    const cursor = encodeDiscoverCursor('new', { slug: SLUG });
    const parsed = parseDiscoverQuery(
      `sort=new&q=${encodeURIComponent('  Spice \n run ')}&rating=kids&lang=pt-BR&kind=webtoon&length=short&week=1&limit=12&cursor=${cursor}`
    );
    expect(parsed).toEqual({
      ok: true,
      value: { sort: 'new', q: 'Spice run', rating: 'kids', lang: 'pt-br', kind: 'webtoon', length: 'short', week: true, limit: 12, cursor }
    });
  });

  it.each([
    ['an unknown parameter', 'page=2', /Unknown parameter "page"/],
    ['a repeated parameter', 'kind=manga&kind=comic', /once/],
    ['an unknown sort', 'sort=random', /sort/],
    ['an unknown rating', 'rating=kidz', /rating/],
    ['an unknown kind', 'kind=novel', /kind/],
    ['an unknown length', 'length=epic', /length/],
    ['a malformed language', 'lang=english!', /language code/],
    ['week other than 1', 'week=true', /week/],
    ['limit 0', 'limit=0', /limit/],
    ['limit 25', 'limit=25', /limit/],
    ['a padded limit', 'limit=07', /limit/],
    ['a fractional limit', 'limit=2.5', /limit/],
    ['a 61-character search', `q=${'x'.repeat(61)}`, /60 characters/],
    ['a control character', `q=${encodeURIComponent('a\u0000b')}`, /control/],
    ['a cursor for another sort', `sort=trending&cursor=${encodeDiscoverCursor('new', { slug: SLUG })}`, /cursor/],
    ['a malformed cursor', 'cursor=t.short', /cursor/],
    ['a cursor that carries a number (the old score-bearing shape)', `cursor=t5.${SLUG}`, /cursor/]
  ])('rejects %s', (_label, search, reason) => {
    const parsed = parseDiscoverQuery(search);
    expect(parsed.ok).toBe(false);
    if (parsed.ok === false) expect(parsed.reason).toMatch(reason);
  });

  it('counts characters, not UTF-16 units (60 emoji are fine, as the SQL cuts at 60 characters)', () => {
    expect(parseDiscoverQuery(`q=${encodeURIComponent('🦸'.repeat(60))}`).ok).toBe(true);
    expect(parseDiscoverQuery(`q=${encodeURIComponent('🦸'.repeat(61))}`).ok).toBe(false);
  });

  it('a blank search is no search', () => {
    expect(parseDiscoverQuery('q=%20%20')).toEqual({ ok: true, value: { sort: 'trending', limit: 24 } });
  });
});

describe('the canonical search (the edge cache key)', () => {
  it('is the same for the same query in any parameter order, case of language, or default spelled out', () => {
    const a = parseDiscoverQuery('kind=manga&lang=EN&sort=trending&limit=24');
    const b = parseDiscoverQuery('lang=en&kind=manga');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(discoverSearch(a.value)).toBe(discoverSearch(b.value));
  });

  it('round-trips: parse(search(query)) is the query', () => {
    const queries: DiscoverQuery[] = [
      { sort: 'trending', limit: 24 },
      { sort: 'most_read', limit: 6, rating: 'PG-13', length: 'long' },
      { sort: 'new', limit: 24, q: '100% Real_Deal & co', week: true, kind: 'storybook', lang: 'zh-hans', cursor: encodeDiscoverCursor('new', { slug: SLUG }) }
    ];
    for (const q of queries) expect(parseDiscoverQuery(discoverSearch(q))).toEqual({ ok: true, value: q });
  });

  it('builds the UI URLs', () => {
    expect(discoverListUrl()).toBe('/api/comic/public/discover');
    expect(discoverListUrl({ sort: 'new', rating: 'kids' })).toBe('/api/comic/public/discover?sort=new&rating=kids');
    expect(discoverShelvesUrl({ yourLang: 'hi', rating: 'kids' })).toBe('/api/comic/public/discover/shelves?rating=kids&your_lang=hi');
  });

  it('the shelves query is strict too', () => {
    expect(parseDiscoverShelvesQuery('your_lang=HI&kind=manga')).toEqual({ ok: true, value: { kind: 'manga', yourLang: 'hi' } });
    expect(parseDiscoverShelvesQuery('sort=new').ok).toBe(false);
    expect(parseDiscoverShelvesQuery('rating=all').ok).toBe(false);
  });
});

describe('the keyset cursor', () => {
  it('round-trips every sort', () => {
    for (const sort of ['trending', 'new', 'most_read'] as const) {
      expect(decodeDiscoverCursor(sort, encodeDiscoverCursor(sort, { slug: SLUG }))).toEqual({ slug: SLUG });
    }
  });

  it('is the sort code and the slug, nothing else: no reader count or staff rank rides along', () => {
    expect(encodeDiscoverCursor('trending', { slug: SLUG })).toBe(`t.${SLUG}`);
    expect(encodeDiscoverCursor('new', { slug: SLUG })).toBe(`n.${SLUG}`);
    expect(encodeDiscoverCursor('most_read', { slug: SLUG })).toBe(`r.${SLUG}`);
    // Even a caller that hands it a score cannot put one in the cursor.
    expect(encodeDiscoverCursor('trending', { n: 4242, slug: SLUG } as never)).toBe(`t.${SLUG}`);
  });

  it('never moves between sorts, and refuses anything but <sort>.<slug>', () => {
    expect(decodeDiscoverCursor('trending', encodeDiscoverCursor('new', { slug: SLUG }))).toBeNull();
    expect(decodeDiscoverCursor('trending', `t5.${SLUG}`)).toBeNull();
    expect(decodeDiscoverCursor('trending', `t.${SLUG}x`)).toBeNull();
    expect(decodeDiscoverCursor('trending', `t.${SLUG}.5`)).toBeNull();
    expect(decodeDiscoverCursor('trending', `t${SLUG}`)).toBeNull();
    expect(decodeDiscoverCursor('trending', 7)).toBeNull();
  });

  it('becomes the RPC keyset argument (the slug only), with every argument named as the SQL declares it', () => {
    const cursor = encodeDiscoverCursor('most_read', { slug: SLUG });
    expect(discoverListRpcArgs({ sort: 'most_read', limit: 6, q: 'moon', cursor })).toEqual({
      p_sort: 'most_read', p_q: 'moon', p_rating: null, p_lang: null, p_kind: null, p_length: null, p_week: false, p_limit: 6, p_after_slug: SLUG
    });
    expect(discoverShelvesRpcArgs({ rating: 'kids' })).toEqual({ p_rating: 'kids', p_lang: null, p_kind: null, p_your_lang: null });
  });
});

describe('items: the allow-list (RPC → wire)', () => {
  it('maps cover paths to public URLs and keeps every allow-listed field', () => {
    const page = discoverPageFromRpc({ items: [rpcItem()], next: { slug: SLUG } }, 'most_read', opts);
    expect(page).toEqual({
      items: [
        {
          slug: SLUG,
          title: 'Spice Run',
          description: 'A courier races the monsoon.',
          kind: 'manga',
          pageCount: 12,
          aspect: '2:3',
          cover: { w480: coverUrl(`pub/${KEY}/cover-0123456789ab-w480.webp`), w1080: coverUrl(`pub/${KEY}/cover-0123456789ab-w1080.webp`) },
          rating: 'PG',
          languages: ['en', 'hi'],
          publishedAt: 1_762_000_000_000,
          firstPublishedAt: 1_761_000_000_000,
          likes: 7,
          themeColor: '#aabbcc',
          creator: { username: 'alice', avatarUrl: `${SUPA}/storage/v1/object/public/comic-assets/avatars/alice.webp` }
        }
      ],
      next: encodeDiscoverCursor('most_read', { slug: SLUG })
    });
  });

  it('the next cursor carries no number, even when the RPC sends a score with it', () => {
    // A careless RPC (or the earlier draft of the SQL) adds the ranking score to `next`: it never reaches the wire.
    for (const sort of ['trending', 'new', 'most_read'] as const) {
      const page = discoverPageFromRpc({ items: [rpcItem()], next: { n: 4242, score: 77, slug: SLUG } }, sort, opts)!;
      expect(page.next).toBe(encodeDiscoverCursor(sort, { slug: SLUG }));
      expect(page.next!.replace(SLUG, '')).toMatch(/^[tnr]\.$/);
      expect(page.next).not.toContain((4242).toString(36));
    }
    expect(discoverPageFromRpc({ items: [], next: { n: 5 } }, 'trending', opts)).toEqual({ items: [] });
  });

  it('drops every field outside the allow-list (snapshot, safety, asset key, user id …)', () => {
    const page = discoverPageFromRpc({ items: [rpcItem({ ...INTERNALS, creator: { username: 'alice', userId: INTERNALS.userId, email: 'x@y.z' } })], debug: 1 }, 'trending', opts);
    const item = page!.items[0] as unknown as Record<string, unknown>;
    expect(Object.keys(item).every((k) => ALLOWED.includes(k))).toBe(true);
    expect(Object.keys(item.creator as object)).toEqual(['username']);
    expect(Object.keys(page!)).toEqual(['items']);
    const text = JSON.stringify(page);
    for (const leak of [INTERNALS.userId, 'snapshot', 'safety', 'assetKey', 'alice@example.com', 'cleared']) expect(text).not.toContain(leak);
  });

  it('shows a cover only for pub/ copies, both sizes present', () => {
    const covers = [
      { w480: `u/1/img/a.webp`, w1080: `pub/${KEY}/c.webp` },
      { w480: `pub/${KEY}/../x.webp`, w1080: `pub/${KEY}/c.webp` },
      { w480: `pub/${KEY}/c.webp` },
      { w480: `https://evil.example/pub/${KEY}/c.webp`, w1080: `pub/${KEY}/c.webp` },
      'pub/x'
    ];
    for (const cover of covers) expect(discoverPageFromRpc({ items: [rpcItem({ cover })] }, 'trending', opts)!.items[0].cover).toBeUndefined();
  });

  it('an avatar only from our storage, never a third-party host or a URL holding a user id', () => {
    const avatar = (avatarUrl: string) => discoverPageFromRpc({ items: [rpcItem({ creator: { username: 'alice', avatarUrl } })] }, 'trending', opts)!.items[0].creator;
    expect(avatar('https://tracker.example/pixel.png')).toEqual({ username: 'alice' });
    expect(avatar('https://abcdefghijkl.supabase.co/storage/v1/object/public/comic-assets/avatars/a.webp')).toEqual({ username: 'alice' }); // another project
    expect(avatar(`${SUPA}/storage/v1/object/public/comic-assets/${INTERNALS.userId}/avatar-1.webp`)).toEqual({ username: 'alice' });
    expect(avatar(`${SUPA}/storage/v1/object/public/comic-assets/avatars/a.webp?track=1`)).toEqual({ username: 'alice' });
    expect(avatar(`http://bdjfmxfmhqhzvgrhbbzm.supabase.co/storage/v1/object/public/comic-assets/avatars/a.webp`)).toEqual({ username: 'alice' });
  });

  it('a byline needs a valid username; otherwise there is none', () => {
    for (const creator of [{ username: 'a' }, { username: '<script>' }, { username: 42 }, 'alice', null]) {
      expect(discoverPageFromRpc({ items: [rpcItem({ creator })] }, 'trending', opts)!.items[0].creator).toBeUndefined();
    }
  });

  it('cleans or drops what the card cannot show', () => {
    const map = (over: Record<string, unknown>) => discoverPageFromRpc({ items: [rpcItem(over)] }, 'trending', opts)!.items;
    expect(map({ slug: 'short' })).toEqual([]);
    expect(map({ title: '   ' })).toEqual([]);
    expect(map({ pageCount: 0 })).toEqual([]);
    expect(map({ pageCount: 3.5 })).toEqual([]);
    expect(map({ title: `x${'y'.repeat(200)}` })[0].title).toHaveLength(90);
    expect(map({ title: 'A\u0007B' })[0].title).toBe('AB');
    expect(map({ rating: 'R' })[0].rating).toBeUndefined();
    expect(map({ rating: 'G' })[0].rating).toBe('G');
    expect(map({ kind: 'novel' })[0].kind).toBe('comic');
    expect(map({ aspect: '7:9' })[0].aspect).toBe('2:3');
    expect(map({ themeColor: 'red' })[0].themeColor).toBeUndefined();
    expect(map({ likes: -3 })[0].likes).toBe(0);
    expect(map({ languages: ['en', 'en', 'bad lang', 7, 'hi'] })[0].languages).toEqual(['en', 'hi']);
    expect(map({ firstPublishedAt: undefined })[0].firstPublishedAt).toBe(1_762_000_000_000);
  });

  it('at most 24 items, each slug once; a non-listing is null (503), no data is an empty page', () => {
    const many = Array.from({ length: 40 }, (_, i) => rpcItem({ slug: `Ab3dEf6hIj9kLm${String(i).padStart(3, '0')}` }));
    expect(discoverPageFromRpc({ items: many }, 'trending', opts)!.items).toHaveLength(DISCOVER_LIMIT_MAX);
    expect(discoverPageFromRpc({ items: [rpcItem(), rpcItem()] }, 'trending', opts)!.items).toHaveLength(1);
    expect(discoverPageFromRpc(null, 'trending', opts)).toEqual({ items: [] });
    expect(discoverPageFromRpc({ rows: [] }, 'trending', opts)).toBeNull();
    expect(discoverPageFromRpc([], 'trending', opts)).toBeNull();
    expect(discoverPageFromRpc({ items: [], next: { slug: 'short' } }, 'trending', opts)).toEqual({ items: [] });
  });
});

describe('the UI decode (wire → components)', () => {
  const wire = (): DiscoverPage => discoverPageFromRpc({ items: [rpcItem(), rpcItem({ slug: 'Zz3dEf6hIj9kLm2nP', creator: null, rating: null, themeColor: null })], next: { slug: SLUG } }, 'new', opts)!;

  it('round-trips through JSON exactly', () => {
    const page = wire();
    expect(decodeDiscoverPage(JSON.parse(JSON.stringify(page)))).toEqual(page);
  });

  it('drops unknown fields again, at every level', () => {
    const page = wire();
    const tampered = JSON.parse(JSON.stringify(page));
    Object.assign(tampered.items[0], INTERNALS, { extra: { nested: true } });
    tampered.items[0].creator.userId = INTERNALS.userId;
    tampered.items[0].cover.original = 'x';
    tampered.total = 99;
    expect(decodeDiscoverPage(tampered)).toEqual(page);
  });

  it('refuses a cover that is not a pub/ copy in our storage', () => {
    const page = JSON.parse(JSON.stringify(wire()));
    page.items[0].cover.w480 = `${SUPA}/storage/v1/object/public/comic-assets/u/1/p/2/img/draft.webp`;
    expect(decodeDiscoverPage(page)!.items[0].cover).toBeUndefined();
    expect(isPublicCoverUrl(`${SUPA}/storage/v1/object/public/comic-assets/pub/${KEY}/c-w480.webp`)).toBe(true);
    expect(isPublicCoverUrl(`https://evil.example/storage/v1/object/public/comic-assets/pub/${KEY}/c.webp`)).toBe(false);
    expect(isPublicCoverUrl(`${SUPA}/storage/v1/object/public/comic-assets/pub/${KEY}/c.webp#x`)).toBe(false);
    expect(isPublicAvatarUrl(`${SUPA}/storage/v1/object/public/comic-assets/avatars/a.webp`)).toBe(true);
  });

  it('keeps a well-formed next cursor only', () => {
    const page = JSON.parse(JSON.stringify(wire()));
    page.next = 'javascript:alert(1)';
    expect(decodeDiscoverPage(page)!.next).toBeUndefined();
    expect(decodeDiscoverPage({ nope: true })).toBeNull();
  });
});

describe('shelves', () => {
  const items = (n: number, prefix = 'Ab3dEf6hIj9kLm') => Array.from({ length: n }, (_, i) => rpcItem({ slug: `${prefix}${String(i).padStart(3, '0')}` }));

  it('keeps shelves worth showing: none empty, the thin ones only with 4+, each at most 12', () => {
    const out = discoverShelvesFromRpc(
      { featured: items(1), trending: items(20), new: [], kids: items(2), lang: items(3), webtoon: items(4), manga: null, archive: items(5) },
      opts
    )!;
    expect(Object.keys(out.shelves)).toEqual(['featured', 'trending', 'kids', 'webtoon']);
    expect(out.shelves.trending).toHaveLength(DISCOVER_SHELF_SIZE);
    expect(out.shelves.featured).toHaveLength(1);
  });

  it('round-trips through the UI decode and drops unknown shelves', () => {
    const out = discoverShelvesFromRpc({ featured: items(2), lang: items(5) }, opts)!;
    const tampered = JSON.parse(JSON.stringify(out));
    tampered.shelves.secret = tampered.shelves.featured;
    tampered.debug = true;
    expect(decodeDiscoverShelves(tampered)).toEqual(out);
    expect(discoverShelvesFromRpc(null, opts)).toEqual({ shelves: {} });
    expect(discoverShelvesFromRpc('x', opts)).toBeNull();
  });
});

describe('Top 10 and Trending shelves (DISC-0)', () => {
  const items = (n: number, prefix = 'Tt3dEf6hIj9kLm') => Array.from({ length: n }, (_, i) => rpcItem({ slug: `${prefix}${String(i).padStart(3, '0')}` }));

  it('top10 is a shelf, after trending; trending is now a thin shelf; the minimum stays 4', () => {
    expect([...DISCOVER_SHELF_IDS]).toEqual(['featured', 'trending', 'top10', 'new', 'kids', 'lang', 'webtoon', 'manga']);
    expect(DISCOVER_THIN_SHELVES).toContain('trending');
    expect(DISCOVER_SHELF_MIN).toBe(4);
    expect(DISCOVER_TOP10_SIZE).toBe(10);
  });

  it('a Top 10 shows only with all ten comics, and never more than ten', () => {
    const full = discoverShelvesFromRpc({ top10: items(12) }, opts)!;
    expect(full.shelves.top10).toHaveLength(DISCOVER_TOP10_SIZE);
    expect(full.shelves.top10!.map((i) => i.slug)).toEqual(items(10).map((i) => i.slug));
    expect(discoverShelvesFromRpc({ top10: items(10) }, opts)!.shelves.top10).toHaveLength(10);
    expect(discoverShelvesFromRpc({ top10: items(9) }, opts)!.shelves).toEqual({});
    // One malformed entry leaves nine: no "Top 10" with nine comics.
    expect(discoverShelvesFromRpc({ top10: [...items(9), rpcItem({ slug: 'short' })] }, opts)!.shelves).toEqual({});
  });

  it('Trending shows only with 4 or more comics', () => {
    expect(discoverShelvesFromRpc({ trending: items(3) }, opts)!.shelves).toEqual({});
    expect(discoverShelvesFromRpc({ trending: items(4) }, opts)!.shelves.trending).toHaveLength(4);
  });

  it('decodes the same way on the UI side, in home order', () => {
    const out = discoverShelvesFromRpc({ new: items(2, 'Nn3dEf6hIj9kLm'), top10: items(10), trending: items(5, 'Tr3dEf6hIj9kLm') }, opts)!;
    expect(Object.keys(out.shelves)).toEqual(['trending', 'top10', 'new']);
    expect(decodeDiscoverShelves(JSON.parse(JSON.stringify(out)))).toEqual(out);
    const cut = JSON.parse(JSON.stringify(out));
    cut.shelves.top10.pop();
    expect(decodeDiscoverShelves(cut)!.shelves).not.toHaveProperty('top10');
  });
});

describe('slugs= on the list route (Continue reading)', () => {
  const S = (i: number) => `Sl3dEf6hIj9kLm${String(i).padStart(3, '0')}`;

  it('reads 1..20 slugs, keeps their order, drops repeats', () => {
    expect(parseDiscoverQuery(`slugs=${S(2)},${S(1)},${S(3)}`)).toEqual({ ok: true, value: { sort: 'trending', limit: 24, slugs: [S(2), S(1), S(3)] } });
    expect(parseDiscoverQuery(`slugs=${S(2)},${S(1)},${S(2)}`)).toEqual({ ok: true, value: { sort: 'trending', limit: 24, slugs: [S(2), S(1)] } });
    const twenty = Array.from({ length: DISCOVER_SLUGS_MAX }, (_, i) => S(i));
    expect(parseDiscoverQuery(`slugs=${twenty.join(',')}`)).toEqual({ ok: true, value: { sort: 'trending', limit: 24, slugs: twenty } });
    expect(parseDiscoverQuery(`slugs=${encodeURIComponent(`${S(1)},${S(2)}`)}`)).toEqual({ ok: true, value: { sort: 'trending', limit: 24, slugs: [S(1), S(2)] } });
  });

  it.each([
    ['no slug', 'slugs='],
    ['21 slugs', `slugs=${Array.from({ length: DISCOVER_SLUGS_MAX + 1 }, (_, i) => S(i)).join(',')}`],
    ['a malformed slug', `slugs=${S(1)},short`],
    ['an empty entry', `slugs=${S(1)},,${S(2)}`],
    ['a trailing comma', `slugs=${S(1)},`],
    ['a space', `slugs=${S(1)},%20${S(2)}`],
    ['slugs twice', `slugs=${S(1)}&slugs=${S(2)}`],
    ['a malformed filter beside it', `slugs=${S(1)}&rating=kidz`]
  ])('rejects %s', (_label, search) => {
    const parsed = parseDiscoverQuery(search);
    expect(parsed.ok).toBe(false);
  });

  it('ignores every other filter: one canonical cache key for the same slugs', () => {
    const plain = parseDiscoverQuery(`slugs=${S(1)},${S(2)}`);
    const noisy = parseDiscoverQuery(`sort=new&q=moon&rating=kids&lang=hi&kind=manga&length=long&week=1&limit=3&slugs=${S(1)},${S(2)},${S(1)}`);
    expect(plain.ok && noisy.ok).toBe(true);
    if (plain.ok && noisy.ok) {
      expect(noisy.value).toEqual(plain.value);
      expect(discoverSearch(noisy.value)).toBe(`slugs=${S(1)},${S(2)}`);
      expect(discoverSearch(plain.value)).toBe(discoverSearch(noisy.value));
    }
    // A different order is a different answer (the comics come back in the order asked).
    const swapped = parseDiscoverQuery(`slugs=${S(2)},${S(1)}`);
    if (swapped.ok && plain.ok) expect(discoverSearch(swapped.value)).not.toBe(discoverSearch(plain.value));
  });

  it('round-trips and builds the UI URL', () => {
    const q: DiscoverQuery = { sort: 'trending', limit: DISCOVER_LIMIT_MAX, slugs: [S(5), S(4)] };
    expect(parseDiscoverQuery(discoverSearch(q))).toEqual({ ok: true, value: q });
    expect(discoverListUrl({ slugs: [S(5), S(4)] })).toBe(`/api/comic/public/discover?slugs=${S(5)},${S(4)}`);
    expect(discoverListUrl({ slugs: [S(5), S(4)], sort: 'new', kind: 'manga' })).toBe(`/api/comic/public/discover?slugs=${S(5)},${S(4)}`);
  });

  it('sends p_slugs (and the defaults for everything else) only for a slugs query', () => {
    expect(discoverListRpcArgs({ sort: 'new', limit: 3, kind: 'manga', slugs: [S(1), S(2)] })).toEqual({
      p_sort: 'trending', p_q: null, p_rating: null, p_lang: null, p_kind: null, p_length: null, p_week: false, p_limit: DISCOVER_LIMIT_MAX, p_after_slug: null, p_slugs: [S(1), S(2)]
    });
    expect(discoverListRpcArgs({ sort: 'trending', limit: DISCOVER_LIMIT_MAX })).not.toHaveProperty('p_slugs');
  });

  it('an empty slugs query is never the full listing: no RPC call, and a URL the edge refuses', () => {
    expect(() => discoverListRpcArgs({ sort: 'trending', limit: DISCOVER_LIMIT_MAX, slugs: [] })).toThrow(/slug/);
    expect(() => discoverListRpcArgs({ sort: 'trending', limit: DISCOVER_LIMIT_MAX, slugs: ['short', 'x&sort=new'] })).toThrow(/slug/);
    for (const slugs of [[], ['a b', 'x&sort=new']]) {
      const url = discoverListUrl({ slugs });
      expect(url).toBe('/api/comic/public/discover?slugs=');
      expect(parseDiscoverQuery(url.slice(url.indexOf('?') + 1)).ok).toBe(false); // 400, not Trending
    }
  });

  it('discoverSlugsUrl: slug-shaped, each once, at most 20, in order; null when none is left (skip the fetch)', () => {
    expect(discoverSlugsUrl([S(2), 'x&sort=new', S(1), 'a b', S(2), '', 7 as never])).toBe(`/api/comic/public/discover?slugs=${S(2)},${S(1)}`);
    for (const none of [[], ['x&sort=new'], ['a b', ''], [`${S(1)}x`]]) expect(discoverSlugsUrl(none)).toBeNull();
    const many = Array.from({ length: 30 }, (_, i) => S(i));
    const url = discoverSlugsUrl(many)!;
    expect(url).toBe(`/api/comic/public/discover?slugs=${many.slice(0, DISCOVER_SLUGS_MAX).join(',')}`);
    const parsed = parseDiscoverQuery(url.slice(url.indexOf('?') + 1));
    expect(parsed).toEqual({ ok: true, value: { sort: 'trending', limit: DISCOVER_LIMIT_MAX, slugs: many.slice(0, DISCOVER_SLUGS_MAX) } });
    // The list URL cleans the same way, so a corrupt mirror key never becomes a raw parameter.
    expect(discoverListUrl({ slugs: [S(3), 'x&sort=new', S(3)] })).toBe(`/api/comic/public/discover?slugs=${S(3)}`);
  });
});

describe('related: GET /discover/related?slug=&lang= (the share page’s More like this and Up next)', () => {
  const OTHER = 'Zz3dEf6hIj9kLm2nP';

  it('the path', () => {
    expect(DISCOVER_RELATED_PATH).toBe('/api/comic/public/discover/related');
    expect(DISCOVER_RELATED_SIZE).toBe(12);
  });

  it('the query is strict: slug required and slug-shaped, lang optional', () => {
    expect(parseDiscoverRelatedQuery(`slug=${SLUG}`)).toEqual({ ok: true, value: { slug: SLUG } });
    expect(parseDiscoverRelatedQuery(`lang=pt-BR&slug=${SLUG}`)).toEqual({ ok: true, value: { slug: SLUG, lang: 'pt-br' } });
    expect(parseDiscoverRelatedQuery(new URLSearchParams({ slug: SLUG, lang: 'HI' }))).toEqual({ ok: true, value: { slug: SLUG, lang: 'hi' } });
    for (const [search, reason] of [
      ['', /slug/],
      ['lang=hi', /slug/],
      ['slug=', /slug/],
      ['slug=short', /slug/],
      [`slug=${SLUG}x`, /slug/],
      [`slug=${SLUG}&slug=${OTHER}`, /once/],
      [`slug=${SLUG}&lang=english!`, /language code/],
      [`slug=${SLUG}&sort=new`, /Unknown parameter "sort"/],
      [`slug=${SLUG}&limit=5`, /Unknown parameter/]
    ] as const) {
      const parsed = parseDiscoverRelatedQuery(search);
      expect(parsed.ok, search).toBe(false);
      if (parsed.ok === false) expect(parsed.reason).toMatch(reason);
    }
  });

  it('the canonical search (cache key) is slug then lang, whatever the order or case given', () => {
    const a = parseDiscoverRelatedQuery(`lang=HI&slug=${SLUG}`);
    const b = parseDiscoverRelatedQuery(`slug=${SLUG}&lang=hi`);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(discoverRelatedSearch(a.value)).toBe(`slug=${SLUG}&lang=hi`);
      expect(discoverRelatedSearch(b.value)).toBe(discoverRelatedSearch(a.value));
    }
    expect(discoverRelatedUrl({ slug: SLUG })).toBe(`/api/comic/public/discover/related?slug=${SLUG}`);
    expect(discoverRelatedUrl({ slug: SLUG, lang: 'te' })).toBe(`/api/comic/public/discover/related?slug=${SLUG}&lang=te`);
    expect(discoverRelatedRpcArgs({ slug: SLUG })).toEqual({ p_slug: SLUG, p_lang: null });
    expect(discoverRelatedRpcArgs({ slug: SLUG, lang: 'te' })).toEqual({ p_slug: SLUG, p_lang: 'te' });
    for (const q of [{ slug: SLUG }, { slug: SLUG, lang: 'zh-hans' }]) expect(parseDiscoverRelatedQuery(discoverRelatedSearch(q))).toEqual({ ok: true, value: q });
  });

  const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => rpcItem({ slug: `${prefix}${String(i).padStart(3, '0')}` }));

  it('RPC → wire: the item allow-list, at most 12 each, basis passed through', () => {
    const out = discoverRelatedFromRpc({ creator: many(14, 'Cr3dEf6hIj9kLm'), similar: [rpcItem({ ...INTERNALS, slug: OTHER })], basis: 'library', debug: 1 }, opts)!;
    expect(Object.keys(out)).toEqual(['creator', 'similar', 'basis']);
    expect(out.creator).toHaveLength(DISCOVER_RELATED_SIZE);
    expect(out.similar.map((i) => i.slug)).toEqual([OTHER]);
    expect(Object.keys(out.similar[0]).every((k) => ALLOWED.includes(k))).toBe(true);
    expect(out.basis).toBe('library');
    const text = JSON.stringify(out);
    for (const leak of [INTERNALS.userId, 'snapshot', 'safety', 'assetKey', 'alice@example.com']) expect(text).not.toContain(leak);
    expect(discoverRelatedFromRpc({ similar: many(30, 'Si3dEf6hIj9kLm'), basis: 'similar' }, opts)!.similar).toHaveLength(DISCOVER_RELATED_SIZE);
  });

  it('creator is left out when absent or empty; similar is always a list', () => {
    expect(discoverRelatedFromRpc({ similar: [], basis: 'library' }, opts)).toEqual({ similar: [], basis: 'library' });
    expect(discoverRelatedFromRpc({ creator: [], similar: null, basis: 'library' }, opts)).toEqual({ similar: [], basis: 'library' });
    expect(discoverRelatedFromRpc({ creator: [rpcItem({ slug: 'short' })], similar: [rpcItem()], basis: 'similar' }, opts)).toEqual({
      similar: discoverRelatedFromRpc({ similar: [rpcItem()], basis: 'similar' }, opts)!.similar,
      basis: 'similar'
    });
  });

  describe('the edge rebuild holds the related rules itself (the last allow-list)', () => {
    const both = (raw: unknown) => [discoverRelatedFromRpc(raw, opts), decodeDiscoverRelated(JSON.parse(JSON.stringify(discoverRelatedFromRpc(raw, opts))))];
    const C = (i: number) => `Cr3dEf6hIj9kLm${String(i).padStart(3, '0')}`;

    it('a creator item without a byline is dropped (a hidden name is never tied to a named comic)', () => {
      const anon = rpcItem({ slug: C(2), creator: undefined });
      for (const out of both({ creator: [rpcItem({ slug: C(1) }), anon], similar: [], basis: 'library' })) {
        expect(out!.creator!.map((i) => i.slug)).toEqual([C(1)]);
      }
      for (const out of both({ creator: [anon], similar: [], basis: 'library' })) expect(out).toEqual({ similar: [], basis: 'library' });
    });

    it('creator items must all share one username, or there is no creator list', () => {
      const mixed = { creator: [rpcItem({ slug: C(1) }), rpcItem({ slug: C(2), creator: { username: 'beta' } })], similar: [], basis: 'library' };
      for (const out of both(mixed)) expect(out).toEqual({ similar: [], basis: 'library' });
      const same = { creator: [rpcItem({ slug: C(1) }), rpcItem({ slug: C(2) })], similar: [], basis: 'library' };
      for (const out of both(same)) expect(out!.creator!.map((i) => i.creator!.username)).toEqual(['alice', 'alice']);
    });

    it('a comic is never in both lists: similar drops what creator holds', () => {
      const raw = { creator: [rpcItem({ slug: C(1) })], similar: [rpcItem({ slug: C(1) }), rpcItem({ slug: OTHER })], basis: 'library' };
      for (const out of both(raw)) {
        expect(out!.creator!.map((i) => i.slug)).toEqual([C(1)]);
        expect(out!.similar.map((i) => i.slug)).toEqual([OTHER]);
      }
      // When creator is dropped (mixed usernames), similar keeps its own items.
      const mixed = { creator: [rpcItem({ slug: C(1) }), rpcItem({ slug: C(2), creator: { username: 'beta' } })], similar: [rpcItem({ slug: C(1) })], basis: 'library' };
      for (const out of both(mixed)) expect(out!.similar.map((i) => i.slug)).toEqual([C(1)]);
    });

    it('unrated items are dropped from both lists (a rating outside G, PG, PG-13 counts as none)', () => {
      const raw = {
        creator: [rpcItem({ slug: C(1), rating: undefined }), rpcItem({ slug: C(2), rating: 'R' }), rpcItem({ slug: C(3) })],
        similar: [rpcItem({ slug: OTHER, rating: null }), rpcItem({ slug: C(4), rating: 'NC-17' }), rpcItem({ slug: C(5), rating: 'PG-13' })],
        basis: 'library'
      };
      for (const out of both(raw)) {
        expect(out!.creator!.map((i) => i.slug)).toEqual([C(3)]);
        expect(out!.similar.map((i) => i.slug)).toEqual([C(5)]);
      }
    });

    it('the cap of 12 counts kept items only; the comic itself is never listed when its slug is given', () => {
      const raw = { similar: [...Array.from({ length: 5 }, (_, i) => rpcItem({ slug: C(i), rating: undefined })), ...many(14, 'Si3dEf6hIj9kLm')], basis: 'similar' };
      expect(discoverRelatedFromRpc(raw, opts)!.similar.map((i) => i.slug)).toEqual(many(12, 'Si3dEf6hIj9kLm').map((i) => i.slug));
      const self = { creator: [rpcItem({ slug: SLUG }), rpcItem({ slug: C(1) })], similar: [rpcItem({ slug: SLUG }), rpcItem({ slug: OTHER })], basis: 'library' };
      const out = discoverRelatedFromRpc(self, opts, SLUG)!;
      expect(out.creator!.map((i) => i.slug)).toEqual([C(1)]);
      expect(out.similar.map((i) => i.slug)).toEqual([OTHER]);
      const wire = JSON.parse(JSON.stringify(discoverRelatedFromRpc(self, opts)));
      expect(wire.creator.map((i: DiscoverItem) => i.slug)).toEqual([SLUG, C(1)]);
      expect(decodeDiscoverRelated(wire, SLUG)).toEqual(out);
    });
  });

  it('basis is required on both sides: without a known basis it is not an answer (503 / hidden)', () => {
    for (const raw of [{ similar: [rpcItem()] }, { similar: [rpcItem()], basis: 'because' }, { similar: [rpcItem()], basis: null }, null, undefined, 'x', []]) {
      expect(discoverRelatedFromRpc(raw, opts), JSON.stringify(raw)).toBeNull();
      expect(decodeDiscoverRelated(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('round-trips through the UI decode and drops anything else again', () => {
    const wire: DiscoverRelated = discoverRelatedFromRpc({ creator: many(2, 'Cr3dEf6hIj9kLm'), similar: many(3, 'Si3dEf6hIj9kLm'), basis: 'library' }, opts)!;
    expect(decodeDiscoverRelated(JSON.parse(JSON.stringify(wire)))).toEqual(wire);
    const tampered = JSON.parse(JSON.stringify(wire));
    Object.assign(tampered.similar[0], INTERNALS);
    tampered.creator[0].cover.original = 'x';
    tampered.score = 4;
    tampered.next = 't.x';
    expect(decodeDiscoverRelated(tampered)).toEqual(wire);
    // A cover that is not a pub/ copy in our storage is dropped on the UI side too.
    const page = JSON.parse(JSON.stringify(wire));
    page.similar[0].cover.w480 = `${SUPA}/storage/v1/object/public/comic-assets/u/1/p/2/img/draft.webp`;
    expect(decodeDiscoverRelated(page)!.similar[0].cover).toBeUndefined();
    expect(decodeDiscoverRelated({ similar: 'x', basis: 'library' })).toEqual({ similar: [], basis: 'library' });
  });
});

describe('vocabulary stays in step with the contract', () => {
  it('ratings are exactly the content ratings', () => {
    expect([...DISCOVER_RATINGS]).toEqual([...CONTENT_RATINGS]);
  });

  it('every kind and aspect round-trips through an item', () => {
    for (const kind of DISCOVER_KINDS) expect(discoverPageFromRpc({ items: [rpcItem({ kind })] }, 'trending', opts)!.items[0].kind).toBe(kind);
    for (const aspect of DISCOVER_ASPECTS) expect(discoverPageFromRpc({ items: [rpcItem({ aspect })] }, 'trending', opts)!.items[0].aspect).toBe(aspect);
  });

  it('a decoded item has no key outside the allow-list', () => {
    const item: DiscoverItem = discoverPageFromRpc({ items: [rpcItem(INTERNALS)] }, 'trending', opts)!.items[0];
    expect(Object.keys(item).sort()).toEqual([...ALLOWED].sort());
  });
});
