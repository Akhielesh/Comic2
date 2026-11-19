import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  hnToNewsItems,
  wikiToDocument,
  dictToDocument,
  booksToDocument,
  papersToDocument,
  searchPapersTool,
  wikiLookupTool
} from './knowledge.js';
import { __resetProviderUsage } from '../../lib/providerUsage.js';
import { SEARCH_REPLY, SUMMARY_REPLY } from './__fixtures__/wikidata.js';

const stubFetch = (route: (url: URL) => unknown): string[] => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const raw = String(input);
      urls.push(raw);
      const body = route(new URL(raw));
      if (body instanceof Response) return body;
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
    })
  );
  return urls;
};

beforeEach(() => __resetProviderUsage());
afterEach(() => vi.unstubAllGlobals());

describe('hnToNewsItems', () => {
  const hits = [
    {
      title: 'Show HN: I built a tiny Lisp in Rust',
      url: 'https://example.dev/tiny-lisp',
      points: 412,
      num_comments: 187,
      author: 'pg_fan',
      objectID: '39001234',
      created_at: '2026-06-10T14:22:08.000Z'
    },
    {
      // An "Ask HN" style story with no external URL — must fall back to the HN item page.
      title: 'Ask HN: What are you self-hosting in 2026?',
      points: 95,
      num_comments: 240,
      objectID: '39005678',
      created_at: 'not-a-date'
    },
    { url: 'https://example.com/untitled', objectID: '39009999' } // no title → dropped
  ];

  it('maps hits to NewsItem with HN as the source and a points/comments snippet', () => {
    const items = hnToNewsItems(hits);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'Show HN: I built a tiny Lisp in Rust',
      url: 'https://example.dev/tiny-lisp',
      source: 'Hacker News',
      publishedAt: '2026-06-10T14:22:08.000Z',
      snippet: '412 points · 187 comments · by pg_fan'
    });
  });

  it('falls back to the HN item page when a story has no external URL', () => {
    const items = hnToNewsItems(hits);
    expect(items[1].url).toBe('https://news.ycombinator.com/item?id=39005678');
  });

  it('omits publishedAt for unparseable dates and defaults points/comments to 0', () => {
    const items = hnToNewsItems([{ title: 'No metadata', objectID: '1' }]);
    expect(items[0].publishedAt).toBeUndefined();
    expect(items[0].snippet).toBe('0 points · 0 comments');
    expect(hnToNewsItems(hits)[1].publishedAt).toBeUndefined();
  });
});

describe('wikiToDocument', () => {
  it('builds a document with image, extract and source link', () => {
    const doc = wikiToDocument({
      title: 'Marie Curie',
      description: 'Polish-French physicist and chemist (1867–1934)',
      extract: 'Marie Salomea Skłodowska-Curie was a physicist and chemist who conducted pioneering research on radioactivity.',
      url: 'https://en.wikipedia.org/wiki/Marie_Curie',
      thumbnail: 'https://upload.wikimedia.org/curie.jpg'
    });
    expect(doc.title).toBe('Marie Curie');
    expect(doc.subtitle).toContain('physicist');
    expect(doc.content).toContain('![Marie Curie](https://upload.wikimedia.org/curie.jpg)');
    expect(doc.content).toContain('pioneering research on radioactivity');
    expect(doc.content).toContain('[Read the full article on Wikipedia](https://en.wikipedia.org/wiki/Marie_Curie)');
  });

  it('omits the image line when there is no thumbnail', () => {
    const doc = wikiToDocument({ title: 'Black hole', extract: 'A region of spacetime.', url: 'https://en.wikipedia.org/wiki/Black_hole' });
    expect(doc.content.startsWith('A region of spacetime.')).toBe(true);
    expect(doc.subtitle).toBeUndefined();
  });
});

describe('dictToDocument', () => {
  const entry = {
    word: 'serendipity',
    phonetic: '/ˌsɛɹ.ənˈdɪp.ɪ.ti/',
    meanings: [
      {
        partOfSpeech: 'noun',
        definitions: [
          { definition: 'An unsought, unintended fortunate discovery.', example: 'They found each other by pure serendipity.' },
          { definition: 'The faculty of making such discoveries.' }
        ],
        synonyms: ['chance', 'fortuity', 'luck']
      }
    ]
  };

  it('renders senses with examples and synonyms as markdown', () => {
    const doc = dictToDocument(entry, 'serendipity');
    expect(doc.title).toBe('serendipity');
    expect(doc.subtitle).toBe('Pronounced /ˌsɛɹ.ənˈdɪp.ɪ.ti/');
    expect(doc.content).toContain('## noun');
    expect(doc.content).toContain('1. An unsought, unintended fortunate discovery.');
    expect(doc.content).toContain('“They found each other by pure serendipity.”');
    expect(doc.content).toContain('**Synonyms:** chance, fortuity, luck');
    expect(doc.filename).toBe('definition-serendipity');
  });

  it('falls back to the queried word when the entry omits it', () => {
    const doc = dictToDocument({ meanings: [{ definitions: [{ definition: 'x' }] }] }, 'mystery');
    expect(doc.title).toBe('mystery');
    expect(doc.subtitle).toBeUndefined();
  });
});

describe('booksToDocument', () => {
  it('builds a linked reading list with authors, year and editions', () => {
    const doc = booksToDocument('dune', [
      { title: 'Dune', author_name: ['Frank Herbert'], first_publish_year: 1965, key: '/works/OL893415W', edition_count: 120 },
      { title: 'Dune Messiah', author_name: ['Frank Herbert'], first_publish_year: 1969, key: '/works/OL893416W', edition_count: 1 }
    ]);
    expect(doc.title).toBe('Books — dune');
    expect(doc.subtitle).toBe('2 results from Open Library');
    expect(doc.content).toContain('[Dune](https://openlibrary.org/works/OL893415W) — Frank Herbert (1965) · 120 editions');
    expect(doc.content).toContain('· 1 edition');
  });
});

describe('papersToDocument', () => {
  it('builds linked paper sections with author/date meta and an ellipsis for truncated abstracts', () => {
    const longSummary = 'Diffusion models have emerged as a powerful class of generative models. '.padEnd(320, 'x');
    const doc = papersToDocument('diffusion models', [
      {
        title: 'Denoising Diffusion Probabilistic Models',
        id: 'http://arxiv.org/abs/2006.11239v2',
        summary: longSummary,
        authors: ['Jonathan Ho', 'Ajay Jain', 'Pieter Abbeel'],
        published: '2020-06-19'
      },
      { title: 'Short abstract paper', id: 'http://arxiv.org/abs/9999.00001', summary: 'Brief.', authors: [], published: '' }
    ]);
    expect(doc.title).toBe('arXiv papers — diffusion models');
    expect(doc.content).toContain('### [Denoising Diffusion Probabilistic Models](http://arxiv.org/abs/2006.11239v2)');
    expect(doc.content).toContain('*Jonathan Ho, Ajay Jain, Pieter Abbeel · 2020-06-19*');
    expect(doc.content).toContain('xxx…');
    // Short abstracts get no ellipsis and no empty meta line.
    expect(doc.content).toContain('### [Short abstract paper](http://arxiv.org/abs/9999.00001)\n\nBrief.');
  });
});

describe('search_papers', () => {
  const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2601.00001v1</id>
    <published>2026-01-02T00:00:00Z</published>
    <title>Lantern  Keepers and
      Harbor Light Models</title>
    <summary>An invented abstract about guiding boats with lanterns.</summary>
    <author><name>A. Example</name></author>
  </entry>
</feed>`;

  it('asks arXiv over HTTPS and links the papers over HTTPS', async () => {
    const urls = stubFetch(() => ATOM);
    const out = await searchPapersTool.execute({ query: 'harbor lights' });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('https://export.arxiv.org/api/query?search_query=all:harbor%20lights&start=0&max_results=5&sortBy=relevance');
    expect(out.citations).toEqual([{ url: 'https://arxiv.org/abs/2601.00001v1', title: 'Lantern Keepers and Harbor Light Models' }]);
    expect(out.content).toContain('https://arxiv.org/abs/2601.00001v1');
    expect(out.content).not.toContain('http://arxiv.org');
  });
});

describe('wiki_lookup', () => {
  it('answers exactly as before through the shared Wikipedia helper', async () => {
    const urls = stubFetch((u) => (u.pathname.startsWith('/w/rest.php') ? { pages: [SEARCH_REPLY.pages[0]] } : SUMMARY_REPLY));
    const out = await wikiLookupTool.execute({ query: 'harbor lights' });
    expect(urls).toEqual([
      'https://en.wikipedia.org/w/rest.php/v1/search/page?q=harbor%20lights&limit=1',
      'https://en.wikipedia.org/api/rest_v1/page/summary/Harbor_Lights_(folk_tale)'
    ]);
    const url = 'https://en.wikipedia.org/wiki/Harbor_Lights_(folk_tale)';
    const thumb = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Harbor.jpg/320px-Harbor.jpg';
    expect(out).toEqual({
      content:
        'Wikipedia — Harbor Lights (folk tale) (Coastal folk tale):\n' +
        'Harbor Lights is a coastal folk tale in which two lantern keepers guide boats home through a storm.\n' +
        `Source: ${url}\n` +
        "(A document card with this summary is shown to the user — don't repeat the extract.)",
      citations: [{ url, title: 'Harbor Lights (folk tale)' }],
      images: [{ url: thumb, title: 'Harbor Lights (folk tale)', source: 'Wikipedia' }],
      artifacts: [
        {
          type: 'document',
          data: {
            title: 'Harbor Lights (folk tale)',
            subtitle: 'Coastal folk tale',
            content:
              `![Harbor Lights (folk tale)](${thumb})\n\n` +
              'Harbor Lights is a coastal folk tale in which two lantern keepers guide boats home through a storm.\n\n' +
              `[Read the full article on Wikipedia](${url})`
          }
        }
      ]
    });
  });

  it('falls back to the search excerpt (tags stripped) when the summary has no extract', async () => {
    stubFetch((u) =>
      u.pathname.startsWith('/w/rest.php') ? { pages: [SEARCH_REPLY.pages[0]] } : { ...SUMMARY_REPLY, extract: '' }
    );
    const out = await wikiLookupTool.execute({ query: 'harbor lights' });
    expect(out.content).toContain('A harbor tale about lantern keepers');
  });

  it('says so when nothing matches', async () => {
    stubFetch(() => ({ pages: [] }));
    const out = await wikiLookupTool.execute({ query: 'zzzz' });
    expect(out.content).toBe('No Wikipedia article found for "zzzz".');
  });
});
