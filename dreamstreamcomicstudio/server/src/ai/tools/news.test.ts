import { describe, it, expect } from 'vitest';
import { parseNewsRss, buildNewsUrl } from './news.js';

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Top stories - Google News</title>
  <item>
    <title>Markets rally as inflation cools - Reuters</title>
    <link>https://news.google.com/rss/articles/abc123</link>
    <guid>abc123</guid>
    <pubDate>Tue, 03 Jun 2026 12:30:00 GMT</pubDate>
    <description><![CDATA[<a href="https://news.google.com/x">Markets rally as inflation cools</a>&nbsp;&nbsp;<font color="#6f6f6f">Reuters</font>]]></description>
    <source url="https://www.reuters.com">Reuters</source>
  </item>
  <item>
    <title>City wins championship in overtime thriller - ESPN</title>
    <link>https://news.google.com/rss/articles/def456</link>
    <pubDate>Tue, 03 Jun 2026 09:00:00 GMT</pubDate>
    <source url="https://www.espn.com">ESPN</source>
  </item>
</channel></rss>`;

describe('parseNewsRss', () => {
  it('extracts title, url, source and publish date, stripping the trailing source', () => {
    const items = parseNewsRss(SAMPLE_RSS);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Markets rally as inflation cools');
    expect(items[0].source).toBe('Reuters');
    expect(items[0].url).toBe('https://news.google.com/rss/articles/abc123');
    expect(items[0].publishedAt).toBe(new Date('Tue, 03 Jun 2026 12:30:00 GMT').toISOString());
    expect(items[1].title).toBe('City wins championship in overtime thriller');
    expect(items[1].source).toBe('ESPN');
  });

  it('respects the limit', () => {
    expect(parseNewsRss(SAMPLE_RSS, 1)).toHaveLength(1);
  });

  it('returns an empty array for non-RSS input', () => {
    expect(parseNewsRss('<html>not rss</html>')).toEqual([]);
  });

  it('drops a snippet that merely repeats the title', () => {
    const items = parseNewsRss(SAMPLE_RSS);
    // The description is just the headline + source, so no distinct snippet survives.
    expect(items[0].snippet).toBeUndefined();
  });
});

describe('buildNewsUrl', () => {
  it('uses the search endpoint for a free-text query', () => {
    const url = buildNewsUrl({ query: 'Apple Vision Pro', region: 'US', lang: 'en' });
    expect(url).toContain('/rss/search?q=Apple%20Vision%20Pro');
    expect(url).toContain('gl=US');
    expect(url).toContain('hl=en-US');
    expect(url).toContain('ceid=US%3Aen');
  });

  it('uses a topical section when given a known topic and no query', () => {
    expect(buildNewsUrl({ topic: 'technology' })).toContain('/headlines/section/topic/TECHNOLOGY');
    expect(buildNewsUrl({ topic: 'politics' })).toContain('/headlines/section/topic/NATION');
  });

  it('falls back to the top-headlines feed for "top" / unknown topics', () => {
    expect(buildNewsUrl({ topic: 'top' })).toMatch(/\/rss\?hl=/);
    expect(buildNewsUrl({})).toMatch(/\/rss\?hl=/);
  });

  it('defaults region/lang to US/en', () => {
    expect(buildNewsUrl({ query: 'x' })).toContain('gl=US');
  });
});
