import { describe, it, expect } from 'vitest';
import { parseBingHtml, parseSearxngJson } from './search.js';

describe('parseSearxngJson', () => {
  const DATA = {
    results: [
      { title: 'First', url: 'https://a.com', content: 'snippet a' },
      { title: 'Second', url: 'https://b.com', content: 'snippet b' },
      { title: 'No url', content: 'ignored' },
      { url: 'https://c.com', content: 'no title, ignored' }
    ]
  };
  it('maps valid SearXNG results and drops ones without title+url', () => {
    const out = parseSearxngJson(DATA, 6);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: 'First', url: 'https://a.com', snippet: 'snippet a' });
  });
  it('respects the limit', () => {
    expect(parseSearxngJson(DATA, 1)).toHaveLength(1);
  });
  it('handles an empty/blocked response', () => {
    expect(parseSearxngJson({}, 6)).toEqual([]);
  });
});

// Pure parser tests — the network providers can't be runtime-verified in the sandbox,
// but the HTML parser that turns Bing's results page into structured results can.
describe('parseBingHtml', () => {
  const SAMPLE = `
    <ol id="b_results">
      <li class="b_algo">
        <h2><a href="https://example.com/a" h="ID=1">First Result Title</a></h2>
        <div class="b_caption"><p class="b_lineclamp2">This is the first snippet describing the page.</p></div>
      </li>
      <li class="b_algo">
        <h2><a href="https://example.org/b">Second &amp; Result</a></h2>
        <div class="b_caption"><p>Second snippet here.</p></div>
      </li>
      <li class="b_ad">an ad, ignored</li>
    </ol>`;

  it('extracts organic results with title, url and snippet', () => {
    const out = parseBingHtml(SAMPLE);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: 'First Result Title', url: 'https://example.com/a', snippet: 'This is the first snippet describing the page.' });
    expect(out[1].title).toBe('Second & Result');
    expect(out[1].url).toBe('https://example.org/b');
  });

  it('respects the limit', () => {
    expect(parseBingHtml(SAMPLE, 1)).toHaveLength(1);
  });

  it('returns [] for a blocked/empty page', () => {
    expect(parseBingHtml('<html><body>Verifying you are human…</body></html>')).toEqual([]);
  });

  it('skips entries without a usable http(s) url', () => {
    const bad = '<li class="b_algo"><h2><a href="javascript:void(0)">x</a></h2></li>';
    expect(parseBingHtml(bad)).toEqual([]);
  });
});
