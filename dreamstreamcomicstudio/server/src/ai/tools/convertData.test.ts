import { describe, it, expect } from 'vitest';
import {
  convertDataTool,
  parseDelimited,
  parseTable,
  detectFormat,
  toDelimited,
  toJsonRows
} from './convertData.js';

const run = (args: Record<string, unknown>) => convertDataTool.execute(args, new AbortController().signal);

describe('parseDelimited', () => {
  it('parses quoted fields with embedded delimiters, newlines and doubled quotes', () => {
    const csv = 'name,note\n"Smith, Jr.","line1\nline2"\n"She said ""hi""",ok';
    const grid = parseDelimited(csv, ',');
    expect(grid).toEqual([
      ['name', 'note'],
      ['Smith, Jr.', 'line1\nline2'],
      ['She said "hi"', 'ok']
    ]);
  });
});

describe('detectFormat', () => {
  it('detects json / tsv / csv', () => {
    expect(detectFormat('[{"a":1}]')).toBe('json');
    expect(detectFormat('a\tb\tc\n1\t2\t3')).toBe('tsv');
    expect(detectFormat('a,b,c\n1,2,3')).toBe('csv');
  });
});

describe('parseTable', () => {
  it('parses CSV into columns + rows', () => {
    const t = parseTable('a,b\n1,2\n3,4');
    expect(t.columns).toEqual(['a', 'b']);
    expect(t.rows).toEqual([['1', '2'], ['3', '4']]);
    expect(t.truncated).toBe(false);
  });

  it('parses a JSON array of objects into a column union', () => {
    const t = parseTable('[{"x":1,"y":2},{"x":3,"z":9}]');
    expect(t.columns).toEqual(['x', 'y', 'z']);
    expect(t.rows).toEqual([['1', '2', ''], ['3', '', '9']]);
  });
});

describe('serialization', () => {
  it('CSV → JSON coerces numeric cells', () => {
    const t = parseTable('a,b\n1,hello');
    expect(toJsonRows(t)).toEqual([{ a: 1, b: 'hello' }]);
  });

  it('round-trips through CSV with correct quoting', () => {
    const t = parseTable('a,b\n"x,y",z');
    expect(toDelimited(t)).toBe('a,b\n"x,y",z');
  });
});

describe('convert_data tool', () => {
  it('converts CSV to JSON and returns a data_table artifact', async () => {
    const res = await run({ data: 'a,b\n1,2', to: 'json' });
    expect(res.content).toContain('```json');
    expect(res.artifacts?.[0]).toMatchObject({ type: 'data_table' });
    const data = res.artifacts![0].data as { columns: { label: string; kind: string }[] };
    expect(data.columns[0]).toMatchObject({ label: 'a', kind: 'number' });
  });

  it('returns no artifact for empty input', async () => {
    const res = await run({ data: '   ' });
    expect(res.artifacts).toBeUndefined();
    expect(res.content).toMatch(/no data/i);
  });

  it('reports a parse error for malformed JSON', async () => {
    const res = await run({ data: '{not json', from: 'json' });
    expect(res.artifacts).toBeUndefined();
    expect(res.content).toMatch(/parse/i);
  });
});
