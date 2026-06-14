import { describe, it, expect } from 'vitest';
import { planBeats } from './beatPlanner';
import type { Scene } from '../types';

const scenes = (n: number): Scene[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, rawText: '', synopsis: `Scene ${i + 1}`, characters: [], setting: '' }));

describe('planBeats', () => {
  it('returns an empty plan for no scenes', () => {
    expect(planBeats([], 4, 3)).toEqual({ beats: [], totalPanels: 0, pages: 4, panelsPerPage: 3 });
  });

  it('distributes the page budget across scenes (earlier scenes absorb remainder)', () => {
    const plan = planBeats(scenes(3), 3, 3); // target 9 across 3 scenes => 3 each
    expect(plan.totalPanels).toBe(9);
    expect(plan.beats).toHaveLength(3);
    expect(plan.beats.map((b) => b.panelCount)).toEqual([3, 3, 3]);
  });

  it('splits a scene that exceeds the per-beat cap of 8', () => {
    // 1 scene, 5 pages * 3 = 15 panels => one scene over the cap => splits into 2 beats (8 + 7)
    const plan = planBeats(scenes(1), 5, 3);
    expect(plan.totalPanels).toBe(15);
    expect(plan.beats.length).toBe(2);
    expect(Math.max(...plan.beats.map((b) => b.panelCount))).toBeLessThanOrEqual(8);
    expect(plan.beats[0].synopsis).toContain('part 1/2');
  });

  it('auto mode (no pages) gives ~3 panels per scene', () => {
    const plan = planBeats(scenes(4), 0, 3);
    expect(plan.totalPanels).toBe(12);
    expect(plan.beats.every((b) => b.panelCount <= 8)).toBe(true);
  });

  it('never drops below one panel per scene', () => {
    const plan = planBeats(scenes(5), 1, 1); // target max(5, 1) = 5 across 5 scenes => 1 each
    expect(plan.beats).toHaveLength(5);
    expect(plan.beats.every((b) => b.panelCount >= 1)).toBe(true);
  });
});
