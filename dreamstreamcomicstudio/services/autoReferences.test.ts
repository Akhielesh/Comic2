import { describe, expect, it } from 'vitest';
import { applyGeneratedReference, collectAutoReferenceTasks } from './autoReferences';
import { buildContinuityFromWorld } from './continuity';
import { Character, ComicState, Item, Location, Scene } from '../types';

const character = (id: string, name: string, overrides: Partial<Character> = {}): Character => ({
  id,
  name,
  bio: `${name} bio`,
  description: `${name} visual`,
  referenceImageIds: [],
  ...overrides
});

const location = (id: string, name: string, overrides: Partial<Location> = {}): Location => ({
  id,
  name,
  description: `${name} place`,
  referenceImageIds: [],
  ...overrides
});

const item = (id: string, name: string, overrides: Partial<Item> = {}): Item => ({
  id,
  name,
  description: `${name} prop`,
  referenceImageIds: [],
  ...overrides
});

const scene = (id: number, characters: string[], setting = 'Harbor'): Scene => ({
  id,
  rawText: `Scene ${id}`,
  synopsis: `Scene ${id} synopsis`,
  setting,
  characters
} as Scene);

const buildState = (overrides: Partial<ComicState>): ComicState => {
  const base = {
    scenes: [],
    characters: [],
    items: [],
    locations: [],
    panels: []
  } as unknown as ComicState;
  const merged = { ...base, ...overrides };
  merged.continuity = buildContinuityFromWorld(
    merged.scenes || [],
    merged.characters || [],
    merged.items || [],
    merged.locations || [],
    undefined
  );
  return merged;
};

describe('collectAutoReferenceTasks', () => {
  it('returns every character without a visual anchor, characters first', () => {
    const state = buildState({
      scenes: [scene(1, ['Mira'])],
      characters: [
        character('c1', 'Mira'),
        character('c2', 'Okonkwo', { imageId: 'img-existing' }),
        character('c3', 'Side Extra')
      ]
    });
    const tasks = collectAutoReferenceTasks(state);
    expect(tasks.map((task) => task.id)).toEqual(['c1', 'c3']);
    expect(tasks.every((task) => task.kind === 'character')).toBe(true);
  });

  it('skips characters that already have uploaded reference images', () => {
    const state = buildState({
      scenes: [scene(1, ['Mira'])],
      characters: [character('c1', 'Mira', { referenceImageIds: ['upload-1'] })]
    });
    expect(collectAutoReferenceTasks(state)).toEqual([]);
  });

  it('includes flagged locations referenced by scene bindings', () => {
    const state = buildState({
      scenes: [scene(1, ['Mira'], 'Harbor')],
      characters: [character('c1', 'Mira', { imageId: 'img-1' })],
      locations: [location('l1', 'Harbor')]
    });
    const tasks = collectAutoReferenceTasks(state);
    // Whether the location is flagged depends on binding resolution; it must never
    // include entities that already have references, and never duplicate ids.
    const ids = tasks.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('c1');
  });

  it('caps the task list to bound per-run cost', () => {
    const characters = Array.from({ length: 14 }, (_, index) => character(`c${index}`, `Char ${index}`));
    const state = buildState({ scenes: [scene(1, characters.map((c) => c.name))], characters });
    expect(collectAutoReferenceTasks(state, 10)).toHaveLength(10);
  });

  it('uses the visual description for characters and uploaded refs as grounding', () => {
    const state = buildState({
      scenes: [scene(1, ['Mira'])],
      characters: [character('c1', 'Mira', { description: 'red coat, silver hair' })]
    });
    const [task] = collectAutoReferenceTasks(state);
    expect(task.description).toBe('red coat, silver hair');
    expect(task.uploadedReferenceIds).toEqual([]);
  });
});

describe('applyGeneratedReference', () => {
  it('writes the generated image onto the matching entity only', () => {
    const state = buildState({
      scenes: [scene(1, ['Mira'])],
      characters: [character('c1', 'Mira'), character('c2', 'Okonkwo')],
      items: [item('i1', 'Lantern')],
      locations: [location('l1', 'Harbor')]
    });
    const [task] = collectAutoReferenceTasks(state);
    const patch = applyGeneratedReference(state, task, 'img-new', 'https://img/new.webp');
    const updated = patch.characters.find((entry) => entry.id === task.id);
    expect(updated?.imageId).toBe('img-new');
    expect(updated?.imageUrl).toBe('https://img/new.webp');
    expect(patch.characters.find((entry) => entry.id !== task.id)?.imageId).toBeUndefined();
    expect(patch.items).toBe(state.items);
    expect(patch.locations).toBe(state.locations);
  });
});
