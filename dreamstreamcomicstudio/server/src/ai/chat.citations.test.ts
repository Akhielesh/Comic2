import { describe, it, expect } from 'vitest';
import { dedupeCitations, canonicalizeCitationUrl } from './chat.js';

// Citations accumulate across up to MAX_TOOL_ITERATIONS rounds from ~30 producers;
// external feeds return the same article in trivially different URL forms. The dedup
// must collapse those variants without ever merging two genuinely distinct sources.

describe('canonicalizeCitationUrl', () => {
  it('normalizes http→https, www, host casing, trailing slash, and fragment', () => {
    expect(canonicalizeCitationUrl('http://WWW.Example.com/a/')).toBe('https://example.com/a');
    expect(canonicalizeCitationUrl('https://example.com/a#intro')).toBe('https://example.com/a');
  });

  it('strips tracking params but keeps meaningful query params', () => {
    expect(canonicalizeCitationUrl('https://x.com/a?utm_source=news&utm_campaign=z')).toBe('https://x.com/a');
    expect(canonicalizeCitationUrl('https://x.com/a?gclid=1&fbclid=2&ref=feed')).toBe('https://x.com/a');
    // Load-bearing params are preserved.
    expect(canonicalizeCitationUrl('https://youtube.com/watch?v=AAA')).toBe('https://youtube.com/watch?v=AAA');
  });

  it('keeps the root path slash', () => {
    expect(canonicalizeCitationUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('fails open on a non-URL string (keys on itself)', () => {
    expect(canonicalizeCitationUrl('not a url')).toBe('not a url');
    expect(canonicalizeCitationUrl('  spaced  ')).toBe('spaced');
  });
});

describe('dedupeCitations', () => {
  it('keeps existing behavior: empty in → empty out, url-less entries skipped', () => {
    expect(dedupeCitations([])).toEqual([]);
    expect(dedupeCitations([{ url: '', title: 'no url' }])).toEqual([]);
  });

  it('keeps genuinely distinct sources', () => {
    const cites = [
      { url: 'https://a.com/x', title: 'A' },
      { url: 'https://b.com/y', title: 'B' }
    ];
    expect(dedupeCitations(cites)).toEqual(cites);
  });

  it('collapses http/https, www, trailing-slash, fragment, and tracking-param variants', () => {
    const out = dedupeCitations([
      { url: 'https://www.example.com/article', title: 'first' },
      { url: 'http://example.com/article/', title: 'dup-protocol-slash' },
      { url: 'https://example.com/article#top', title: 'dup-fragment' },
      { url: 'https://example.com/article?utm_source=x', title: 'dup-utm' }
    ]);
    expect(out).toHaveLength(1);
    // First-seen wins: original display URL + title preserved.
    expect(out[0]).toEqual({ url: 'https://www.example.com/article', title: 'first' });
  });

  it('does NOT over-merge distinct query params (regression guard)', () => {
    const out = dedupeCitations([
      { url: 'https://youtube.com/watch?v=AAA', title: 'vid A' },
      { url: 'https://youtube.com/watch?v=BBB', title: 'vid B' }
    ]);
    expect(out).toHaveLength(2);
  });

  it('preserves first-seen order', () => {
    const out = dedupeCitations([
      { url: 'https://a.com/1', title: '1' },
      { url: 'https://b.com/2', title: '2' },
      { url: 'http://a.com/1/', title: 'dup of 1' }
    ]);
    expect(out.map((c) => c.title)).toEqual(['1', '2']);
  });

  it('dedupes non-URL strings by exact match (fail-open)', () => {
    const out = dedupeCitations([
      { url: 'not-a-url', title: 'x' },
      { url: 'not-a-url', title: 'dup' },
      { url: 'other', title: 'y' }
    ]);
    expect(out.map((c) => c.title)).toEqual(['x', 'y']);
  });
});
