import { describe, it, expect } from 'vitest';
import { analyzeDataTool, columnStats, groupAggregate } from './analyzeData.js';
import { parseTable } from './convertData.js';

const run = (args: Record<string, unknown>) => analyzeDataTool.execute(args, new AbortController().signal);

describe('columnStats', () => {
  it('computes count/mean/median/min/max/sum for numeric columns only', () => {
    const t = parseTable('name,score\nA,10\nB,20\nC,30');
    const stats = columnStats(t);
    expect(stats).toHaveLength(1); // only `score` is numeric
    expect(stats[0]).toMatchObject({ column: 'score', count: 3, mean: 20, median: 20, min: 10, max: 30, sum: 60 });
  });
});

describe('groupAggregate', () => {
  const t = parseTable('region,sales\nE,10\nW,5\nE,30\nW,15');
  it('sums a value column by group, sorted desc', () => {
    expect(groupAggregate(t, 0, 1, 'sum')).toEqual([
      { key: 'E', value: 40 },
      { key: 'W', value: 20 }
    ]);
  });
  it('averages and counts', () => {
    expect(groupAggregate(t, 0, 1, 'avg')).toEqual([{ key: 'E', value: 20 }, { key: 'W', value: 10 }]);
    expect(groupAggregate(t, 0, null, 'count')).toEqual([{ key: 'E', value: 2 }, { key: 'W', value: 2 }]);
  });
});

describe('analyze_data tool', () => {
  it('returns descriptive stats as a data_table by default', async () => {
    const res = await run({ data: 'x,y\n1,2\n3,4' });
    expect(res.artifacts?.[0]).toMatchObject({ type: 'data_table' });
    const data = res.artifacts![0].data as { columns: { label: string }[]; rows: unknown[][] };
    expect(data.columns[0].label).toBe('Column');
    expect(data.rows.length).toBe(2); // two numeric columns
  });

  it('aggregates by group when groupBy + value given', async () => {
    const res = await run({ data: 'region,sales\nE,10\nW,5\nE,30', groupBy: 'region', value: 'sales', agg: 'sum' });
    const data = res.artifacts![0].data as { rows: [string, number][] };
    expect(data.rows[0]).toEqual(['E', 40]);
  });

  it('errors clearly on an unknown groupBy column', async () => {
    const res = await run({ data: 'a,b\n1,2', groupBy: 'nope' });
    expect(res.artifacts).toBeUndefined();
    expect(res.content).toMatch(/not found/i);
  });

  it('requires a value column for non-count aggregations', async () => {
    const res = await run({ data: 'a,b\n1,2', groupBy: 'a', agg: 'sum' });
    expect(res.artifacts).toBeUndefined();
    expect(res.content).toMatch(/value/i);
  });
});
