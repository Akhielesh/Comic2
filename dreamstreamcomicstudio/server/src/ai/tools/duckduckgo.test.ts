import { describe, it, expect } from 'vitest';
import { parseDdgHtml } from './duckduckgo.js';

// A trimmed but representative DuckDuckGo HTML results fragment.
const SAMPLE = `
<div class="result results_links">
  <div class="result__body">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=abc">First &amp; Best Result</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">This is the <b>first</b> snippet.</a>
  </div>
</div>
<div class="result results_links">
  <div class="result__body">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Ftwo&amp;rut=def">Second Result</a>
    <a class="result__snippet" href="x">Second snippet text.</a>
  </div>
</div>
`;

describe('parseDdgHtml', () => {
  it('extracts titles, decoded URLs and snippets', () => {
    const results = parseDdgHtml(SAMPLE);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'First & Best Result',
      url: 'https://example.com/one',
      snippet: 'This is the first snippet.'
    });
    expect(results[1].url).toBe('https://example.org/two');
    expect(results[1].title).toBe('Second Result');
  });

  it('respects the result limit', () => {
    expect(parseDdgHtml(SAMPLE, 1)).toHaveLength(1);
  });

  it('returns an empty array for non-result HTML', () => {
    expect(parseDdgHtml('<html><body>no results</body></html>')).toEqual([]);
  });
});
