// EGRESS-DB E5: artifacts are read without `responseText` (a third of the table's bytes, rendered by none of the
// cost panels or the assistant), memoised per project for 5 minutes, and dropped from the memo when one is saved.
// An export still carries every artifact whole.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { columnsRead, fakeSupabase, jsonBytes, projectRow } from './projectRows.testkit';

vi.mock('./supabase', async () => ({ supabase: (await import('./projectRows.testkit')).fakeSupabase.client }));

const db = await import('./db');
const { ARTIFACT_MEMO_TTL_MS, ARTIFACT_SLIM_SELECT, countArtifactsForProject, exportProject, invalidateArtifactMemo, loadArtifactsForProject, saveArtifact } = db;

const artifact = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: 'p1',
  timestamp: 1_700_000_000_000,
  type: 'text',
  provider: 'openrouter',
  model: 'some/model',
  prompt: 'Write the next scene',
  responseText: `RESPONSE ${'x'.repeat(4_000)}`,
  stage: 'script',
  success: true,
  usage: { promptTokens: 10, candidatesTokens: 900, totalTokens: 910 },
  timings: { apiMs: 1200 },
  meta: { scene: 1 },
  outputImageId: 'u1/out.png',
  inputImageIds: ['u1/in.png'],
  fallbackOccurred: true,
  fallbackFromModel: 'a/b',
  fallbackToModel: 'c/d',
  referenceCount: 2,
  styleLockUsed: false,
  cost: { currency: 'USD', value: 0.01, isEstimated: false },
  ...extra
});
const row = (data: Record<string, unknown>, projectId = 'p1') => ({ id: `row-${data.id}`, user_id: 'user-1', project_id: projectId, data, created_at: '2026-10-01T00:00:00Z' });
const artifactReads = () => fakeSupabase.queriesOn('artifacts');

beforeEach(() => {
  fakeSupabase.reset();
  invalidateArtifactMemo();
  fakeSupabase.state.tables.artifacts = [row(artifact('a1')), row(artifact('a2', { type: 'image', error: 'safety' })), row(artifact('b1'), 'p2')];
});
afterEach(() => vi.useRealTimers());

describe('loadArtifactsForProject (slim)', () => {
  it('never selects `responseText` (nor the bare `data` or `*`), and keeps every other field', async () => {
    const items = ARTIFACT_SLIM_SELECT.split(',');
    expect(items).not.toContain('data');
    expect(items).not.toContain('*');
    expect(ARTIFACT_SLIM_SELECT).not.toMatch(/responseText/);
    for (const item of items) expect(columnsRead(item)).toEqual(['data']);

    const loaded = await loadArtifactsForProject('p1');
    expect(artifactReads()).toHaveLength(1);
    expect(artifactReads()[0]).toMatchObject({ columns: ARTIFACT_SLIM_SELECT, filters: ['project_id=eq.p1'] });
    expect(loaded).toHaveLength(2);
    const { responseText: _dropped, ...rest } = artifact('a1');
    expect(loaded[0]).toEqual(rest);
    expect('responseText' in loaded[0]).toBe(false);
    expect(loaded[1]).toMatchObject({ id: 'a2', type: 'image', error: 'safety' });

    // The bytes on the wire: the response text was most of each row.
    const rows = fakeSupabase.state.tables.artifacts.filter((r) => r.project_id === 'p1');
    expect(jsonBytes(rows.map((r) => projectRow(r, ARTIFACT_SLIM_SELECT)))).toBeLessThan(jsonBytes(rows.map((r) => projectRow(r, 'data'))) / 2);
  });

  it('a field the artifact lacks stays absent (not null)', async () => {
    fakeSupabase.state.tables.artifacts = [row({ id: 'bare', projectId: 'p1', timestamp: 1, type: 'system', model: 'm', prompt: '' })];
    const [bare] = await loadArtifactsForProject('p1');
    expect(bare).toEqual({ id: 'bare', projectId: 'p1', timestamp: 1, type: 'system', model: 'm', prompt: '' });
  });

  it('is memoised per project for 5 minutes, one read shared by concurrent callers, a copy per caller', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
    const [a, b] = await Promise.all([loadArtifactsForProject('p1'), loadArtifactsForProject('p1')]);
    expect(artifactReads()).toHaveLength(1);
    a.sort((x, y) => (x.id < y.id ? 1 : -1));
    expect(b.map((x) => x.id)).toEqual(['a1', 'a2']);
    expect((await loadArtifactsForProject('p1')).map((x) => x.id)).toEqual(['a1', 'a2']);
    await loadArtifactsForProject('p2');
    expect(artifactReads()).toHaveLength(2);
    vi.setSystemTime(new Date(Date.parse('2026-11-12T00:00:00Z') + ARTIFACT_MEMO_TTL_MS));
    await loadArtifactsForProject('p1');
    expect(artifactReads()).toHaveLength(3);
  });

  it('saveArtifact drops the project from the memo', async () => {
    expect(await loadArtifactsForProject('p1')).toHaveLength(2);
    await saveArtifact(artifact('a3') as never);
    expect(fakeSupabase.state.inserts).toHaveLength(1);
    expect((await loadArtifactsForProject('p1')).map((x) => x.id)).toEqual(['a1', 'a2', 'a3']);
    expect(artifactReads()).toHaveLength(2);
  });

  it('a failed read returns [] and is not kept', async () => {
    fakeSupabase.state.failures.push({ when: (q) => q.table === 'artifacts', error: { code: '57014', message: 'timeout' } });
    expect(await loadArtifactsForProject('p1')).toEqual([]);
    expect(await loadArtifactsForProject('p1')).toHaveLength(2);
    expect(artifactReads()).toHaveLength(2);
  });

  it('{ withResponse: true } reads the whole artifact, every time', async () => {
    const full = await loadArtifactsForProject('p1', { withResponse: true });
    expect(full[0].responseText).toContain('RESPONSE');
    await loadArtifactsForProject('p1', { withResponse: true });
    expect(artifactReads().map((q) => q.columns)).toEqual(['data', 'data']);
  });

  it('an export carries every artifact whole', async () => {
    fakeSupabase.state.tables.projects = [{ id: 'p1', user_id: 'user-1', name: 'P', state: {} }];
    const exported = await exportProject('p1');
    expect(exported.artifacts).toHaveLength(2);
    expect(exported.artifacts[0].responseText).toContain('RESPONSE');
  });
});

describe('countArtifactsForProject', () => {
  it('is a HEAD count on id (no rows), memoised', async () => {
    expect(await countArtifactsForProject('p1')).toBe(2);
    expect(await countArtifactsForProject('p1')).toBe(2);
    expect(artifactReads()).toHaveLength(1);
    expect(artifactReads()[0]).toMatchObject({ columns: 'id', head: true, count: 'exact', filters: ['project_id=eq.p1'] });
  });

  it('uses a fresh memoised list instead of asking again', async () => {
    await loadArtifactsForProject('p1');
    expect(await countArtifactsForProject('p1')).toBe(2);
    expect(artifactReads()).toHaveLength(1);
  });

  it('saveArtifact drops the count too', async () => {
    expect(await countArtifactsForProject('p1')).toBe(2);
    await saveArtifact(artifact('a3') as never);
    expect(await countArtifactsForProject('p1')).toBe(3);
  });
});

describe('the artifact memo belongs to the signed-in account (EGRESS-DB review)', () => {
  it('another account signed in on the same tab reads again; the first account still gets its memo', async () => {
    await loadArtifactsForProject('p1');
    expect(artifactReads()).toHaveLength(1);
    fakeSupabase.state.userId = 'user-2';
    await loadArtifactsForProject('p1');
    expect(await countArtifactsForProject('p1')).toBe(2);
    expect(artifactReads()).toHaveLength(2);
    fakeSupabase.state.userId = 'user-1';
    await loadArtifactsForProject('p1');
    expect(artifactReads()).toHaveLength(2);
  });

  it('a read without a session is never kept', async () => {
    fakeSupabase.state.userId = null;
    await loadArtifactsForProject('p1');
    await loadArtifactsForProject('p1');
    await countArtifactsForProject('p1');
    await countArtifactsForProject('p1');
    expect(artifactReads()).toHaveLength(4);
    fakeSupabase.state.userId = 'user-1';
    await loadArtifactsForProject('p1');
    expect(artifactReads()).toHaveLength(5);
  });

  it('saveArtifact drops the project for every account', async () => {
    await loadArtifactsForProject('p1');
    fakeSupabase.state.userId = 'user-2';
    await loadArtifactsForProject('p1');
    await saveArtifact(artifact('a3') as never);
    await loadArtifactsForProject('p1');
    fakeSupabase.state.userId = 'user-1';
    await loadArtifactsForProject('p1');
    expect(artifactReads()).toHaveLength(4);
  });
});
