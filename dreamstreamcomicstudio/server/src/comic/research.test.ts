import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseComicResearch, searchComicResearch } from './research.js';

afterEach(() => vi.unstubAllGlobals());

const thumbnail = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/99/Kyoto.jpg/320px-Kyoto.jpg';

describe('comic research', () => {
  it('returns source links and attribution and rejects non-Wikimedia and uncredited images', () => {
    const image = { mime: 'image/jpeg', thumburl: `${thumbnail}?utm_source=commons`, extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: '<b>Photographer</b>' } } };
    const response = parseComicResearch({ pages: [{ key: 'Kyōto_Station', title: 'Kyōto Station', description: 'Railway station' }] }, {
      query: { pages: [
        { title: 'File:Uncredited.jpg', imageinfo: [{ ...image, extmetadata: { LicenseShortName: { value: 'CC BY 4.0' } } }] },
        { title: 'File:Unsafe.jpg', imageinfo: [{ ...image, thumburl: thumbnail.replace('thumb.wikimedia.org', 'example.com') }] },
        { title: 'File:Kyoto.jpg', imageinfo: [image] }
      ] }
    });
    expect(response.articles).toEqual([{ title: 'Kyōto Station', source: 'https://en.wikipedia.org/wiki/Ky%C5%8Dto_Station', description: 'Railway station' }]);
    expect(response.images).toEqual([{ title: 'Kyoto', source: 'https://commons.wikimedia.org/wiki/File%3AKyoto.jpg', thumbnail, credit: 'Photographer', license: 'CC BY-SA 4.0' }]);
  });

  it('coalesces identical searches and serves available results when one source fails', async () => {
    const fetcher = vi.fn(async (url: string) => url.includes('wikipedia.org')
      ? Response.json({ pages: [{ key: 'Railway', title: 'Railway' }] })
      : new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const [first, second] = await Promise.all([searchComicResearch('Railway fixture'), searchComicResearch('Railway fixture')]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ incomplete: true, articles: [{ title: 'Railway' }], images: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
