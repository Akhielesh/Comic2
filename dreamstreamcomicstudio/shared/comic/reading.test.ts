// @vitest-environment node
// The reading contract (Discover DISC-0): the read event's codec, the referrer and ?via= / ?src= rules, the kids rule,
// the Library language, the thresholds, and the strict decoders of the creator and admin reading answers.
// Every value here is synthetic.
import { describe, expect, it } from 'vitest';
import {
  BATCHES_PER_DAY,
  CREATOR_CAP_WIDE,
  FINISH_SHARE,
  FLUSH_EVERY_NEW_PAGES,
  K_MIN,
  PAGE_MS_BATCH_CAP,
  QUALIFY_MIN_PAGES,
  QUALIFY_PAGE_MS,
  QUALIFY_TOTAL_MS,
  RANK_CAP_NARROW,
  RANK_CAP_WIDE,
  READ_BODY_MAX,
  READ_CHANNELS,
  READ_DEVICES,
  READ_EVENT_TYPES,
  READ_INGEST_STATUSES,
  READ_INSIGHTS_PATH,
  READ_PAGE_MAX,
  READ_PAIRS_MAX,
  READ_PATH,
  READ_SURFACES,
  READING_ADMIN_PATH,
  READING_JOBS,
  VIEWER_DWELL_CAP_PER_PAGE,
  channelFromReferrer,
  decodeReadBody,
  decodeReadInsights,
  decodeReadingAdminOverview,
  encodeReadBody,
  isKidsComic,
  libraryLang,
  parseReadRange,
  parseReadingAdminDays,
  readChannelFromSearch,
  readSurfaceFromSearch,
  type ReadBody,
  type ReadInsights,
  type ReadingAdminOverview
} from './reading';
import { PUBLIC_KIDS_AUDIENCE, SHARE_CHANNELS, SLUG_RE } from './publication';

const SLUG = 'Ab3dEf6hIj9kLm2nP';
const DAY_CODE = 'AbCdEfGhIjKlMnOpQrSt_-';

describe('the read route and the body limit', () => {
  it('posts to /api/comic/public/s/<slug>/read, at most 2 KB', () => {
    expect(READ_PATH(SLUG)).toBe(`/api/comic/public/s/${SLUG}/read`);
    expect(READ_BODY_MAX).toBe(2048);
    expect(READ_PAGE_MAX).toBe(500);
    expect(READ_PAIRS_MAX).toBe(60);
  });
});

describe('the thresholds (the SQL repeats each one)', () => {
  it('are the agreed values', () => {
    expect({
      QUALIFY_PAGE_MS,
      QUALIFY_MIN_PAGES,
      QUALIFY_TOTAL_MS,
      FINISH_SHARE,
      PAGE_MS_BATCH_CAP,
      VIEWER_DWELL_CAP_PER_PAGE,
      BATCHES_PER_DAY,
      RANK_CAP_NARROW,
      RANK_CAP_WIDE,
      CREATOR_CAP_WIDE,
      K_MIN,
      FLUSH_EVERY_NEW_PAGES
    }).toEqual({
      QUALIFY_PAGE_MS: 1000,
      QUALIFY_MIN_PAGES: 2,
      QUALIFY_TOTAL_MS: 8000,
      FINISH_SHARE: 0.6,
      PAGE_MS_BATCH_CAP: 120000,
      VIEWER_DWELL_CAP_PER_PAGE: 120000,
      BATCHES_PER_DAY: 40,
      RANK_CAP_NARROW: 3,
      RANK_CAP_WIDE: 20,
      CREATOR_CAP_WIDE: 50,
      K_MIN: 5,
      FLUSH_EVERY_NEW_PAGES: 4
    });
  });
});

describe('the vocabularies', () => {
  it('lists the event types, channels, surfaces and devices in their agreed order', () => {
    expect([...READ_EVENT_TYPES]).toEqual(['open', 'read', 'lang', 'share']);
    expect([...READ_CHANNELS]).toEqual(['linkedin', 'whatsapp', 'x', 'facebook', 'telegram', 'email', 'qr', 'embed', 'copy', 'native', 'library', 'up_next', 'search', 'direct', 'other']);
    expect([...READ_SURFACES]).toEqual(['link', 'lib.billboard', 'lib.continue', 'lib.lang', 'lib.trending', 'lib.top10', 'lib.new', 'lib.picks', 'lib.kind', 'lib.grid', 'more', 'up_next', 'embed']);
    expect([...READ_DEVICES]).toEqual(['phone', 'tablet', 'desktop']);
  });

  it('every share channel is a read channel (old links keep their channel)', () => {
    for (const ch of SHARE_CHANNELS) expect(READ_CHANNELS).toContain(ch);
  });
});

describe('encodeReadBody / decodeReadBody', () => {
  const full: ReadBody = {
    v: 1,
    t: 'read',
    d: DAY_CODE,
    lang: 'hi',
    ch: 'linkedin',
    src: 'lib.top10',
    dev: 'phone',
    p: [
      [3, 9000],
      [4, 9000]
    ],
    mx: 4,
    from: 'en'
  };

  it('round-trips a full body, in the fixed key order', () => {
    const text = encodeReadBody(full)!;
    expect(Object.keys(JSON.parse(text))).toEqual(['v', 't', 'd', 'lang', 'ch', 'src', 'dev', 'p', 'mx', 'from']);
    expect(decodeReadBody(text)).toEqual(full);
    expect(decodeReadBody(JSON.parse(text))).toEqual(full);
  });

  it('round-trips the smallest body', () => {
    for (const t of READ_EVENT_TYPES) {
      const text = encodeReadBody({ v: 1, t })!;
      expect(text).toBe(`{"v":1,"t":"${t}"}`);
      expect(decodeReadBody(text)).toEqual({ v: 1, t });
    }
  });

  it('drops every field outside the allow-list', () => {
    const tampered = { ...full, viewer: 'x', slug: SLUG, pageCount: 2, qualified: true, finished: true, ip: '203.0.113.9', __proto__x: 1 };
    expect(decodeReadBody(JSON.stringify(tampered))).toEqual(full);
  });

  it('is null when the version or the event type is wrong, or the text is not a JSON object', () => {
    for (const bad of [
      { ...full, v: 2 },
      { ...full, v: '1' },
      { ...full, t: 'complete' },
      { ...full, t: 'view' },
      { v: 1 }
    ]) expect(decodeReadBody(JSON.stringify(bad))).toBeNull();
    for (const bad of ['', 'not json', '[1,2]', 'null', '7', '"read"', '{"v":1,"t":"read"']) expect(decodeReadBody(bad)).toBeNull();
    expect(decodeReadBody(null)).toBeNull();
    expect(decodeReadBody(undefined)).toBeNull();
    expect(decodeReadBody([{ v: 1, t: 'read' }])).toBeNull();
  });

  it('is null for a body over 2 KB, counted in UTF-8 bytes', () => {
    const pad = (n: number, ch: string) => JSON.stringify({ v: 1, t: 'open', pad: ch.repeat(n) });
    const base = pad(0, 'x').length;
    expect(decodeReadBody(pad(READ_BODY_MAX - base, 'x'))).toEqual({ v: 1, t: 'open' });
    expect(decodeReadBody(pad(READ_BODY_MAX - base + 1, 'x'))).toBeNull();
    // 700 three-byte characters are 700 UTF-16 units but 2,100 bytes.
    expect(decodeReadBody(pad(700, 'क'))).toBeNull();
  });

  it('drops out-of-range pages and times, keeps the good pairs', () => {
    const body = decodeReadBody(
      JSON.stringify({
        v: 1,
        t: 'read',
        p: [[0, 5000], [501, 5000], [-1, 5000], [2.5, 5000], ['3', 5000], [3, -1], [3, 120001], [3, 1.5], [3], [3, 5000, 1], 'x', null, [7, 0], [8, 120000]]
      })
    );
    expect(body).toEqual({ v: 1, t: 'read', p: [[7, 0], [8, 120000]] });
    expect(decodeReadBody(JSON.stringify({ v: 1, t: 'read', p: [[0, 1]] }))).toEqual({ v: 1, t: 'read' });
    expect(decodeReadBody(JSON.stringify({ v: 1, t: 'read', p: 'x' }))).toEqual({ v: 1, t: 'read' });
  });

  it('merges a page given twice (summed, at most 120 s) so every page is once per batch', () => {
    const body = decodeReadBody(JSON.stringify({ v: 1, t: 'read', p: [[2, 70000], [3, 1000], [2, 70000], [3, 500]] }));
    expect(body!.p).toEqual([[2, PAGE_MS_BATCH_CAP], [3, 1500]]);
  });

  it('keeps at most 60 pages', () => {
    const p = Array.from({ length: 80 }, (_, i) => [i + 1, 1000]);
    const body = decodeReadBody(JSON.stringify({ v: 1, t: 'read', p }))!;
    expect(body.p).toHaveLength(READ_PAIRS_MAX);
    expect(body.p![59]).toEqual([60, 1000]);
  });

  it('drops a bad day code, channel, surface, device, language, highest page or switched-from edition', () => {
    const bad = {
      v: 1,
      t: 'lang',
      d: 'short',
      lang: 'english!',
      ch: 'myspace',
      src: 'lib.secret',
      dev: 'fridge',
      mx: 501,
      from: `en-${'x'.repeat(40)}`
    };
    expect(decodeReadBody(JSON.stringify(bad))).toEqual({ v: 1, t: 'lang' });
    for (const d of [`${DAY_CODE}x`, 'AbCdEfGhIjKlMnOpQrSt+/', 7]) expect(decodeReadBody(JSON.stringify({ v: 1, t: 'open', d }))).toEqual({ v: 1, t: 'open' });
    for (const lang of ['e', 'en_US', `${'a'.repeat(3)}-${'b'.repeat(8)}-${'c'.repeat(8)}-${'d'.repeat(8)}-ee`, 'en-'.padEnd(36, 'x'), 42]) {
      expect(decodeReadBody(JSON.stringify({ v: 1, t: 'open', lang })), String(lang)).toEqual({ v: 1, t: 'open' });
    }
    for (const mx of [0, 2.5, '4', -3]) expect(decodeReadBody(JSON.stringify({ v: 1, t: 'read', mx }))).toEqual({ v: 1, t: 'read' });
    expect(decodeReadBody(JSON.stringify({ v: 1, t: 'open', lang: 'zh-Hans', ch: 'whatsapp' }))).toEqual({ v: 1, t: 'open', lang: 'zh-Hans', ch: 'whatsapp' });
  });

  it('the encoder rounds and clamps times, merges pages and drops what the edge would drop', () => {
    const text = encodeReadBody({
      v: 1,
      t: 'read',
      ch: 'nope' as never,
      p: [
        [1, 999.6],
        [2, 130000],
        [1, 0.2],
        [0, 500],
        [2.5, 100]
      ],
      mx: 2
    });
    expect(JSON.parse(text!)).toEqual({ v: 1, t: 'read', p: [[1, 1000], [2, 120000]], mx: 2 });
    expect(encodeReadBody({ v: 1, t: 'view' as never })).toBeNull();
  });

  it('the largest possible body still fits in 2 KB', () => {
    const text = encodeReadBody({
      v: 1,
      t: 'share',
      d: DAY_CODE,
      lang: `abc-${'x'.repeat(8)}-${'y'.repeat(8)}-${'z'.repeat(8)}`,
      ch: 'telegram',
      src: 'lib.billboard',
      dev: 'desktop',
      p: Array.from({ length: 200 }, (_, i) => [READ_PAGE_MAX - i, PAGE_MS_BATCH_CAP] as [number, number]),
      mx: READ_PAGE_MAX,
      from: `abc-${'x'.repeat(8)}-${'y'.repeat(8)}-${'z'.repeat(8)}`
    })!;
    expect(new TextEncoder().encode(text).length).toBeLessThan(READ_BODY_MAX);
    expect(decodeReadBody(text)!.p).toHaveLength(READ_PAIRS_MAX);
  });
});

describe('channelFromReferrer: the host decides, the referrer is never sent', () => {
  it.each([
    ['linkedin.com', '/feed/', 'linkedin'],
    ['www.linkedin.com', '/', 'linkedin'],
    ['lnkd.in', '/abc', 'linkedin'],
    ['t.co', '/xyz', 'x'],
    ['x.com', '/', 'x'],
    ['mobile.x.com', '/', 'x'],
    ['twitter.com', '/', 'x'],
    ['facebook.com', '/', 'facebook'],
    ['l.facebook.com', '/l.php', 'facebook'],
    ['m.facebook.com', '/', 'facebook'],
    ['lm.facebook.com', '/', 'facebook'],
    ['t.me', '/channel', 'telegram'],
    ['web.whatsapp.com', '/', 'whatsapp'],
    ['google.com', '/', 'search'],
    ['www.google.com', '/search', 'search'],
    ['www.google.co.in', '/', 'search'],
    ['www.google.com.br', '/', 'search'],
    ['bing.com', '/', 'search'],
    ['www.bing.com', '/', 'search'],
    ['duckduckgo.com', '/', 'search'],
    ['mail.google.com', '/mail/u/0/', 'email'],
    ['comics.dreamstreamstudio.ai', '/?view=gallery', 'library'],
    ['comics.dreamstreamstudio.ai', '/?lang=hi&view=gallery', 'library'],
    ['comics.dreamstreamstudio.ai', '/library', 'library'],
    ['dreamstreamstudio.ai', '/?view=gallery', 'library'],
    ['comics.dreamstreamstudio.ai', `/c/${SLUG}`, 'direct'],
    ['comics.dreamstreamstudio.ai', '/', 'direct'],
    ['comics.dreamstreamstudio.ai', '/?view=studio', 'direct'],
    ['www.dreamstreamstudio.ai', undefined, 'direct'],
    ['comic.dreamstreamstudio.ai', '/library/', 'library'],
    ['example.org', '/', 'other'],
    ['evil-linkedin.com', '/', 'other'],
    ['linkedin.com.evil.io', '/', 'other'],
    ['notgoogle.com', '/', 'other'],
    ['google.evil.example', '/', 'other'],
    ['tx.co', '/', 'other'],
    ['comics.dreamstreamstudio.ai.evil.io', '/?view=gallery', 'other'],
    ['WWW.LinkedIn.COM.', '/', 'linkedin'],
    ['x.com:443', '/', 'x']
  ])('%s %s → %s', (host, path, channel) => {
    expect(channelFromReferrer(host, path)).toBe(channel);
  });

  it('no referrer is a direct visit', () => {
    for (const host of [undefined, null, '', '   ']) expect(channelFromReferrer(host, '/')).toBe('direct');
    expect(channelFromReferrer('not a host!', '/')).toBe('other');
  });
});

describe('?via= and ?src=', () => {
  it('reads ?via= against the read channels (linkedin included, which no share button sends)', () => {
    expect(readChannelFromSearch('?via=linkedin')).toBe('linkedin');
    expect(readChannelFromSearch('lang=hi&via=library')).toBe('library');
    expect(readChannelFromSearch(new URLSearchParams('via=up_next'))).toBe('up_next');
    expect(readChannelFromSearch('?via=LinkedIn')).toBe('linkedin');
    for (const search of ['', '?via=', '?via=myspace', '?via=linkedin%20', '?channel=linkedin']) expect(readChannelFromSearch(search)).toBeUndefined();
  });

  it('reads ?src= against the read surfaces', () => {
    expect(readSurfaceFromSearch('?src=lib.top10')).toBe('lib.top10');
    expect(readSurfaceFromSearch('via=library&src=more')).toBe('more');
    expect(readSurfaceFromSearch(new URLSearchParams('src=up_next'))).toBe('up_next');
    for (const search of ['', '?src=', '?src=lib', '?src=lib.secret', '?source=more']) expect(readSurfaceFromSearch(search)).toBeUndefined();
  });
});

describe('isKidsComic', () => {
  const cases: Array<[Parameters<typeof isKidsComic>[0], boolean]> = [
    [{ rating: 'G', kind: 'comic' }, true],
    [{ rating: 'PG', kind: 'comic' }, false],
    [{ rating: 'PG-13', kind: 'manga' }, false],
    [{ rating: undefined, kind: 'comic' }, false],
    [{ rating: 'PG-13', kind: 'storybook' }, true],
    [{ rating: 'PG', kind: 'Storybook' }, true],
    [{ rating: 'PG', kind: 'comic', audience: PUBLIC_KIDS_AUDIENCE }, true],
    [{ rating: 'PG', kind: 'comic', audience: 'adults' }, false],
    [{ rating: 'PG', kind: 'comic', audience: 'Children' }, false],
    [{ rating: 'g', kind: 'comic' }, false],
    [{}, false],
    [{ rating: null, kind: null, audience: null }, false]
  ];
  it.each(cases)('%o → %s', (input, kids) => {
    expect(isKidsComic(input)).toBe(kids);
  });
});

describe('libraryLang', () => {
  const supported = ['en', 'hi', 'te', 'ta', 'pt', 'pt-BR', 'zh-Hans'];
  it('is the first of the reader’s languages the catalogue supports, by primary language, else en', () => {
    expect(libraryLang(['te-IN', 'en-US'], supported)).toBe('te');
    expect(libraryLang(['sw', 'fr-FR', 'hi'], supported)).toBe('hi');
    expect(libraryLang(['HI-in'], supported)).toBe('hi');
    expect(libraryLang(['sw', 'fr'], supported)).toBe('en');
    expect(libraryLang([], supported)).toBe('en');
    expect(libraryLang(['te'], [])).toBe('en');
    expect(libraryLang(['*', '', 'not a tag', 42 as never, 'ta'], supported)).toBe('ta');
  });

  it('an exact tag the catalogue has wins over a same-language one; a script tag is returned as the catalogue spells it', () => {
    expect(libraryLang(['pt-BR'], supported)).toBe('pt-br');
    expect(libraryLang(['pt-PT'], supported)).toBe('pt');
    expect(libraryLang(['zh-CN'], supported)).toBe('zh-hans');
  });
});

// ── The creator's reading answer ────────────────────────────────────────────────────────────────────────────────────

const totals = { opens: 160, starts: 140, reads: 120, finishes: 60, finishPct: 50, avgReadMs: 95000, avgPages: 6.4, pageCount: 10, shares: 9 };
const insights = (): ReadInsights => ({
  counting: 'on',
  range: 7,
  kids: false,
  totals,
  previous: { ...totals, reads: 100, opens: 130 },
  daily: [
    { day: '2026-11-12', opens: 20, reads: 15, finishes: 8 },
    { day: '2026-11-13', opens: 25, reads: 18, finishes: 9 }
  ],
  funnel: { opened: 160, started: 140, read: 120, finished: 60 },
  pages: {
    reachedPct: [100, 96, 90, 88, 57, 55, 52, 50, 50, 50],
    avgMs: [9000, 8000, 24000, 9000, 9000, 8000, 2000, 9000, 9000, 7000],
    biggestDrop: { after: 4, pct: 31 },
    linger: [3, 24000],
    skim: [7, 2000, 9000]
  },
  editions: [
    { lang: 'en', reads: 90, switchedTo: 0 },
    { lang: 'hi', reads: 25, switchedTo: 12 },
    { lang: 'other', reads: 5, switchedTo: 1 }
  ],
  channels: [
    { id: 'linkedin', reads: 70 },
    { id: 'whatsapp', reads: 40 },
    { id: 'other', reads: 3 }
  ],
  sources: [
    { id: 'link', reads: 100 },
    { id: 'lib.trending', reads: 20 }
  ],
  devices: [
    { id: 'phone', reads: 90 },
    { id: 'desktop', reads: 30 }
  ]
});

describe('decodeReadInsights', () => {
  it('round-trips through JSON', () => {
    const value = insights();
    expect(decodeReadInsights(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it('drops unknown fields at every level', () => {
    const value = insights();
    const tampered = JSON.parse(JSON.stringify(value));
    Object.assign(tampered, { viewers: ['a'], slug: SLUG, userId: '00000000-0000-4000-8000-00000000000a' });
    tampered.totals.uniques = 3;
    tampered.daily[0].ip = '203.0.113.9';
    tampered.pages.raw = [[1, 2]];
    tampered.channels[0].viewers = ['x'];
    expect(decodeReadInsights(tampered)).toEqual(value);
  });

  it('refuses a breakdown bucket with fewer than K_MIN readers (only "other" may be smaller)', () => {
    const value = insights();
    const tampered = JSON.parse(JSON.stringify(value));
    tampered.channels.push({ id: 'telegram', reads: K_MIN - 1 });
    tampered.sources.push({ id: 'more', reads: 1 });
    tampered.devices.push({ id: 'tablet', reads: 4 });
    tampered.editions.push({ lang: 'te', reads: 2, switchedTo: 2 });
    const out = decodeReadInsights(tampered)!;
    expect(out.channels).toEqual(value.channels);
    expect(out.sources).toEqual(value.sources);
    expect(out.devices).toEqual(value.devices);
    expect(out.editions).toEqual(value.editions);
    expect(out.channels!.find((c) => c.id === 'other')!.reads).toBe(3);
  });

  it('drops buckets whose id is not in the vocabulary, and repeated ids', () => {
    const tampered = JSON.parse(JSON.stringify(insights()));
    tampered.channels.push({ id: 'myspace', reads: 50 }, { id: 'linkedin', reads: 50 });
    tampered.sources.push({ id: 'lib.secret', reads: 50 });
    tampered.devices.push({ id: 'fridge', reads: 50 });
    tampered.editions.push({ lang: 'english!', reads: 50, switchedTo: 0 });
    expect(decodeReadInsights(tampered)).toEqual(insights());
  });

  it('withheld: pages and the four lists are left out', () => {
    for (const withheld of ['few', 'kids'] as const) {
      const out = decodeReadInsights({ ...insights(), withheld })!;
      expect(out.withheld).toBe(withheld);
      for (const key of ['pages', 'editions', 'channels', 'sources', 'devices']) expect(out).not.toHaveProperty(key);
      expect(out.totals).toEqual(totals);
    }
  });

  it('a kids comic is always withheld as kids, and fewer than K_MIN reads always as few', () => {
    const kids = decodeReadInsights({ ...insights(), kids: true })!;
    expect(kids.withheld).toBe('kids');
    expect(kids).not.toHaveProperty('pages');
    const few = decodeReadInsights({ ...insights(), totals: { ...totals, reads: K_MIN - 1 } })!;
    expect(few.withheld).toBe('few');
    expect(few).not.toHaveProperty('channels');
    expect(decodeReadInsights({ ...insights(), totals: { ...totals, reads: K_MIN } })!.withheld).toBeUndefined();
  });

  it('is null when the core of the answer is missing or malformed', () => {
    const base = insights() as unknown as Record<string, unknown>;
    for (const over of [
      { counting: 'maybe' },
      { range: 14 },
      { range: '7' },
      { kids: 'no' },
      { totals: null },
      { totals: { ...totals, reads: -1 } },
      { totals: { ...totals, pageCount: 0 } },
      { totals: { ...totals, finishPct: 101 } },
      { funnel: { opened: 1 } }
    ]) expect(decodeReadInsights({ ...base, ...over }), JSON.stringify(over)).toBeNull();
    for (const raw of [null, 'x', [], 7]) expect(decodeReadInsights(raw)).toBeNull();
  });

  it('keeps valid days only, at most 28; previous may be null; malformed pages are left out', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ day: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, opens: 1, reads: 1, finishes: 0 }));
    const out = decodeReadInsights({ ...insights(), range: 'all', previous: null, daily: [...many, { day: 'yesterday', opens: 1, reads: 1, finishes: 1 }] })!;
    expect(out.daily).toHaveLength(28);
    expect(out.previous).toBeNull();
    expect(out.range).toBe('all');
    const badPages = decodeReadInsights({ ...insights(), pages: { reachedPct: [100, 50], avgMs: [1000] } })!;
    expect(badPages).not.toHaveProperty('pages');
    const badDrop = decodeReadInsights({ ...insights(), pages: { ...insights().pages, biggestDrop: { after: 99, pct: 31 }, linger: [0, 1], skim: 'x' } })!;
    expect(badDrop.pages).toEqual({ reachedPct: insights().pages!.reachedPct, avgMs: insights().pages!.avgMs });
  });

  it('the paths and ranges', () => {
    expect(READ_INSIGHTS_PATH('p1')).toBe('/api/comic/projects/p1/readers');
    expect(READ_INSIGHTS_PATH('a/b')).toBe('/api/comic/projects/a%2Fb/readers');
    expect(parseReadRange('7')).toBe(7);
    expect(parseReadRange('28')).toBe(28);
    expect(parseReadRange('all')).toBe('all');
    for (const v of ['14', '', undefined, 'ALL', '07']) expect(parseReadRange(v)).toBeUndefined();
    expect(READING_ADMIN_PATH).toBe('/api/comic/admin/reading');
    expect(parseReadingAdminDays('7')).toBe(7);
    expect(parseReadingAdminDays('28')).toBe(28);
    for (const v of ['all', '1', undefined]) expect(parseReadingAdminDays(v)).toBeUndefined();
  });
});

// ── The admin's reading overview ────────────────────────────────────────────────────────────────────────────────────

const overview = (): ReadingAdminOverview => ({
  counting: 'off',
  reasons: ['config_missing', 'proof_failures'],
  days: 7,
  configPresent: false,
  statsRows24h: 0,
  health: [
    { day: '2026-11-18', status: 'proof', n: 12 },
    { day: '2026-11-18', status: 'capped', n: 1 }
  ],
  jobs: [
    { name: 'comic-rank-refresh', lastRunAt: 1_763_500_000_000, status: 'succeeded', durationMs: 180 },
    { name: 'comic-reading-purge-daily' }
  ],
  pageStatsBytes: 65536,
  ranked: [{ slug: SLUG, title: 'Spice Run', score: 41.5, heat: 30, quality: 1.1, fresh: 7.7, reads7d: 12 }],
  daily: [{ day: '2026-11-18', opens: 3, reads: 2, finishes: 1 }]
});

describe('decodeReadingAdminOverview', () => {
  it('round-trips through JSON and drops unknown fields', () => {
    const value = overview();
    expect(decodeReadingAdminOverview(JSON.parse(JSON.stringify(value)))).toEqual(value);
    const tampered = JSON.parse(JSON.stringify(value));
    tampered.salt = 'x'.repeat(40);
    tampered.ranked[0].publicationId = '00000000-0000-4000-8000-00000000000a';
    tampered.jobs[0].command = 'select 1';
    expect(decodeReadingAdminOverview(tampered)).toEqual(value);
  });

  it('keeps only known statuses (never ok), jobs and reasons; counting on has no reasons', () => {
    const tampered = JSON.parse(JSON.stringify(overview()));
    tampered.health.push({ day: '2026-11-18', status: 'ok', n: 100 }, { day: '2026-11-18', status: 'weird', n: 1 });
    tampered.jobs.push({ name: 'image-asset-retention-daily', status: 'succeeded' });
    tampered.reasons.push('because');
    expect(decodeReadingAdminOverview(tampered)).toEqual(overview());
    const on = decodeReadingAdminOverview({ ...overview(), counting: 'on', configPresent: true })!;
    expect(on.reasons).toEqual([]);
  });

  it('drops ranked rows with a bad slug or numbers', () => {
    const tampered = JSON.parse(JSON.stringify(overview()));
    tampered.ranked.push({ ...tampered.ranked[0], slug: 'short' }, { ...tampered.ranked[0], slug: 'Zz3dEf6hIj9kLm2nP', score: -1 }, { ...tampered.ranked[0], slug: 'Yy3dEf6hIj9kLm2nP', reads7d: 1.5 });
    expect(decodeReadingAdminOverview(tampered)!.ranked).toEqual(overview().ranked);
    expect(SLUG_RE.test(overview().ranked[0].slug)).toBe(true);
  });

  it('is null when the core is malformed', () => {
    for (const over of [{ counting: 'yes' }, { days: 14 }, { configPresent: 'no' }]) {
      expect(decodeReadingAdminOverview({ ...overview(), ...over })).toBeNull();
    }
    expect(decodeReadingAdminOverview('x')).toBeNull();
  });

  it('names the ingest answers and the two jobs', () => {
    expect([...READ_INGEST_STATUSES]).toEqual(['ok', 'shape', 'nosalt', 'proof', 'gone', 'capped']);
    expect([...READING_JOBS]).toEqual(['comic-rank-refresh', 'comic-reading-purge-daily']);
  });
});
