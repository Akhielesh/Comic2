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
  READ_OWN_HOSTS,
  VIEWER_DWELL_CAP_PER_PAGE,
  acceptLanguageTags,
  channelFromReferrer,
  decodeReadBody,
  decodeReadInsights,
  decodeReadingAdminOverview,
  encodeReadBody,
  isKidsComic,
  libraryLang,
  libraryLangFromAcceptLanguage,
  parseReadRange,
  parseReadingAdminDays,
  readChannelFromSearch,
  readCountedEdition,
  readEditionOf,
  readSurfaceFromSearch,
  type ReadBody,
  type ReadInsights,
  type ReadingAdminOverview
} from './reading';
import { PUBLIC_KIDS_AUDIENCE, SHARE_CHANNELS, SLUG_RE } from './publication';
import { discoverLang } from './discovery';
import { LANGUAGES, matchLanguage } from './languages';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('counts an emoji (a surrogate pair) as 4 bytes: exactly 2,048 bytes is read, 2,049 is not', () => {
    const body = (emoji: number, x: number) => JSON.stringify({ v: 1, t: 'open', pad: '😀'.repeat(emoji) + 'x'.repeat(x) });
    const base = body(0, 0).length;
    const emoji = Math.floor((READ_BODY_MAX - base) / 4);
    const rest = READ_BODY_MAX - base - emoji * 4;
    const exact = body(emoji, rest);
    expect(new TextEncoder().encode(exact).length).toBe(READ_BODY_MAX);
    expect(exact.length).toBeLessThan(READ_BODY_MAX); // UTF-16 units: a unit count would read far more
    expect(decodeReadBody(exact)).toEqual({ v: 1, t: 'open' });
    const over = body(emoji, rest + 1);
    expect(new TextEncoder().encode(over).length).toBe(READ_BODY_MAX + 1);
    expect(decodeReadBody(over)).toBeNull();
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
    expect(decodeReadBody(JSON.stringify({ v: 1, t: 'open', lang: 'zh-Hans', ch: 'whatsapp' }))).toEqual({ v: 1, t: 'open', lang: 'zh-hans', ch: 'whatsapp' });
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
      lang: `abc-${'x'.repeat(8)}-${'y'.repeat(8)}`,
      ch: 'telegram',
      src: 'lib.billboard',
      dev: 'desktop',
      p: Array.from({ length: 200 }, (_, i) => [READ_PAGE_MAX - i, PAGE_MS_BATCH_CAP] as [number, number]),
      mx: READ_PAGE_MAX,
      from: `abc-${'x'.repeat(8)}-${'y'.repeat(8)}`
    })!;
    expect(new TextEncoder().encode(text).length).toBeLessThan(READ_BODY_MAX);
    const decoded = decodeReadBody(text)!;
    expect(decoded.p).toHaveLength(READ_PAIRS_MAX);
    expect(decoded.lang).toBe(`abc-${'x'.repeat(8)}-${'y'.repeat(8)}`);
  });
});

describe('the edition a read counts under: one key per published edition', () => {
  const editions = ['en', 'hi', 'zh-Hans'];

  it('decodes lang and from in lower case, so a re-cased tag is the same key', () => {
    expect(decodeReadBody('{"v":1,"t":"lang","lang":"ZH-HANS","from":"EN"}')).toEqual({ v: 1, t: 'lang', lang: 'zh-hans', from: 'en' });
    expect(decodeReadBody('{"v":1,"t":"open","lang":"zh-Hans"}')!.lang).toBe(decodeReadBody('{"v":1,"t":"open","lang":"ZH-HANS"}')!.lang);
    expect(JSON.parse(encodeReadBody({ v: 1, t: 'open', lang: 'Hi-IN' })!)).toEqual({ v: 1, t: 'open', lang: 'hi-in' });
  });

  it('takes the same language shape as Discover and the SQL guard (at most three subtags, 35 characters)', () => {
    for (const tag of ['en', 'pt-BR', 'zh-Hans', 'sr-Latn-RS', 'qq-zzzz-yyyy-xxxx', 'aaa-bbbbbbbb-cccccccc-dddddddd', 'en_US', 'e', `en-${'x'.repeat(40)}`, 'english!']) {
      const body = decodeReadBody(JSON.stringify({ v: 1, t: 'lang', lang: tag, from: tag }));
      expect(body?.lang, tag).toBe(discoverLang(tag));
      expect(body?.from, tag).toBe(discoverLang(tag));
    }
  });

  it('readEditionOf: the published edition, matched without case; any other tag is none', () => {
    expect(readEditionOf('ZH-HANS', editions)).toBe('zh-hans');
    expect(readEditionOf('zh-hans', editions)).toBe('zh-hans');
    expect(readEditionOf('HI', editions)).toBe('hi');
    for (const lang of ['qq-zzzz-yyyy', 'zh-CN', 'hi-IN', 'te', '', undefined, null, 42, 'en '])
      expect(readEditionOf(lang, editions), String(lang)).toBeUndefined();
    expect(readEditionOf('en', [])).toBeUndefined();
    expect(readEditionOf('en', ['english!', 7 as never])).toBeUndefined();
  });

  it('readCountedEdition: the read’s own edition, else the default edition, else the original; never an invented tag', () => {
    expect(readCountedEdition('HI', editions, 'en')).toBe('hi');
    expect(readCountedEdition('qq-zzzz-yyyy', editions, 'hi')).toBe('hi');
    expect(readCountedEdition(undefined, editions, 'zh-Hans')).toBe('zh-hans');
    expect(readCountedEdition('xx', editions)).toBe('en');
    expect(readCountedEdition('xx', editions, 'te')).toBe('en'); // a default that is not published is no default
    expect(readCountedEdition('en', [])).toBeUndefined();
    // However many tags a client invents, one comic only ever has its published editions as keys.
    const keys = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const body = decodeReadBody(JSON.stringify({ v: 1, t: 'read', lang: `q${String.fromCharCode(97 + (i % 26))}-x${i}`, p: [[1, 1000]] }))!;
      keys.add(readCountedEdition(body.lang, editions, 'en')!);
      keys.add(readCountedEdition(['EN', 'Hi', 'ZH-HANS'][i % 3], editions, 'en')!);
    }
    expect([...keys].sort()).toEqual(['en', 'hi', 'zh-hans']);
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
    ['outlook.live.com', '/mail/0/', 'email'],
    ['outlook.office.com', '/', 'email'],
    ['mail.yahoo.com', '/', 'email'],
    ['www.google.co.uk', '/', 'search'],
    ['google.de', '/', 'search'],
    ['docs.google.com', '/document/d/x', 'other'],
    ['drive.google.com', '/', 'other'],
    ['sites.google.com', '/view/x', 'other'],
    ['groups.google.com', '/', 'other'],
    ['com.linkedin.android', '', 'linkedin'],
    ['com.google.android.gm', '', 'email'],
    ['com.google.android.googlequicksearchbox', '', 'search'],
    ['com.whatsapp', '', 'whatsapp'],
    ['org.telegram.messenger', '', 'telegram'],
    ['com.twitter.android', '', 'x'],
    ['com.facebook.katana', '', 'facebook'],
    ['com.linkedin.android.evil', '', 'other'],
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

  it('our own hosts are one list: the edge’s Origin check holds exactly these, or imports them', () => {
    expect([...READ_OWN_HOSTS].sort()).toEqual(['comic.dreamstreamstudio.ai', 'comics.dreamstreamstudio.ai', 'dreamstreamstudio.ai', 'www.dreamstreamstudio.ai']);
    for (const host of READ_OWN_HOSTS) expect(['library', 'direct']).toContain(channelFromReferrer(host, '/'));
    const edge = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../api-proxy/src/publicComic.ts'), 'utf8');
    if (!/\bREAD_OWN_HOSTS\b/.test(edge)) {
      const literal = /const SITE_HOSTS = new Set\(\[([^\]]*)\]\)/.exec(edge);
      expect(literal, 'publicComic.ts keeps its own host list: import READ_OWN_HOSTS instead').not.toBeNull();
      const hosts = [...literal![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
      expect(hosts).toEqual([...READ_OWN_HOSTS].sort());
    }
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
  const supported = ['en', 'hi', 'te', 'ta', 'pt', 'zh-Hans'];
  it('is the first of the reader’s languages the catalogue supports, else en', () => {
    expect(libraryLang(['te-IN', 'en-US'], supported)).toBe('te');
    expect(libraryLang(['sw', 'fr-FR', 'hi'], supported)).toBe('hi');
    expect(libraryLang(['sw', 'hi'], supported)).toBe('hi');
    expect(libraryLang(['HI-in'], supported)).toBe('hi');
    expect(libraryLang(['sw', 'fr'], supported)).toBe('en');
    expect(libraryLang([], supported)).toBe('en');
    expect(libraryLang(['te'], [])).toBe('en');
    expect(libraryLang(['*', '', 'not a tag', 42 as never, 'ta'], supported)).toBe('ta');
  });

  it('uses the app’s one language rule (languages.ts): Traditional Chinese is not Simplified, Shahmukhi is not Gurmukhi', () => {
    expect(libraryLang(['zh-TW'], ['en', 'zh-Hans'])).toBe('en');
    expect(libraryLang(['zh-Hant', 'hi'], ['en', 'hi', 'zh-Hans'])).toBe('hi');
    expect(libraryLang(['pa-Arab'], ['en', 'pa'])).toBe('en');
    expect(libraryLang(['pa-Arab'])).toBe('en');
    expect(libraryLang(['zh-CN'], supported)).toBe('zh-hans');
    expect(libraryLang(['zh'])).toBe('zh-hans');
    expect(libraryLang(['pt-BR'], supported)).toBe('pt');
  });

  it('agrees with matchLanguage (the share page’s rule) for every reader, answered as the lower-case your_lang', () => {
    const codes = LANGUAGES.map((l) => l.code);
    const prefs = [['zh-TW'], ['pa-Arab'], ['pa-IN'], ['ur-PK'], ['zh-CN', 'en'], ['ja-JP'], ['sw', 'hi'], ['es-419'], ['de-CH', 'fr'], ['mr'], []];
    for (const p of prefs) expect(libraryLang(p), p.join(',')).toBe((matchLanguage(p, codes) ?? 'en').toLowerCase());
  });

  it('reads Accept-Language (the edge preload) to the same answer as navigator.languages', () => {
    expect(acceptLanguageTags('te-IN,te;q=0.9,en-US;q=0.8,en;q=0.7')).toEqual(['te-IN', 'te', 'en-US', 'en']);
    expect(acceptLanguageTags('en;q=0.1, hi, *;q=0.5, fr;q=0')).toEqual(['hi', 'en']);
    expect(acceptLanguageTags('de;q=0.8, ja;q=0.8, ko;q=bad')).toEqual(['de', 'ja']);
    for (const empty of ['', '   ', '*', null, undefined]) expect(acceptLanguageTags(empty)).toEqual([]);
    expect(acceptLanguageTags(Array.from({ length: 40 }, (_, i) => `x${i}`).join(','))).toHaveLength(20);
    const cases: Array<[string, string[]]> = [
      ['te-IN,te;q=0.9,en-US;q=0.8', ['te-IN', 'te', 'en-US']],
      ['zh-TW,zh;q=0.9', ['zh-TW', 'zh']],
      ['zh-TW', ['zh-TW']],
      ['pa-Arab-PK,ur;q=0.8', ['pa-Arab-PK', 'ur']],
      ['sw,hi;q=0.5', ['sw', 'hi']],
      ['', []]
    ];
    for (const [header, langs] of cases) expect(libraryLangFromAcceptLanguage(header), header).toBe(libraryLang(langs));
    expect(libraryLangFromAcceptLanguage('zh-TW')).toBe('en');
    expect(libraryLangFromAcceptLanguage('zh-TW,zh;q=0.9')).toBe('zh-hans');
    expect(libraryLangFromAcceptLanguage('ur-PK,en;q=0.5')).toBe('ur');
    expect(libraryLangFromAcceptLanguage(null)).toBe('en');
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
    { lang: 'en', reads: 90 },
    { lang: 'hi', reads: 25, switchedTo: 12 },
    { lang: 'other', reads: 5 }
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

  it('a switch count under K_MIN is left out, on every edition and on other (never 1-4 readers, never a telling 0)', () => {
    const raw = JSON.parse(JSON.stringify(insights()));
    raw.editions = [
      { lang: 'hi', reads: 5, switchedTo: 1 },
      { lang: 'en', reads: 9, switchedTo: K_MIN },
      { lang: 'te', reads: 6, switchedTo: 0 },
      { lang: 'ta', reads: 7 },
      { lang: 'other', reads: 1, switchedTo: K_MIN - 1 }
    ];
    expect(decodeReadInsights(raw)!.editions).toEqual([
      { lang: 'hi', reads: 5 },
      { lang: 'en', reads: 9, switchedTo: K_MIN },
      { lang: 'te', reads: 6 },
      { lang: 'ta', reads: 7 },
      { lang: 'other', reads: 1 }
    ]);
    raw.editions = [{ lang: 'hi', reads: 9, switchedTo: -1 }, { lang: 'en', reads: 9, switchedTo: 'x' }];
    expect(decodeReadInsights(raw)!.editions).toEqual([]);
  });

  it('keeps each edition once (in lower case, the read key), at most 20', () => {
    const raw = JSON.parse(JSON.stringify(insights()));
    raw.editions = [
      { lang: 'hi', reads: 25, switchedTo: 12 },
      { lang: 'hi', reads: 99, switchedTo: 50 },
      { lang: 'ZH-HANS', reads: 8 },
      { lang: 'zh-hans', reads: 30 },
      { lang: 'other', reads: 3 },
      { lang: 'other', reads: 40 }
    ];
    expect(decodeReadInsights(raw)!.editions).toEqual([
      { lang: 'hi', reads: 25, switchedTo: 12 },
      { lang: 'zh-hans', reads: 8 },
      { lang: 'other', reads: 3 }
    ]);
    raw.editions = Array.from({ length: 30 }, (_, i) => ({ lang: `q${String.fromCharCode(97 + i)}`, reads: 9 }));
    expect(decodeReadInsights(raw)!.editions).toHaveLength(20);
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

  it('keeps each job and each ranked comic once (the first), at most 100 ranked rows', () => {
    const tampered = JSON.parse(JSON.stringify(overview()));
    tampered.jobs.push({ name: 'comic-rank-refresh', status: 'failed', durationMs: 9 }, { name: 'comic-reading-purge-daily', status: 'failed' });
    tampered.ranked.push({ ...tampered.ranked[0], title: 'Copy', score: 99 });
    const out = decodeReadingAdminOverview(tampered)!;
    expect(out.jobs).toEqual(overview().jobs);
    expect(out.ranked).toEqual(overview().ranked);
    const many = JSON.parse(JSON.stringify(overview()));
    many.ranked = Array.from({ length: 130 }, (_, i) => ({ ...overview().ranked[0], slug: `Rk3dEf6hIj9kLm${String(i).padStart(3, '0')}` }));
    expect(decodeReadingAdminOverview(many)!.ranked).toHaveLength(100);
  });

  it('keeps at most 28 days × 5 statuses = 140 health rows', () => {
    const tampered = JSON.parse(JSON.stringify(overview()));
    tampered.health = Array.from({ length: 200 }, (_, i) => ({ day: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, status: 'proof', n: i }));
    const out = decodeReadingAdminOverview(tampered)!;
    expect(out.health).toHaveLength(140);
    expect(out.health[139].n).toBe(139);
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
