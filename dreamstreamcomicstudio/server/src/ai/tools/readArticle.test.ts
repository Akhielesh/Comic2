import { describe, it, expect } from 'vitest';
import { isFetchableUrl, parseJinaReader } from './readArticle.js';

// The reader endpoint fetches an arbitrary client-supplied URL server-side, so the
// SSRF guard is security-critical: public http(s) only, never internal/loopback hosts.
describe('isFetchableUrl (reader SSRF guard)', () => {
  it('allows public http(s) article URLs', () => {
    expect(isFetchableUrl('https://www.reuters.com/world/some-story')).toBe(true);
    expect(isFetchableUrl('http://example.com/news')).toBe(true);
  });

  it('blocks non-http(s) schemes', () => {
    expect(isFetchableUrl('file:///etc/passwd')).toBe(false);
    expect(isFetchableUrl('ftp://example.com/x')).toBe(false);
    expect(isFetchableUrl('gopher://evil')).toBe(false);
    expect(isFetchableUrl('data:text/html,<script>')).toBe(false);
  });

  it('blocks loopback and link-local hosts', () => {
    expect(isFetchableUrl('http://localhost/admin')).toBe(false);
    expect(isFetchableUrl('http://127.0.0.1:8080/')).toBe(false);
    expect(isFetchableUrl('http://0.0.0.0/')).toBe(false);
    expect(isFetchableUrl('http://169.254.169.254/latest/meta-data/')).toBe(false); // cloud metadata
    expect(isFetchableUrl('http://[::1]/')).toBe(false);
  });

  it('blocks private RFC1918 ranges', () => {
    expect(isFetchableUrl('http://10.0.0.5/')).toBe(false);
    expect(isFetchableUrl('http://192.168.1.1/')).toBe(false);
    expect(isFetchableUrl('http://172.16.4.4/')).toBe(false);
    expect(isFetchableUrl('http://172.31.255.255/')).toBe(false);
  });

  it('allows public IPs outside private ranges', () => {
    expect(isFetchableUrl('http://172.15.0.1/')).toBe(true); // just below the 172.16–31 block
    expect(isFetchableUrl('http://8.8.8.8/')).toBe(true);
  });

  it('rejects malformed URLs', () => {
    expect(isFetchableUrl('not a url')).toBe(false);
    expect(isFetchableUrl('')).toBe(false);
  });
});

describe('parseJinaReader', () => {
  it('parses title, image and substantive blocks from a reader response', () => {
    const text = [
      'Title: SpaceX prices its IPO',
      '',
      'URL Source: https://example.com/spacex',
      '',
      'Markdown Content:',
      '# SpaceX prices its IPO',
      '![hero](https://example.com/hero.jpg)',
      '[Skip to content](https://example.com/#main)',
      '- Home',
      'The rocket maker priced its initial public offering well above the expected range on Thursday, a milestone for the commercial space industry and its investors worldwide.',
      '## What it means',
      'Analysts said the pricing reflects extraordinary demand for the most closely watched listing in a decade, with retail platforms reporting record interest from individual buyers.',
      'short line',
      'The rocket maker priced its initial public offering well above the expected range on Thursday, a milestone for the commercial space industry and its investors worldwide.'
    ].join('\n');
    const parsed = parseJinaReader(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe('SpaceX prices its IPO');
    expect(parsed!.image).toBe('https://example.com/hero.jpg');
    const types = parsed!.blocks.map((b) => b.type);
    expect(types).toEqual(['h', 'p', 'h', 'p']); // nav junk + dupes dropped
  });

  it('returns null when the content is too thin to read', () => {
    expect(parseJinaReader('Title: x\nMarkdown Content:\n- nav\n- nav2')).toBeNull();
  });
});
