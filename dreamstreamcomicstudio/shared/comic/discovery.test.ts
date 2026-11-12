// @vitest-environment node
// The Discover listing codec (redesign DS-R2): strict queries, the canonical cache key, the keyset cursor and the
// item allow-list on both sides (RPC → wire in the Worker, wire → UI in the client).
import { describe, expect, it } from 'vitest';
import {
  DISCOVER_ASPECTS,
  DISCOVER_KINDS,
  DISCOVER_LIMIT_MAX,
  DISCOVER_RATINGS,
  DISCOVER_SHELF_SIZE,
  decodeDiscoverCursor,
  decodeDiscoverPage,
  decodeDiscoverShelves,
  discoverListRpcArgs,
  discoverListUrl,
  discoverPageFromRpc,
  discoverSearch,
  discoverShelvesFromRpc,
  discoverShelvesRpcArgs,
  discoverShelvesUrl,
  encodeDiscoverCursor,
  isPublicAvatarUrl,
  isPublicCoverUrl,
  parseDiscoverQuery,
  parseDiscoverShelvesQuery,
  type DiscoverItem,
  type DiscoverPage,
  type DiscoverQuery
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
    const cursor = encodeDiscoverCursor('new', { n: 1_762_000_000_123_456, slug: SLUG });
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
    ['a cursor for another sort', `sort=trending&cursor=${encodeDiscoverCursor('new', { n: 5, slug: SLUG })}`, /cursor/],
    ['a malformed cursor', 'cursor=t5.short', /cursor/]
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
      { sort: 'new', limit: 24, q: '100% Real_Deal & co', week: true, kind: 'storybook', lang: 'zh-hans', cursor: encodeDiscoverCursor('new', { n: 0, slug: SLUG }) }
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
  it('round-trips every sort, from 0 to the largest safe integer (microsecond publish times fit)', () => {
    for (const sort of ['trending', 'new', 'most_read'] as const) {
      for (const n of [0, 1, 35, 1_762_000_000_123_456, Number.MAX_SAFE_INTEGER]) {
        expect(decodeDiscoverCursor(sort, encodeDiscoverCursor(sort, { n, slug: SLUG }))).toEqual({ n, slug: SLUG });
      }
    }
  });

  it('never moves between sorts, and refuses non-canonical or unsafe numbers', () => {
    expect(decodeDiscoverCursor('trending', encodeDiscoverCursor('new', { n: 5, slug: SLUG }))).toBeNull();
    expect(decodeDiscoverCursor('trending', `t05.${SLUG}`)).toBeNull();
    expect(decodeDiscoverCursor('trending', `t${(2 ** 60).toString(36)}.${SLUG}`)).toBeNull();
    expect(decodeDiscoverCursor('trending', `t5.${SLUG}x`)).toBeNull();
    expect(decodeDiscoverCursor('trending', 7)).toBeNull();
  });

  it('becomes the RPC keyset arguments, with every argument named as the SQL declares it', () => {
    const cursor = encodeDiscoverCursor('most_read', { n: 42, slug: SLUG });
    expect(discoverListRpcArgs({ sort: 'most_read', limit: 6, q: 'moon', cursor })).toEqual({
      p_sort: 'most_read', p_q: 'moon', p_rating: null, p_lang: null, p_kind: null, p_length: null, p_week: false, p_limit: 6, p_after_n: 42, p_after_slug: SLUG
    });
    expect(discoverShelvesRpcArgs({ rating: 'kids' })).toEqual({ p_rating: 'kids', p_lang: null, p_kind: null, p_your_lang: null });
  });
});

describe('items: the allow-list (RPC → wire)', () => {
  it('maps cover paths to public URLs and keeps every allow-listed field', () => {
    const page = discoverPageFromRpc({ items: [rpcItem()], next: { n: 42, slug: SLUG } }, 'most_read', opts);
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
      next: encodeDiscoverCursor('most_read', { n: 42, slug: SLUG })
    });
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
    expect(discoverPageFromRpc({ items: [], next: { n: -1, slug: SLUG } }, 'trending', opts)).toEqual({ items: [] });
  });
});

describe('the UI decode (wire → components)', () => {
  const wire = (): DiscoverPage => discoverPageFromRpc({ items: [rpcItem(), rpcItem({ slug: 'Zz3dEf6hIj9kLm2nP', creator: null, rating: null, themeColor: null })], next: { n: 9, slug: SLUG } }, 'new', opts)!;

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
