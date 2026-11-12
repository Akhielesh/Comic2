// EGRESS-DB E5: the assistant's all-projects summary (up to 12 comics per message) reads no artifact body: each
// count is a HEAD count. Only the active project loads its (slim) artifacts, once. Summaries also read library
// cards (EGRESS-DB E1), whose state is a subset.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../types';
import { fakeSupabase } from './projectRows.testkit';

vi.mock('./supabase', async () => ({ supabase: (await import('./projectRows.testkit')).fakeSupabase.client }));

const { invalidateArtifactMemo, loadArtifactsForProject, loadProjects } = await import('./db');
const { buildProjectSnapshot, summarizeAllProjects, summarizeProject } = await import('./assistantContext');

const state = (extra: Record<string, unknown> = {}) =>
  ({
    step: 3,
    script: 'A script',
    scenes: [{ id: 1, rawText: 'x', synopsis: 'x', characters: [], setting: 'x' }],
    panels: [{ id: 'p1', imageId: 'u1/p1.png' }],
    styleVariants: [],
    characters: [],
    items: [],
    locations: [],
    comments: [{ id: 'c1', text: 'hi', createdAt: 1, likes: 2, dislikes: 1 }],
    pricingConfig: { currency: 'USD', models: { 'some/model': { inputPer1k: 0.001, outputPer1k: 0.002 } } },
    ...extra
  }) as unknown as ComicState;
const project = (id: string, extra: Record<string, unknown> = {}): Project => ({ id, name: `Comic ${id}`, createdAt: 1, updatedAt: 2, state: state(extra) });
const artifact = (id: string, projectId: string) => ({
  id,
  projectId,
  timestamp: 1,
  type: 'text',
  model: 'some/model',
  prompt: 'prompt',
  responseText: 'r'.repeat(5_000),
  usage: { promptTokens: 1000, candidatesTokens: 1000, totalTokens: 2000 }
});
const bodyReads = () => fakeSupabase.queriesOn('artifacts').filter((q) => !q.head);
const headCounts = () => fakeSupabase.queriesOn('artifacts').filter((q) => q.head);

beforeEach(() => {
  fakeSupabase.reset();
  invalidateArtifactMemo();
  fakeSupabase.state.tables.artifacts = ['p1', 'p1', 'p2', 'p3', 'p3', 'p3'].map((projectId, i) => ({
    id: `row-${i}`,
    project_id: projectId,
    data: artifact(`a${i}`, projectId)
  }));
});

describe('summarizeAllProjects', () => {
  it('reads no artifact body: one HEAD count per project', async () => {
    const projects = ['p1', 'p2', 'p3', 'p4'].map((id) => project(id));
    const summaries = await summarizeAllProjects(projects);
    expect(bodyReads()).toHaveLength(0);
    expect(headCounts()).toHaveLength(4);
    expect(summaries.map((s) => [s.id, s.artifacts, s.storage?.artifactsCount])).toEqual([
      ['p1', 2, 2],
      ['p2', 1, 1],
      ['p3', 3, 3],
      ['p4', 0, 0]
    ]);
    // No artifacts read, so no cost is claimed for them.
    expect(summaries.every((s) => s.cost === undefined)).toBe(true);
    expect(summaries[0]).toMatchObject({ scenes: 1, panels: 1, scriptLength: 8, comments: { count: 1, likes: 2, dislikes: 1 } });
  });

  it('the active project loads its slim artifacts once, however many callers ask', async () => {
    const active = project('p1');
    const [summary, artifacts, all] = await Promise.all([summarizeProject(active), loadArtifactsForProject('p1'), summarizeAllProjects([active, project('p2')])]);
    expect(bodyReads()).toHaveLength(1);
    expect(bodyReads()[0].columns).not.toMatch(/responseText/);
    expect(artifacts).toHaveLength(2);
    expect(summary.artifacts).toBe(2);
    expect(summary.cost?.totalCost).toBeGreaterThan(0);
    // The active project's count comes from its list; only the other one needs a HEAD count.
    expect(all.map((s) => s.artifacts)).toEqual([2, 1]);
    expect(headCounts()).toHaveLength(1);
  });
});

describe('summaries of library cards (EGRESS-DB E1)', () => {
  it('summarize and snapshot a card whose state lacks keys without throwing', async () => {
    fakeSupabase.state.tables.projects = [
      { id: 'old', user_id: 'user-1', name: 'Old comic', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', state: { step: 1 } },
      { id: 'v4', user_id: 'user-1', name: 'Studio comic', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-03T00:00:00Z', state: { studioVersion: 4, studioPages: 3, versions: [{ id: 'v' }] } }
    ];
    const cards = await loadProjects();
    const summaries = await summarizeAllProjects(cards);
    expect(summaries.map((s) => [s.id, s.scenes, s.panels, s.scriptLength])).toEqual([
      ['v4', 0, 0, 0],
      ['old', 0, 0, 0]
    ]);
    expect(() => buildProjectSnapshot(cards[0])).not.toThrow();
    expect(buildProjectSnapshot(cards[1]).counts).toEqual({ scenes: 0, panels: 0, characters: 0, items: 0, locations: 0, styleVariants: 0 });
  });
});
