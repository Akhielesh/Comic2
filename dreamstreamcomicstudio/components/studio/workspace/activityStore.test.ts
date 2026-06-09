import { describe, it, expect, beforeEach } from 'vitest';
import { useStudioActivity, fileCount, diffTotals } from './activityStore';

const reset = () => useStudioActivity.getState().reset();

describe('activityStore', () => {
  beforeEach(reset);

  it('begin() clears prior state and marks running + expanded', () => {
    const s = useStudioActivity.getState();
    s.pushPhase('stale');
    s.begin();
    const next = useStudioActivity.getState();
    expect(next.status).toBe('running');
    expect(next.collapsed).toBe(false);
    expect(next.items).toHaveLength(0);
    expect(next.summary).toBeNull();
  });

  it('upsertFile adds a writing row, then resolves the same path to written with bytes', () => {
    const s = useStudioActivity.getState();
    s.begin();
    s.upsertFile({ path: '/App.tsx', status: 'writing' });
    expect(fileCount(useStudioActivity.getState().items)).toBe(1);
    s.upsertFile({ path: '/App.tsx', status: 'written', bytes: 1200 });
    const items = useStudioActivity.getState().items.filter((i) => i.kind === 'file');
    expect(items).toHaveLength(1); // same path, not duplicated
    expect(items[0].state).toBe('written');
    expect(items[0].bytes).toBe(1200);
  });

  it('pushPhase de-dupes an identical consecutive phase', () => {
    const s = useStudioActivity.getState();
    s.begin();
    s.pushPhase('Writing files…');
    s.pushPhase('Writing files…');
    expect(useStudioActivity.getState().items).toHaveLength(1);
    s.pushPhase('Tightening the output…');
    expect(useStudioActivity.getState().items).toHaveLength(2);
  });

  it('carries new/modified change + diff stats, merging by path', () => {
    const s = useStudioActivity.getState();
    s.begin();
    s.upsertFile({ path: '/App.tsx', status: 'writing', change: 'modified' });
    s.upsertFile({ path: '/App.tsx', status: 'written', change: 'modified', added: 12, removed: 3 });
    const file = useStudioActivity.getState().items.find((i) => i.path === '/App.tsx');
    expect(file?.change).toBe('modified');
    expect(file?.added).toBe(12);
    expect(file?.removed).toBe(3);
    s.upsertFile({ path: '/new.ts', status: 'written', change: 'new' });
    const created = useStudioActivity.getState().items.find((i) => i.path === '/new.ts');
    expect(created?.change).toBe('new');
  });

  it('diffTotals sums +added/−removed across file items and records timing', () => {
    const s = useStudioActivity.getState();
    s.begin();
    expect(useStudioActivity.getState().startedAt).not.toBeNull();
    s.upsertFile({ path: '/a.ts', status: 'written', change: 'modified', added: 5, removed: 2 });
    s.upsertFile({ path: '/b.ts', status: 'written', change: 'modified', added: 7, removed: 1 });
    expect(diffTotals(useStudioActivity.getState().items)).toEqual({ added: 12, removed: 3 });
    s.finish('done', 'ok');
    expect(useStudioActivity.getState().endedAt).not.toBeNull();
  });

  it('finish stays expanded for both done + error (no annoying auto-collapse)', () => {
    const s = useStudioActivity.getState();
    s.begin();
    s.finish('done', '✓ Built "X" — 3 files');
    let st = useStudioActivity.getState();
    expect(st.status).toBe('done');
    // The build record people most want to read no longer vanishes the moment it succeeds.
    expect(st.collapsed).toBe(false);
    expect(st.summary).toContain('Built');

    s.begin();
    s.finish('error', 'nope');
    st = useStudioActivity.getState();
    expect(st.status).toBe('error');
    expect(st.collapsed).toBe(false);
  });
});
