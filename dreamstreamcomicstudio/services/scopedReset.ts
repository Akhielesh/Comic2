// Scoped, diff-aware invalidation (v3 spec §3.1).
//
// Today, re-analyzing a script clears style, world art, layout and *every* panel — a typo
// costs the whole comic. These pure helpers compute the MINIMAL invalidation: diff scenes
// (and world entities) by content hash, keep panels for unchanged scenes, and never reset
// style for a script edit. The agent can announce the plan before acting and the editor can
// adopt it to stop nuking everything. Pure + unit-testable; no engine/IO dependencies.

import type { ComicPanel, ComicState, Scene } from '../types';
import { stableHash } from './pipelineFingerprint';

/** Content hash of a single scene (id excluded — identity is matched separately by id). */
export const sceneContentHash = (scene: Scene): string =>
  stableHash(
    JSON.stringify({
      rawText: scene.rawText || '',
      synopsis: scene.synopsis || '',
      setting: scene.setting || '',
      characters: scene.characters || [],
    }),
  );

export interface SceneDiff {
  unchanged: number[];
  changed: number[];
  added: number[];
  removed: number[];
}

/** Diff scenes by id, then by content hash — which scenes are unchanged/changed/added/removed. */
export const diffScenes = (oldScenes: Scene[] = [], newScenes: Scene[] = []): SceneDiff => {
  const oldHash = new Map(oldScenes.map((s) => [s.id, sceneContentHash(s)]));
  const newIds = new Set(newScenes.map((s) => s.id));
  const unchanged: number[] = [];
  const changed: number[] = [];
  const added: number[] = [];
  for (const s of newScenes) {
    if (!oldHash.has(s.id)) added.push(s.id);
    else if (oldHash.get(s.id) !== sceneContentHash(s)) changed.push(s.id);
    else unchanged.push(s.id);
  }
  const removed = oldScenes.filter((s) => !newIds.has(s.id)).map((s) => s.id);
  return { unchanged, changed, added, removed };
};

const entityNames = (state: Pick<ComicState, 'characters' | 'items' | 'locations'>): string[] => [
  ...(state.characters || []).map((c) => c.name),
  ...(state.items || []).map((i) => i.name),
  ...(state.locations || []).map((l) => l.name),
].filter(Boolean);

export interface WorldDiff {
  surviving: string[];
  removed: string[];
  added: string[];
}

/** Diff world entities by name — surviving entities keep their reference sheets. */
export const diffWorld = (
  oldState: Pick<ComicState, 'characters' | 'items' | 'locations'>,
  newState: Pick<ComicState, 'characters' | 'items' | 'locations'>,
): WorldDiff => {
  const before = new Set(entityNames(oldState));
  const after = new Set(entityNames(newState));
  return {
    surviving: [...after].filter((n) => before.has(n)),
    removed: [...before].filter((n) => !after.has(n)),
    added: [...after].filter((n) => !before.has(n)),
  };
};

export interface InvalidationPlan {
  scenes: SceneDiff;
  /** Scene ids whose panels must be re-planned (changed + added + removed). */
  dirtySceneIds: number[];
  keptPanelIds: string[];
  resetPanelIds: string[];
  /** Style is never invalidated by a script edit. */
  keepsStyle: boolean;
  /** Human-readable summary the agent can say before acting. */
  summary: string;
}

/** Compute the minimal invalidation for re-analyzing `state` into `nextScenes`. */
export const invalidationPlan = (
  state: Pick<ComicState, 'scenes' | 'panels'>,
  nextScenes: Scene[],
): InvalidationPlan => {
  const scenes = diffScenes(state.scenes || [], nextScenes);
  const dirty = new Set<number>([...scenes.changed, ...scenes.added, ...scenes.removed]);
  const panels = state.panels || [];
  const kept = panels.filter((p) => !dirty.has(p.sceneId));
  const reset = panels.filter((p) => dirty.has(p.sceneId));
  const touched = scenes.changed.length + scenes.added.length;
  const summary = touched === 0 && scenes.removed.length === 0
    ? 'No scene content changed — nothing to re-plan.'
    : `This edit touches ${touched} scene${touched === 1 ? '' : 's'} — re-planning ${reset.length} panel${reset.length === 1 ? '' : 's'}. Style and ${kept.length} other panel${kept.length === 1 ? '' : 's'} are untouched.`;
  return {
    scenes,
    dirtySceneIds: [...dirty],
    keptPanelIds: kept.map((p) => p.id),
    resetPanelIds: reset.map((p) => p.id),
    keepsStyle: true,
    summary,
  };
};

/**
 * The scoped patch for a script re-analysis: keep style, aspect/resolution and the panels
 * of unchanged scenes; only drop panels belonging to changed/added/removed scenes. Unlike
 * `resetFromScriptAnalysis`, this never resets the aesthetic for a story edit.
 */
export const scopedScriptReanalysis = (
  state: ComicState,
  nextScript: string,
  nextScenes: Scene[],
): { patch: Partial<ComicState>; plan: InvalidationPlan } => {
  const plan = invalidationPlan(state, nextScenes);
  const dirty = new Set(plan.dirtySceneIds);
  const keptPanels: ComicPanel[] = (state.panels || []).filter((p) => !dirty.has(p.sceneId));
  return {
    plan,
    patch: {
      script: nextScript,
      scenes: nextScenes,
      panels: keptPanels,
      scriptHash: stableHash(nextScript || ''),
      // Intentionally NOT touched: styleVariants, selectedStyleId, stylePrompt, styleImageId,
      // styleAspectRatio, imageResolution — a story edit is not an aesthetic change.
    },
  };
};
