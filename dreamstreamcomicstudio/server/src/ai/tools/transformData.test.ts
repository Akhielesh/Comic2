import { describe, it, expect } from 'vitest';
import { transformDataTool, applyTransform } from './transformData.js';
import { parseTable } from './convertData.js';

const run = (args: Record<string, unknown>) => transformDataTool.execute(args, new AbortController().signal);
const t = () => parseTable('name,score,team\nA,30,X\nB,10,Y\nC,20,X');

describe('applyTransform', () => {
  it('filters rows numerically', () => {
    const r = applyTransform(t(), { filter: { column: 'score', op: 'gt', value: 15 } });
    expect(r.rows.map((row) => row[0])).toEqual(['A', 'C']);
  });

  it('sorts numerically descending', () => {
    const r = applyTransform(t(), { sortBy: 'score', sortDir: 'desc' });
    expect(r.rows.map((row) => row[0])).toEqual(['A', 'C', 'B']);
  });

  it('selects columns in order', () => {
    const r = applyTransform(t(), { select: ['team', 'name'] });
    expect(r.columns).toEqual(['team', 'name']);
    expect(r.rows[0]).toEqual(['X', 'A']);
  });

  it('drops columns', () => {
    const r = applyTransform(t(), { drop: ['team'] });
    expect(r.columns).toEqual(['name', 'score']);
  });

  it('applies filter → sort → limit together', () => {
    const r = applyTransform(t(), { filter: { column: 'team', op: 'eq', value: 'X' }, sortBy: 'score', sortDir: 'desc', limit: 1 });
    expect(r.rows).toEqual([['A', '30', 'X']]);
  });

  it('string ops: contains / startsWith', () => {
    expect(applyTransform(t(), { filter: { column: 'name', op: 'contains', value: 'b' } }).rows.length).toBe(1);
    expect(applyTransform(t(), { filter: { column: 'team', op: 'startsWith', value: 'Y' } }).rows[0][0]).toBe('B');
  });
});

describe('transform_data tool', () => {
  it('returns a data_table preview by default', async () => {
    const res = await run({ data: 'a,b\n1,2\n3,4', sortBy: 'a', sortDir: 'desc' });
    expect(res.artifacts?.[0]).toMatchObject({ type: 'data_table' });
    const data = res.artifacts![0].data as { rows: unknown[][] };
    expect(data.rows[0][0]).toBe(3);
  });

  it('emits CSV when to=csv', async () => {
    const res = await run({ data: 'a,b\n1,2', to: 'csv', select: ['b'] });
    expect(res.content).toContain('```csv');
    expect(res.content).toContain('b\n2');
  });

  it('reports when no selected columns exist', async () => {
    const res = await run({ data: 'a,b\n1,2', select: ['nope', 'nada'] });
    expect(res.artifacts).toBeUndefined();
    expect(res.content).toMatch(/none of the selected columns/i);
  });
});
