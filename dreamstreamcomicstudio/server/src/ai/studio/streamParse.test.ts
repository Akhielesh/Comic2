import { describe, it, expect } from 'vitest';
import { readJsonString, scanStreamedFiles } from './streamParse.js';

describe('readJsonString', () => {
  it('reads a simple string and returns the index past the closing quote', () => {
    const r = readJsonString('"hello" rest', 0);
    expect(r.value).toBe('hello');
    expect(r.end).toBe(7);
  });

  it('decodes escapes (quote, newline, backslash)', () => {
    const r = readJsonString('"a\\"b\\nc\\\\d"', 0);
    expect(r.value).toBe('a"b\nc\\d');
  });

  it('returns end:-1 for an unterminated string (still streaming)', () => {
    const r = readJsonString('"half', 0);
    expect(r.end).toBe(-1);
    expect(r.value).toBe('half');
  });

  it('returns end:-1 when an escape is split across the chunk boundary', () => {
    const r = readJsonString('"abc\\', 0);
    expect(r.end).toBe(-1);
  });
});

describe('scanStreamedFiles', () => {
  it('returns nothing before the files array starts', () => {
    expect(scanStreamedFiles('{"title":"X","template":"react-ts"')).toEqual([]);
  });

  it('surfaces a file path as soon as it is known, before content closes', () => {
    const partial = '{"files":[{"path":"/App.tsx","content":"export default () => ';
    const files = scanStreamedFiles(partial);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('/App.tsx');
    expect(files[0].complete).toBe(false);
    expect(files[0].bytes).toBeGreaterThan(0);
  });

  it('marks a file complete once its object closes and counts decoded bytes', () => {
    const text = '{"files":[{"path":"/App.tsx","content":"hello\\nworld"}]}';
    const files = scanStreamedFiles(text);
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({ path: '/App.tsx', complete: true, bytes: 'hello\nworld'.length });
  });

  it('tracks multiple files, the last one still streaming', () => {
    const text =
      '{"files":[{"path":"/App.tsx","content":"a"},{"path":"/package.json","content":"{ \\"name\\":';
    const files = scanStreamedFiles(text);
    expect(files.map((f) => f.path)).toEqual(['/App.tsx', '/package.json']);
    expect(files[0].complete).toBe(true);
    expect(files[1].complete).toBe(false);
  });

  it('handles an extra non-string field (language) on a file object', () => {
    const text = '{"files":[{"path":"/a.ts","language":"typescript","content":"x"}]}';
    const files = scanStreamedFiles(text);
    expect(files).toEqual([{ path: '/a.ts', complete: true, bytes: 1 }]);
  });

  it('stops at the closing array bracket', () => {
    const text = '{"files":[{"path":"/a.ts","content":"x"}],"trailing":true}';
    expect(scanStreamedFiles(text)).toHaveLength(1);
  });
});
