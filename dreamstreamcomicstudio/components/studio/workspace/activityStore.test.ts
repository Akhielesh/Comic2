import { describe, it, expect, beforeEach } from 'vitest';
import { useStudioActivity, fileCount } from './activityStore';

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

  it('finish("done") collapses to the summary; finish("error") stays expanded', () => {
    const s = useStudioActivity.getState();
    s.begin();
    s.finish('done', '✓ Built "X" — 3 files');
    let st = useStudioActivity.getState();
    expect(st.status).toBe('done');
    expect(st.collapsed).toBe(true);
    expect(st.summary).toContain('Built');

    s.begin();
    s.finish('error', 'nope');
    st = useStudioActivity.getState();
    expect(st.status).toBe('error');
    expect(st.collapsed).toBe(false);
  });
});
