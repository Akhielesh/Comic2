import { ComicState } from '../types';

/**
 * Stage fingerprints used to detect when downstream stages (panels, world, continuity)
 * were built from a now-edited upstream (script/scenes/world). Editing the script or world
 * after planning used to silently corrupt a comic — panels referencing renamed/removed
 * entities — because the drift was only logged as a metric, never surfaced. This module is
 * the single source of truth for those hashes so generation and the pre-flight UI agree.
 */

export const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return `h${Math.abs(hash >>> 0).toString(16)}`;
};

export const hashScenes = (state: ComicState): string =>
  stableHash(
    JSON.stringify(
      (state.scenes || []).map((scene) => ({
        id: scene.id,
        rawText: scene.rawText || '',
        synopsis: scene.synopsis || '',
        setting: scene.setting || '',
        characters: scene.characters || []
      }))
    )
  );

export const hashWorld = (state: ComicState): string =>
  stableHash(
    JSON.stringify({
      characters: (state.characters || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        bio: entry.bio,
        referenceImageIds: entry.referenceImageIds || []
      })),
      items: (state.items || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        referenceImageIds: entry.referenceImageIds || []
      })),
      locations: (state.locations || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        referenceImageIds: entry.referenceImageIds || []
      }))
    })
  );

/**
 * Strict check used at generation time: treats MISSING fingerprints as stale too (a run
 * that never recorded them can't be trusted). Good for logging/metrics, but too eager for
 * a user-facing warning (a brand-new plan may not have hashes yet).
 */
export const hasStaleDownstreamFingerprint = (state: ComicState): boolean => {
  if (!state.scriptHash || !state.sceneHash || !state.worldHash) return true;
  return (
    state.scriptHash !== stableHash(state.script || '') ||
    state.sceneHash !== hashScenes(state) ||
    state.worldHash !== hashWorld(state)
  );
};

/**
 * Conservative check for surfacing a warning: only true when a fingerprint is PRESENT and
 * disagrees with the current content — i.e. genuine drift the user caused by editing an
 * upstream stage after planning. Avoids false positives on fresh state.
 */
export const hasDownstreamDrift = (state: ComicState): boolean => {
  const pairs: Array<[string | undefined, string]> = [
    [state.scriptHash, stableHash(state.script || '')],
    [state.sceneHash, hashScenes(state)],
    [state.worldHash, hashWorld(state)]
  ];
  return pairs.some(([stored, expected]) => !!stored && stored !== expected);
};
