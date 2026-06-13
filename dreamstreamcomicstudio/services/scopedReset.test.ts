import { describe, it, expect } from 'vitest';
import { diffScenes, diffWorld, invalidationPlan, scopedScriptReanalysis } from './scopedReset';
import type { ComicState, Scene } from '../types';

const scene = (id: number, synopsis: string): Scene => ({
  id, rawText: synopsis, synopsis, characters: ['Maya'], setting: 'Rooftop',
});

const panel = (id: string, sceneId: number): any => ({
  id, sceneId, description: 'x', dialogue: '', imageId: `i${id}`, imageUrl: `u${id}`, imageIdHistory: [],
});

describe('diffScenes', () => {
  it('classifies unchanged / changed / added / removed by content', () => {
    const oldS = [scene(1, 'intro'), scene(2, 'vault'), scene(3, 'gone')];
    const newS = [scene(1, 'intro'), { ...scene(2, 'vault'), synopsis: 'vault — now at night' }, scene(4, 'new')];
    const d = diffScenes(oldS, newS);
    expect(d.unchanged).toEqual([1]);
    expect(d.changed).toEqual([2]);
    expect(d.added).toEqual([4]);
    expect(d.removed).toEqual([3]);
  });
});

describe('diffWorld', () => {
  it('keeps surviving entities by name and flags removed/added', () => {
    const before = { characters: [{ name: 'Maya' }, { name: 'Cole' }], items: [], locations: [{ name: 'Vault' }] } as any;
    const after = { characters: [{ name: 'Maya' }], items: [{ name: 'Keycard' }], locations: [{ name: 'Vault' }] } as any;
    const d = diffWorld(before, after);
    expect(d.surviving.sort()).toEqual(['Maya', 'Vault']);
    expect(d.removed).toEqual(['Cole']);
    expect(d.added).toEqual(['Keycard']);
  });
});

describe('invalidationPlan', () => {
  it('keeps panels of unchanged scenes and only resets dirty ones', () => {
    const state = {
      scenes: [scene(1, 'intro'), scene(2, 'vault')],
      panels: [panel('a', 1), panel('b', 1), panel('c', 2)],
    } as Pick<ComicState, 'scenes' | 'panels'>;
    const next = [scene(1, 'intro'), { ...scene(2, 'vault'), synopsis: 'vault changed' }];
    const plan = invalidationPlan(state, next);
    expect(plan.keptPanelIds.sort()).toEqual(['a', 'b']);
    expect(plan.resetPanelIds).toEqual(['c']);
    expect(plan.keepsStyle).toBe(true);
    expect(plan.summary).toContain('1 scene');
  });

  it('resets nothing when content is identical', () => {
    const state = { scenes: [scene(1, 'intro')], panels: [panel('a', 1)] } as Pick<ComicState, 'scenes' | 'panels'>;
    const plan = invalidationPlan(state, [scene(1, 'intro')]);
    expect(plan.resetPanelIds).toEqual([]);
    expect(plan.summary).toContain('nothing to re-plan');
  });
});

describe('scopedScriptReanalysis', () => {
  it('drops only dirty-scene panels and preserves style fields', () => {
    const state = {
      script: 'old', scenes: [scene(1, 'intro'), scene(2, 'vault')],
      panels: [panel('a', 1), panel('c', 2)],
      styleVariants: [{ id: 'sv' }], selectedStyleId: 's1', stylePrompt: 'noir', styleAspectRatio: '3:4', imageResolution: '2K',
    } as unknown as ComicState;
    const next = [scene(1, 'intro'), { ...scene(2, 'vault'), synopsis: 'changed' }];
    const { patch } = scopedScriptReanalysis(state, 'new script', next);
    expect(patch.panels?.map((p) => p.id)).toEqual(['a']);
    expect(patch.script).toBe('new script');
    // style untouched (absent from patch => preserved by the spread at the call site)
    expect('selectedStyleId' in patch).toBe(false);
    expect('styleVariants' in patch).toBe(false);
  });
});
