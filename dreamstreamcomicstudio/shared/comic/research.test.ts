import { describe, expect, it } from 'vitest';
import { LANGUAGES } from './languages.js';
import {
  ATTACHABLE_LICENCES, WIKI_HOSTS, attachableLicence, commonsThumbnail, guardResearchSubject, isAttachable, licenceKind, normalizeComicResearch,
  normalizeResearchSource, normalizeResearchState, pinnedSourceUrls, scriptLanguage, wikiHostFor, wikiLanguageOf
} from './research.js';

const article = { title: 'Kyōto Station', source: 'https://en.wikipedia.org/wiki/Ky%C5%8Dto_Station', description: 'Railway station' };
const image = {
  title: 'Station exterior', source: 'https://commons.wikimedia.org/wiki/File%3AStation.jpg',
  thumbnail: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/99/Station.jpg/320px-Station.jpg',
  license: 'CC BY-SA 4.0', credit: 'Photographer'
};
const response = (articles: unknown[] = [article], images: unknown[] = [image]) => ({ articles, images, incomplete: false });

describe('stored comic research', () => {
  it('bounds results, keeps attribution, and removes markup and tracking', () => {
    const result = normalizeComicResearch(response(
      Array.from({ length: 10 }, () => ({ ...article, title: '<b>Kyōto\n Station</b>', source: `${article.source}?tracking=x#section`, description: 'x'.repeat(300) })),
      Array.from({ length: 10 }, () => ({ ...image, thumbnail: `${image.thumbnail}?tracking=x`, credit: '<b>Photographer</b>' }))
    ))!;
    expect(result.articles).toHaveLength(4);
    expect(result.images).toHaveLength(6);
    expect(result.articles[0]).toEqual({ ...article, description: 'x'.repeat(260) });
    expect(result.images[0]).toEqual(image);
    expect(normalizeComicResearch(result)).toEqual(result);
  });

  it('rejects unsafe article links and never keeps article-supplied thumbnails', () => {
    const sources = ['javascript:alert(1)', 'http://en.wikipedia.org/wiki/Kyoto', 'https://en.wikipedia.org.evil.test/wiki/Kyoto',
      'https://user@en.wikipedia.org/wiki/Kyoto', 'https://en.wikipedia.org:444/wiki/Kyoto',
      'https://en.wikipedia.org/w/api.php', 'https://en.wikipedia.org/wiki/', 'https://en.wikipedia.org/wiki/%00',
      'https://commons.wikimedia.org/wiki/File:Kyoto.jpg'];
    for (const source of sources) expect(normalizeComicResearch(response([{ ...article, source }], []))?.articles).toEqual([]);
    expect(normalizeComicResearch(response([{ ...article, thumbnail: 'https://evil.test/image.png' }], []))?.articles).toEqual([article]);
  });

  it('rejects unsafe image links, thumbnail paths, licenses, and missing attribution', () => {
    const rejected = [
      { ...image, source: 'https://commons.wikimedia.org.evil.test/wiki/File:Station.jpg' },
      { ...image, source: 'https://commons.wikimedia.org/wiki/Station' },
      { ...image, thumbnail: 'https://upload.wikimedia.org/wikipedia/en/thumb/Station.jpg' },
      { ...image, thumbnail: 'https://evil.test/wikipedia/commons/thumb/Station.jpg' },
      { ...image, credit: '' },
      { ...image, license: 'CC BY-NC 4.0' },
      { ...image, license: 'CC BY-ND 4.0' },
      { ...image, license: 'All rights reserved' }
    ];
    for (const entry of rejected) expect(normalizeComicResearch(response([], [entry]))?.images).toEqual([]);
    expect(normalizeComicResearch(response([], [{ ...image, license: 'CC0 1.0', credit: '' }, { ...image, license: 'Public domain', credit: '' }]))?.images).toHaveLength(2);
    expect(commonsThumbnail(image.thumbnail.replace('thumb.wikimedia.org', 'upload.wikimedia.org'))).toBe(image.thumbnail.replace('thumb.wikimedia.org', 'upload.wikimedia.org'));
    expect(commonsThumbnail('https://thumb.wikimedia.org/wikipedia/commons/thumb/')).toBeUndefined();
  });

  it('distinguishes malformed envelopes from valid empty or partial results', () => {
    for (const value of [null, [], {}, { articles: [], images: [] }, { articles: {}, images: [], incomplete: false }]) {
      expect(normalizeComicResearch(value)).toBeUndefined();
    }
    expect(normalizeComicResearch(response([], []))).toEqual(response([], []));
    expect(normalizeComicResearch({ ...response([null, 1, article], [null]), incomplete: true })).toEqual({ articles: [article], images: [], incomplete: true });
  });
});

describe('wiki hosts from the language registry', () => {
  it('maps every registry language to its own Wikipedia, zh-Hans to zh', () => {
    expect(Object.keys(WIKI_HOSTS).sort()).toEqual(LANGUAGES.map((l) => l.code).sort());
    expect(WIKI_HOSTS.te).toBe('te.wikipedia.org');
    expect(WIKI_HOSTS['zh-Hans']).toBe('zh.wikipedia.org');
    expect(wikiHostFor('te-IN')).toBe('te.wikipedia.org');
    expect(wikiHostFor('zh-CN')).toBe('zh.wikipedia.org');
    expect(wikiHostFor('or')).toBeUndefined();
    expect(wikiLanguageOf('hi.wikipedia.org')).toBe('hi');
    expect(wikiLanguageOf('zh.wikipedia.org')).toBe('zh-Hans');
    expect(wikiLanguageOf('or.wikipedia.org')).toBeUndefined();
  });

  it('accepts articles on exactly those hosts and rejects look-alikes', () => {
    const te = { title: 'రామాయణం', source: 'https://te.wikipedia.org/wiki/%E0%B0%B0%E0%B0%BE%E0%B0%AE%E0%B0%BE%E0%B0%AF%E0%B0%A3%E0%B0%82' };
    expect(normalizeComicResearch(response([te], []))?.articles).toEqual([{ ...te, lang: 'te' }]);
    expect(normalizeComicResearch(response([{ ...article, source: 'https://zh.wikipedia.org/wiki/Kyoto' }], []))?.articles[0].lang).toBe('zh-Hans');
    const rejected = [
      'https://hi.wikipedia.org.evil.com/wiki/Ramayana', 'http://hi.wikipedia.org/wiki/Ramayana', 'https://hi.wikipedia.org:8443/wiki/Ramayana',
      'https://hi.wikipedia.org/w/index.php?title=Ramayana', 'https://or.wikipedia.org/wiki/Ramayana', 'https://simple.wikipedia.org/wiki/Ramayana',
      'https://en.m.wikipedia.org/wiki/Ramayana', 'https://wikipedia.org/wiki/Ramayana', 'https://commons.wikimedia.org/wiki/File:Ramayana.jpg'
    ];
    for (const source of rejected) expect(normalizeComicResearch(response([{ ...article, source }], []))?.articles, source).toEqual([]);
    for (const source of ['https://te.wikipedia.org/wiki/File:Rama.jpg', 'https://commons.wikimedia.org.evil.com/wiki/File:Rama.jpg', 'http://commons.wikimedia.org/wiki/File:Rama.jpg']) {
      expect(normalizeComicResearch(response([], [{ ...image, source }]))?.images, source).toEqual([]);
    }
  });

  it('keeps an English article without a lang key (stored cards stay as they were) and replaces a lang that contradicts the host', () => {
    expect(normalizeComicResearch(response([article], []))?.articles[0]).toEqual(article);
    expect(normalizeComicResearch(response([{ ...article, lang: 'en' }], []))?.articles[0]).toEqual({ ...article, lang: 'en' });
    expect(normalizeComicResearch(response([{ ...article, lang: 'te' }], []))?.articles[0]).toEqual(article);
    const hi = { title: 'रामायण', source: 'https://hi.wikipedia.org/wiki/Ramayan', lang: 'mr' };
    expect(normalizeComicResearch(response([hi], []))?.articles[0].lang).toBe('hi');
  });
});

describe('article extracts', () => {
  it('keeps an extract up to 600 characters, without tags or control characters', () => {
    const extract = `<p>The <b>Ramayana</b> is an epic.</p>\u0007‮ ${'x'.repeat(700)}`;
    const [result] = normalizeComicResearch(response([{ ...article, extract }], []))!.articles;
    expect(result.extract).toHaveLength(600);
    expect(result.extract!.startsWith('The Ramayana is an epic. x')).toBe(true);
    expect(result.extract).not.toMatch(/[<>\u0000-\u001f‮]/);
    expect(normalizeComicResearch(response([{ ...article, extract: '  ' }], []))?.articles[0]).toEqual(article);
    expect(normalizeComicResearch(response([], [{ ...image, extract: 'not for pictures' }]))?.images[0]).not.toHaveProperty('extract');
  });
});

describe('which pictures may be attached', () => {
  const kinds = { 'CC0': true, 'CC0 1.0': true, 'CC-0': true, 'Public domain': true, 'public domain': true, 'CC BY 4.0': false, 'CC BY 2.0': false, 'CC BY-SA 4.0': false, 'CC BY-SA 3.0': false };
  it('attaches only CC0 and public-domain pictures (ATTACHABLE_LICENCES), never CC BY or CC BY-SA', () => {
    expect([...ATTACHABLE_LICENCES]).toEqual(['cc0', 'public-domain']);
    for (const [license, attachable] of Object.entries(kinds)) {
      expect(attachableLicence(license), license).toBe(attachable);
      const [result] = normalizeComicResearch(response([], [{ ...image, license }]))!.images;
      expect(result, license).toBeDefined();
      expect(isAttachable(result), license).toBe(attachable);
    }
    expect(licenceKind('CC BY-SA 4.0')).toBe('cc-by-sa');
    expect(licenceKind('CC BY 4.0')).toBe('cc-by');
    expect(licenceKind('CC BY-NC 4.0')).toBeUndefined();
    expect(attachableLicence(undefined)).toBe(false);
    expect(isAttachable({ ...article } as { thumbnail?: string; license?: string })).toBe(false);
    expect(isAttachable({ ...image, license: 'CC0', thumbnail: undefined })).toBe(false);
  });

  it('decides from the licence on every read: a stored flag cannot make a CC BY-SA picture attachable', () => {
    const [stored] = normalizeComicResearch(response([], [{ ...image, attachable: true }]))!.images;
    expect(stored).not.toHaveProperty('attachable');
    expect(isAttachable(stored)).toBe(false);
  });
});

const telugu = 'https://te.wikipedia.org/wiki/%E0%B0%B0%E0%B0%BE%E0%B0%AE%E0%B0%BE%E0%B0%AF%E0%B0%A3%E0%B0%82';

describe('research sources and state (the doc contract, inert until used)', () => {
  const source = { kind: 'article', title: 'Ramayana', url: 'https://en.wikipedia.org/wiki/Ramayana', lang: 'en', extract: 'An epic.', origin: 'auto' };
  const picture = { kind: 'image', title: 'Rama and Sita', url: 'https://commons.wikimedia.org/wiki/File:Rama.jpg', lang: 'en', license: 'Public domain', origin: 'pinned' };

  it('normalizes a source through the same allowlist and bounds', () => {
    expect(normalizeResearchSource(source)).toEqual(source);
    expect(normalizeResearchSource(picture)).toEqual(picture);
    expect(normalizeResearchSource({ ...source, url: telugu, lang: 'en' })).toEqual({ ...source, url: telugu, lang: 'te' });
    const long = normalizeResearchSource({ ...source, title: `<i>${'t'.repeat(200)}</i>`, extract: 'e'.repeat(700), license: 'CC BY-SA 4.0', credit: 'c'.repeat(200), extra: 1 })!;
    expect(long.title).toHaveLength(160);
    expect(long.extract).toHaveLength(600);
    expect(long.credit).toHaveLength(160);
    expect(long).not.toHaveProperty('extra');
    expect(normalizeResearchSource({ ...picture, extract: 'x' })).toEqual(picture);
    expect(normalizeResearchSource({ ...picture, lang: 'xx' })).toEqual({ ...picture, lang: 'en' });
    const rejected = [
      null, 'x', { ...source, kind: 'video' }, { ...source, origin: 'user' }, { ...source, title: ' ' }, { ...source, url: 'http://en.wikipedia.org/wiki/Ramayana' },
      { ...source, url: 'https://en.wikipedia.org.evil.com/wiki/Ramayana' }, { ...source, url: `https://en.wikipedia.org/wiki/${'a'.repeat(2100)}` },
      { ...source, kind: 'image' }, { ...picture, kind: 'article' }, { ...picture, license: 'CC BY-NC 4.0' }, { ...picture, license: 'CC BY 4.0' }
    ];
    for (const value of rejected) expect(normalizeResearchSource(value), JSON.stringify(value)?.slice(0, 80)).toBeUndefined();
    expect(normalizeResearchSource({ ...picture, license: 'CC BY 4.0', credit: 'Painter' })).toEqual({ ...picture, license: 'CC BY 4.0', credit: 'Painter' });
  });

  it('normalizes the state: subject guarded, at most 8 sources (the oldest automatic ones go first), lookups 0..8', () => {
    expect(normalizeResearchState(undefined)).toBeUndefined();
    expect(normalizeResearchState([])).toBeUndefined();
    expect(normalizeResearchState({})).toEqual({ sources: [], lookups: 0 });
    expect(normalizeResearchState({ subject: '  Ramayana ', sources: [source], lookups: 2, lookedUp: 'Ramayana|te' })).toEqual({ subject: 'Ramayana', sources: [source], lookups: 2, lookedUp: 'Ramayana|te' });
    expect(normalizeResearchState({ subject: 'mail me@example.com', lookups: 99, lookedUp: 'l'.repeat(100) })).toEqual({ sources: [], lookups: 8, lookedUp: 'l'.repeat(80) });
    expect(normalizeResearchState({ lookups: -3.5 })?.lookups).toBe(0);
    expect(normalizeResearchState({ lookups: 2.7 })?.lookups).toBe(2);
    expect(normalizeResearchState({ lookups: 'many' })?.lookups).toBe(0);
    const url = (i: number) => `https://en.wikipedia.org/wiki/Source_${i}`;
    const many = Array.from({ length: 11 }, (_, i) => ({ ...source, url: url(i), origin: i % 3 === 0 ? 'pinned' : 'auto' }));
    const kept = normalizeResearchState({ sources: [...many, { ...source, url: url(1) }, { title: 'broken' }] })!.sources;
    expect(kept).toHaveLength(8);
    expect(kept.map((s) => s.url)).toEqual([0, 3, 5, 6, 7, 8, 9, 10].map(url));
    const allPinned = Array.from({ length: 10 }, (_, i) => ({ ...source, url: url(i), origin: 'pinned' }));
    expect(normalizeResearchState({ sources: allPinned })!.sources.map((s) => s.url)).toEqual([2, 3, 4, 5, 6, 7, 8, 9].map(url));
  });

  it('reads the pinned source URLs defensively from any doc', () => {
    for (const doc of [undefined, null, 1, {}, { research: null }, { research: { sources: 'x' } }]) expect(pinnedSourceUrls(doc).size).toBe(0);
    const urls = pinnedSourceUrls({ research: { sources: [source, picture, { ...source, url: telugu, origin: 'pinned' }, { ...picture, url: 'https://evil.test/x', origin: 'pinned' }] } });
    expect([...urls]).toEqual([picture.url, telugu]);
  });

  it('keeps one entry per URL at its first place, and a pin is never lost to an automatic copy', () => {
    const other = { ...source, url: 'https://en.wikipedia.org/wiki/Lanka' };
    const pinnedCopy = { ...source, title: 'Ramayana (pinned)', extract: 'The creator’s pick.', origin: 'pinned' };
    expect(normalizeResearchState({ sources: [source, pinnedCopy] })!.sources).toEqual([pinnedCopy]);
    expect(normalizeResearchState({ sources: [source, other, pinnedCopy] })!.sources).toEqual([pinnedCopy, other]);
    expect(normalizeResearchState({ sources: [pinnedCopy, source] })!.sources).toEqual([pinnedCopy]);
    expect(normalizeResearchState({ sources: [pinnedCopy, { ...pinnedCopy, title: 'Later pin' }] })!.sources).toEqual([pinnedCopy]);
    expect(normalizeResearchState({ sources: [source, { ...source, title: 'Later auto' }] })!.sources).toEqual([source]);
    expect([...pinnedSourceUrls({ research: { sources: [source, pinnedCopy] } })]).toEqual([source.url]);
  });

  it('says "pinned" for exactly the sources the comic keeps (the same normalizer, the same cap)', () => {
    const url = (i: number) => `https://en.wikipedia.org/wiki/Pin_${i}`;
    const research = { sources: Array.from({ length: 10 }, (_, i) => ({ ...source, url: url(i), origin: 'pinned' })) };
    const kept = normalizeResearchState(research)!.sources.map((s) => s.url);
    expect([...pinnedSourceUrls({ research })]).toEqual(kept);
    expect(kept).toHaveLength(8);
  });
});

describe('guardResearchSubject', () => {
  const cases: Array<[string, string | false, string?]> = [
    ['Ramayana', 'Ramayana'],
    ['  Edo-period   Kyoto ', 'Edo-period Kyoto'],
    ['రామాయణం', 'రామాయణం'],
    ['World War I 1914-1918', 'World War I 1914-1918'],
    ['Edo period 1603 1868', 'Edo period 1603 1868'],
    ['Apollo 11', 'Apollo 11'],
    ['x', false, 'length'],
    [' ', false, 'length'],
    ['a'.repeat(61), false, 'length'],
    ['one two three four five six seven', false, 'words'],
    ['one two three four five six', 'one two three four five six'],
    ['ravi@example.com', false, 'email'],
    ['Ravi ＠ home', false, 'email'],
    ['https://example.com/ramayana', false, 'link'],
    ['www.ramayana.com', false, 'link'],
    ['HTTP story', false, 'link'],
    ['Flat 123456 story', false, 'number'],
    ['call 555-123-4567', false, 'phone'],
    ['(555) 123 4567', false, 'phone'],
    ['+91 98 76 54 32', false, 'phone'],
    ['1234-5678', false, 'phone'],
    ['Ramayana\nKyoto', false, 'control'],
    ['Rama‮yana', false, 'control'],
    ['Ramayana with Priya', false, 'blocked_name'],
    ['ramayana with PRIYA SHARMA', false, 'blocked_name'],
    // Invisible characters hide a name from the compare: refused, never folded away and sent.
    ['Ramayana with Pri​ya', false, 'control'], // zero-width space
    ['Ramayana with Pri­ya', false, 'control'], // soft hyphen
    ['Ramayana with Pri⁠ya', false, 'control'], // word joiner
    ['Ramayana with Pri‌ya', false, 'control'], // ZWNJ between Latin letters
    ['Ramayana with Pri‍ya', false, 'control'], // ZWJ between Latin letters
    ['Rama‏yana', false, 'control'], // right-to-left mark
    ['Rama﻿yana', false, 'control'], // zero-width no-break space inside the text
    ['Ramayana Priㅤya', false, 'control'], // Hangul filler (a blank letter)
    ['Ramayana with Ｐｒｉｙａ', false, 'blocked_name'], // fullwidth letters
    // A joiner inside an Indic or Arabic-script word is spelling.
    ['క్‍ష', 'క్‍ష'], // Telugu conjunct with ZWJ
    ['അവന്‍', 'അവന്‍'], // Malayalam chillu written with ZWJ, at the end
    ['کتاب‌خانہ', 'کتاب‌خانہ'], // Arabic-script non-joiner
    // Bare domains, short links and every form of the at sign.
    ['ravi-sharma.com', false, 'link'],
    ['mysite.in/about', false, 'link'],
    ['t.me/someone', false, 'link'],
    ['visit example.com.', false, 'link'],
    ['ｈｔｔｐ story', false, 'link'],
    ['Ravi﹫home', false, 'email'],
    ['St. Louis', 'St. Louis'],
    ['U.S. Civil War', 'U.S. Civil War'],
    ['Washington D.C.', 'Washington D.C.'],
    ['J.R.R. Tolkien', 'J.R.R. Tolkien'],
    ['Fate/stay night', 'Fate/stay night'],
    ['World War I 1914/1918', 'World War I 1914/1918']
  ];
  it.each(cases)('%j', (text, subject, reason) => {
    const check = guardResearchSubject(text, { blockedNames: ['Priya', '', ' ', 'a'] });
    expect(check).toEqual(subject === false ? { ok: false, reason } : { ok: true, subject });
  });

  it('refuses anything that is not text and works without blocked names', () => {
    expect(guardResearchSubject(undefined as unknown as string)).toEqual({ ok: false, reason: 'length' });
    expect(guardResearchSubject('Ramayana with Priya')).toEqual({ ok: true, subject: 'Ramayana with Priya' });
  });

  it('folds blocked names the same way: fullwidth, zero-width and joiner spellings of a name still match', () => {
    expect(guardResearchSubject('Ramayana with priya', { blockedNames: ['Ｐｒｉｙａ'] })).toEqual({ ok: false, reason: 'blocked_name' });
    expect(guardResearchSubject('Ramayana with priya', { blockedNames: ['Pri​ya'] })).toEqual({ ok: false, reason: 'blocked_name' });
    // A Telugu name typed with a joiner in the subject and without one in the cast list (and the other way round).
    expect(guardResearchSubject('రామాయణం ప్‌రియ', { blockedNames: ['ప్రియ'] })).toEqual({ ok: false, reason: 'blocked_name' });
    expect(guardResearchSubject('రామాయణం ప్రియ', { blockedNames: ['ప్‍రియ'] })).toEqual({ ok: false, reason: 'blocked_name' });
    expect(guardResearchSubject('రామాయణం', { blockedNames: ['ప్రియ'] })).toEqual({ ok: true, subject: 'రామాయణం' });
  });
});

describe('scriptLanguage', () => {
  const cases: Array<[string, string | undefined]> = [
    ['రామాయణం', 'te'], ['இராமாயணம்', 'ta'], ['ರಾಮಾಯಣ', 'kn'], ['രാമായണം', 'ml'], ['રામાયણ', 'gu'], ['ਰਾਮਾਇਣ', 'pa'], ['রামায়ণ', 'bn'],
    ['라마야나', 'ko'], ['きょうと', 'ja'], ['カタカナ', 'ja'], ['京都の駅', 'ja'],
    ['रामायण', undefined], ['رامايانا', undefined], ['رامائن', undefined], ['京都', undefined], ['Ramayana', undefined], ['Ramayana రామ', undefined],
    ['', undefined], ['1914 - 1918', undefined], ['రామాయణం Kyoto', 'te']
  ];
  it.each(cases)('%j → %s', (text, lang) => expect(scriptLanguage(text)).toBe(lang));
});
