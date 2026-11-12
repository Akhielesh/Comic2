// EGRESS-DB E1 review: App shows a comic's library card in the editor when its full state failed to load. The real
// ComicEditor, mounted on that card, must emit no change that would replace the comic's image tags once applied to
// the full state (its image-tag effect used to rebuild them from the card's absent map: PANEL-0007 became
// PANEL-0001). On a full comic the effect still tags a new image.
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';

vi.mock('./studio/comic/ComicStreamView', () => ({ ComicStreamView: () => <div /> }));
vi.mock('./studio/comic/AgentSettingsPanel', () => ({ AgentSettingsPanel: () => null }));
vi.mock('../services/geminiService', () => ({ analyzeScriptDetailed: vi.fn(), checkDeploymentParity: vi.fn(async () => null) }));

import { ComicEditor } from './ComicEditor';
import { projectCardStateOf } from '../services/db';

const fullState = {
  pipelineMode: 'classic', flowVersion: 4, step: 6, maxStepReached: 7, script: 'Script', scenes: [], overview: '', comments: [],
  panels: [{ id: 'p1', imageId: 'user-1/p1.png' }], styleVariants: [], characters: [], items: [], locations: [],
  imageTags: { 'user-1/p1.png': { imageId: 'user-1/p1.png', tag: 'PANEL-0007', category: 'PANEL', createdAt: 1 } },
  imageTagCounters: { PANEL: 7 }, versions: [{ id: 'v1', name: 'Old', createdAt: 1, state: {} }]
};
type Update = Partial<Project> | ((p: Project) => Partial<Project>);
const applyAll = (base: Project, updates: Update[]) =>
  updates.reduce<Project>((applied, u) => ({ ...applied, ...(typeof u === 'function' ? u(applied) : u) }) as Project, base);
const mountEditor = async (project: Project) => {
  const updates: Update[] = [];
  render(<ComicEditor project={project} onUpdate={(u) => updates.push(u)} onStartGeneration={() => undefined} onStopGeneration={() => undefined} onBack={() => undefined} />);
  await act(async () => undefined);
  return updates;
};

describe('ComicEditor on a library card', () => {
  it('emits no change that, applied to the full state, replaces imageTags', async () => {
    const card = { id: 'c1', name: 'Comic', createdAt: 1, updatedAt: 1, state: projectCardStateOf({ ...fullState }) } as unknown as Project;
    const full = { ...card, state: fullState } as unknown as Project;
    const applied = applyAll(full, await mountEditor(card));
    expect((applied.state as any).imageTags['user-1/p1.png'].tag).toBe('PANEL-0007');
    expect((applied.state as any).imageTagCounters.PANEL).toBe(7);
  });

  it('on the full comic it still tags an image that has no tag yet', async () => {
    const state = { ...fullState, panels: [...fullState.panels, { id: 'p2', imageId: 'user-1/p2.png' }] };
    const full = { id: 'c1', name: 'Comic', createdAt: 1, updatedAt: 1, state } as unknown as Project;
    const updates = await mountEditor(full);
    expect(updates.length).toBeGreaterThan(0);
    const tags = (applyAll(full, updates).state as any).imageTags;
    expect(tags['user-1/p1.png'].tag).toBe('PANEL-0007');
    expect(tags['user-1/p2.png'].tag).toBe('PANEL-0008');
  });
});
