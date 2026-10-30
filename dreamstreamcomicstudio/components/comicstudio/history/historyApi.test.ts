// historyApi speaks the owner routes' exact shapes (versions plan §14 H3), so the server package drops in: paths,
// query, the urls batch, and tolerant parsing (a malformed row is dropped, never half-rendered; only http(s)/blob/
// data-image URLs are kept; every failure becomes a calm StudioApiError).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../services/apiClient', () => ({ get: getMock, post: postMock, del: vi.fn(), patch: vi.fn(), postStream: vi.fn() }));

import { historyFixture } from './__scenes__/historyFixtures';
import { asListResponse, asVersionRow, HISTORY_ROUTES, HISTORY_URL_BATCH, httpHistoryApi } from './historyApi';

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

const fx = () => historyFixture('v5');

describe('routes', () => {
  it('every path is under /api/comic/projects/:id/history, ids encoded', () => {
    expect(HISTORY_ROUTES.list('p 1')).toBe('/api/comic/projects/p%201/history');
    expect(HISTORY_ROUTES.compare('p1')).toBe('/api/comic/projects/p1/history/compare');
    expect(HISTORY_ROUTES.detail('p1', 'v/1')).toBe('/api/comic/projects/p1/history/v%2F1');
    expect(HISTORY_ROUTES.book('p1', 'v1')).toBe('/api/comic/projects/p1/history/v1/book');
    expect(HISTORY_ROUTES.urls('p1', 'v1')).toBe('/api/comic/projects/p1/history/v1/urls');
    expect(HISTORY_ROUTES.legacy('p1')).toBe('/api/comic/projects/p1/history/legacy');
  });

  it('list sends cursor, filter, pageId and limit; reads rows, next and the signed thumbs', async () => {
    const row = fx().versions[0].row;
    getMock.mockResolvedValue({ rows: [row, { id: 'bad' }], next: 'c2', urls: { 'a.webp': 'https://cdn.example/a.webp', 'x.webp': 'javascript:alert(1)' } });
    const res = await httpHistoryApi.list('p1', { cursor: 'c1', filter: 'page', pageId: 'pg_3', limit: 20 });
    expect(getMock.mock.calls[0][0]).toBe('/api/comic/projects/p1/history?cursor=c1&filter=page&pageId=pg_3&limit=20');
    expect(res.rows.map((r) => r.id)).toEqual([row.id]);
    expect(res.next).toBe('c2');
    expect(res.urls).toEqual({ 'a.webp': 'https://cdn.example/a.webp' });
    getMock.mockResolvedValue({ rows: [] });
    await httpHistoryApi.list('p1');
    expect(getMock.mock.calls[1][0]).toBe('/api/comic/projects/p1/history?limit=50');
  });

  it('compare sends a and b; book normalizes the doc; urls batches by 100', async () => {
    const f = fx();
    getMock.mockResolvedValueOnce({ a: { ref: 'v1', kind: 'version', row: f.versions[2].row }, b: { ref: 'now', kind: 'now' }, diff: { pages: [], same: true }, docs: { a: f.versions[2].doc, b: f.live }, urls: {} });
    const cmp = await httpHistoryApi.compare('p1', 'v1', 'now');
    expect(getMock.mock.calls[0][0]).toBe('/api/comic/projects/p1/history/compare?a=v1&b=now');
    expect(cmp.a.row?.id).toBe('ver_before');
    expect(cmp.docs.b.pages).toHaveLength(6);
    getMock.mockResolvedValueOnce({ row: f.versions[2].row, doc: { ...f.versions[2].doc, pages: undefined }, urls: {} });
    const book = await httpHistoryApi.book('p1', 'v1');
    expect(Array.isArray(book.doc.pages)).toBe(true);
    postMock.mockImplementation(async (_path: string, body: { paths: string[] }) => ({ urls: Object.fromEntries(body.paths.map((p) => [p, `https://cdn.example/${p}`])) }));
    const paths = Array.from({ length: HISTORY_URL_BATCH + 5 }, (_, i) => `p${i}.webp`);
    const urls = await httpHistoryApi.urls('p1', 'v1', [...paths, paths[0]]);
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(postMock.mock.calls[0][0]).toBe('/api/comic/projects/p1/history/v1/urls');
    expect(Object.keys(urls)).toHaveLength(HISTORY_URL_BATCH + 5);
  });

  it('a classic snapshot starts a new comic through POST /projects {importFromProjectId, fromVersionId}', async () => {
    postMock.mockResolvedValue({ projectId: 'proj_new', doc: {}, urls: {} });
    expect(await httpHistoryApi.startFromClassicSnapshot('classic_1', 'snap_2')).toEqual({ projectId: 'proj_new' });
    expect(postMock).toHaveBeenCalledWith('/api/comic/projects', { importFromProjectId: 'classic_1', fromVersionId: 'snap_2' });
  });

  it('a failure is a calm StudioApiError (the same 404 for a foreign or missing id)', async () => {
    getMock.mockRejectedValue(Object.assign(new Error("This comic doesn't exist or you don't have access to it."), { status: 404 }));
    await expect(httpHistoryApi.detail('p1', 'nope')).rejects.toMatchObject({ name: 'StudioApiError', kind: 'not_found' });
  });
});

describe('parsing', () => {
  it('a row without id, kind or time is dropped; an unknown actor reads as saved automatically', () => {
    expect(asVersionRow({ kind: 'edits', contentAt: 1 })).toBeNull();
    expect(asVersionRow({ id: 'a', kind: 'weird', contentAt: 1 })).toBeNull();
    const r = asVersionRow({ id: 'a', kind: 'edits', contentAt: 5, actor: 'robot', changes: [{ what: 'art' }, 'x'], thumbs: [{ key: 'cover', path: 'c.webp' }, { key: 1 }] })!;
    expect(r.actor).toBe('system');
    expect(r.changes).toHaveLength(1);
    expect(r.thumbs).toHaveLength(1);
    expect(r.createdAt).toBe(5);
    expect(asListResponse(null)).toEqual({ rows: [], next: null, urls: {} });
  });
});
