// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ getSession: vi.fn(), from: vi.fn() }));
vi.mock('./supabase', () => ({ supabase: { auth, from: auth.from }, isStoredSession: () => true }));
import { comicActivityRow, loadComicActivity, loadComicStages, STAGE_DOC_SELECT, STAGE_PAGE_SIZE, STAGE_SELECT, WORK_SELECT } from './comicWorkspaceActivity';
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
  it('My comics reads every card’s stage in one paged list read of the listing column (never the doc), the owner’s rows, until they run out', async () => {
    const stage = { v: 1, stage: 'draw', done: ['story', 'style', 'plan'], pages: 12, planned: 12, drawn: 6, current: 6, outOfDate: 0, drawing: 0, withheld: 0, failed: 0, looks: 0, paused: false, next: 'draw_rest' };
    // As the comic_docs_listing trigger writes it: the summary, and JSON nulls for the scalars a doc does not have.
    const listing = (activity: unknown, scalars: Record<string, string | null> = {}) => ({ activity, gate: null, plan: null, draft: null, lastCard: null, ...scalars });
    const rows = Array.from({ length: STAGE_PAGE_SIZE + 2 }, (_, i) => ({ project_id: `p${i}`, listing: listing({ v: 1, attention: i === 1 ? 'approval' : null, working: i === 2, finished: [], stage }) }));
    rows.push({ project_id: 'old', listing: listing(null, { gate: 'open' }) } as never, { project_id: 'unfilled', listing: null } as never, { project_id: '' } as never);
    const pages = [rows.slice(0, STAGE_PAGE_SIZE), rows.slice(STAGE_PAGE_SIZE)];
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), range: vi.fn().mockReturnThis(), abortSignal: vi.fn() };
    query.abortSignal.mockImplementation(() => Promise.resolve({ data: pages.shift() ?? [], error: null }));
    auth.from.mockClear();
    auth.from.mockReturnValue(query);
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'A' }, access_token: 'example' } } });
    const signal = new AbortController().signal;
    await expect(loadComicStages('B', signal)).rejects.toThrow();
    expect(auth.from).not.toHaveBeenCalled();

    const out = await loadComicStages('A', signal);
    expect(auth.from).toHaveBeenCalledTimes(2);
    expect(auth.from).toHaveBeenCalledWith('comic_docs');
    expect(query.select.mock.calls).toEqual([[STAGE_SELECT], [STAGE_SELECT]]);
    // Not one path into the doc: the database never opens a comic to list it.
    expect(STAGE_SELECT).toBe('project_id,listing');
    expect(query.eq).toHaveBeenCalledWith('user_id', 'A');
    expect(query.range.mock.calls).toEqual([[0, STAGE_PAGE_SIZE - 1], [STAGE_PAGE_SIZE, 2 * STAGE_PAGE_SIZE - 1]]);
    expect(out.size).toBe(STAGE_PAGE_SIZE + 4);
    expect(out.get('p0')).toEqual({ id: 'p0', stage, attention: null, working: false });
    expect(out.get('p1')?.attention).toBe('approval');
    expect(out.get('p2')?.working).toBe(true);
    // A doc saved before summaries: no stage, and its open approval still reads as waiting on the person.
    expect(out.get('old')).toEqual({ id: 'old', attention: 'approval', working: false });
    expect(out.get('unfilled')).toEqual({ id: 'unfilled', attention: null, working: false });
    expect(out.has('')).toBe(false);
  });

  it('a database without the listing column yet reads the same values from scalar paths in the doc', async () => {
    const stage = { v: 1, stage: 'draw', done: ['story', 'style', 'plan'], pages: 12, planned: 12, drawn: 6, current: 6, outOfDate: 0, drawing: 0, withheld: 0, failed: 0, looks: 0, paused: false, next: 'draw_rest' };
    const answers = [
      { data: null, error: { code: '42703', message: 'column comic_docs.listing does not exist' } },
      { data: [{ project_id: 'p', activity: { v: 1, attention: 'question', working: false, finished: [], stage } }, { project_id: 'old', gate: 'open' }], error: null }
    ];
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), range: vi.fn().mockReturnThis(), abortSignal: vi.fn(() => Promise.resolve(answers.shift())) };
    auth.from.mockReturnValue(query);
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'A' }, access_token: 'example' } } });
    const out = await loadComicStages('A', new AbortController().signal);
    expect(query.select.mock.calls).toEqual([[STAGE_SELECT], [STAGE_DOC_SELECT]]);
    // Never the doc itself, its text or anything private: the summary and four scalar keys.
    expect(STAGE_DOC_SELECT.split(',')).toEqual(['project_id', 'activity:doc->workspaceActivity', 'gate:doc->gate->>status', 'plan:doc->>planStatus', 'draft:doc->directorDraft->>status', 'lastCard:doc->conversation->-1->cards->0->>type']);
    expect(out.get('p')).toEqual({ id: 'p', stage, attention: 'question', working: false });
    expect(out.get('old')).toEqual({ id: 'old', attention: 'approval', working: false });
  });

  it('a failed page fails the read (the cards keep their row counts and read "Open to see")', async () => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), range: vi.fn().mockReturnThis(), abortSignal: vi.fn().mockResolvedValue({ data: null, error: { code: '42501' } }) };
    auth.from.mockReturnValue(query);
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'A' }, access_token: 'example' } } });
    await expect(loadComicStages('A', new AbortController().signal)).rejects.toThrow('Comic stages unavailable');
    // Any other failure is just a failure: it never falls back to opening the docs.
    expect(query.select.mock.calls).toEqual([[STAGE_SELECT]]);
  });
});
