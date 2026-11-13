import { describe, expect, it } from 'vitest';
import { commonsThumbnail, normalizeComicResearch } from './research.js';

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
