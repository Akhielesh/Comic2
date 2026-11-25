// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ getSession: vi.fn(), from: vi.fn() }));
vi.mock('./supabase', () => ({ supabase: { auth, from: auth.from }, isStoredSession: () => true }));
import { comicActivityRow, loadComicActivity, WORK_SELECT } from './comicWorkspaceActivity';
describe('owner task listing', () => {
  it('reads small scalar projections under the current owner with bounded paging', async () => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), range: vi.fn().mockReturnThis(), abortSignal: vi.fn().mockResolvedValue({ data: [], error: null }) };
    auth.from.mockReturnValue(query);
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'A' }, access_token: 'example' } } });
    const signal = new AbortController().signal;
    await expect(loadComicActivity('B', 0, signal)).rejects.toThrow(); expect(auth.from).not.toHaveBeenCalled();
    await loadComicActivity('A', 25, signal);
    expect(query.eq).toHaveBeenCalledWith('user_id', 'A');
    expect(query.range).toHaveBeenCalledWith(25, 50);
    expect(query.select).toHaveBeenCalledWith(WORK_SELECT);
    expect(WORK_SELECT).not.toMatch(/\*|,doc,|\(state\)|,conversation,|script|prompt|->>text/);
  });
  it('recovers output and open decisions in documents written before summaries existed', () => {
    expect(comicActivityRow({ project_id: 'p', gate: 'open', listing: { rendered: '3' }, lastRole: 'assistant', priorRole: 'user', lastAt: '123' })).toEqual({
      id: 'p', title: 'Untitled comic', v: 1, working: false, attention: 'approval',
      finished: [{ kind: 'pages', at: 0, count: 3 }, { kind: 'reply', at: 123 }]
    });
    expect(comicActivityRow({ project_id: 'p', gate: 'declined' }).attention).toBe(null);
    expect(comicActivityRow({ project_id: 'p', plan: 'draft', draft: 'review' }).attention).toBe('plan');
  });
  it('keeps a stored stage only when it reads as a whole; older summaries and garbage carry none', () => {
    const stage = { v: 1, stage: 'draw', done: ['story', 'style', 'plan'], pages: 12, planned: 12, drawn: 6, current: 6, outOfDate: 0, drawing: 0, withheld: 0, failed: 0, looks: 0, paused: false, next: 'draw_rest' };
    const activity = { v: 1 as const, attention: null, working: true, finished: [] };
    expect(comicActivityRow({ project_id: 'p', activity: { ...activity, stage } as never }).stage).toEqual(stage);
    expect(comicActivityRow({ project_id: 'p', activity }).stage).toBeUndefined();
    expect('stage' in comicActivityRow({ project_id: 'p', activity: { ...activity, stage: { ...stage, stage: 'publish' } } as never })).toBe(false);
    expect('stage' in comicActivityRow({ project_id: 'p', activity: { ...activity, stage: 'Drawing' } as never })).toBe(false);
    expect(comicActivityRow({ project_id: 'p', gate: 'open' }).stage).toBeUndefined();
  });
});
