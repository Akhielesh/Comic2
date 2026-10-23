// ?next= after sign-in: only this site (or Stream Studio's own host, when it's on) — never anywhere else.
import { describe, expect, it } from 'vitest';
import { safeNext } from './safeNext';

const O = 'https://dreamstreamstudio.ai';

describe('safeNext', () => {
  it('keeps a path on this site, normalised', () => {
    expect(safeNext('/?view=chat', O, false)).toBe('/?view=chat');
    expect(safeNext('/live#/monitor', O, false)).toBe('/live#/monitor');
    expect(safeNext('/a/../b?x=1#h', O, false)).toBe('/b?x=1#h');
  });

  it('refuses anything that leaves the site', () => {
    for (const p of [
      '//evil.com', '/\\evil.com', '\\\\evil.com', 'https://evil.com/', 'javascript:alert(1)', 'evil.com',
      // Regression: the browser drops tab/newline/CR, so these became //evil.com.
      '/\t/evil.com', '/\n/evil.com', '/\r/evil.com', '/%09/evil.com'.replace('%09', '\t'),
      '', null, undefined,
    ]) expect(safeNext(p as string, O, true)).toBeNull();
  });

  it('allows Stream Studio’s own address only while it has one', () => {
    expect(safeNext('https://stream.dreamstreamstudio.ai/#/monitor', O, true)).toBe('https://stream.dreamstreamstudio.ai/#/monitor');
    expect(safeNext('https://stream.dreamstreamstudio.ai/#/monitor', O, false)).toBeNull();
    expect(safeNext('https://stream.dreamstreamstudio.ai.evil.com/', O, true)).toBeNull();
    expect(safeNext('http://stream.dreamstreamstudio.ai/', O, true)).toBeNull();
    expect(safeNext('https://user@stream.dreamstreamstudio.ai/', O, true)).toBeNull();
    expect(safeNext('https://stream.dreamstreamstudio.ai\t.evil.com/', O, true)).toBeNull();
  });
});
