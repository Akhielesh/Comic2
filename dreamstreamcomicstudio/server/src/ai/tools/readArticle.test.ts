import { describe, it, expect } from 'vitest';
import { isFetchableUrl } from './readArticle.js';

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
