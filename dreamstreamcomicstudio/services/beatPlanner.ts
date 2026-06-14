// Beat-based planning (v3 spec §3.5) — turn scenes + a page budget into a beat map, instead
// of a rigid "panels = pages*perPage/scenes clamped 1–8". A scene that needs more than the
// per-beat cap is split into sequential beats; the page budget is distributed first-come.
// Pure + deterministic so the plan card and (later) the generator agree on the same map.

import type { Scene } from '../types';

export interface Beat {
  id: string;
  sceneIds: number[];
  synopsis: string;
  panelCount: number;
}

export interface BeatPlan {
  beats: Beat[];
  totalPanels: number;
  pages: number;
  panelsPerPage: number;
}

const MAX_PANELS_PER_BEAT = 8;

/**
 * Deterministic beat plan. `panelsPerPage` defaults to 3; `pageCount` 0/undefined means
 * "auto" (≈3 panels per scene). The target total is spread across scenes (earlier scenes
 * absorb the remainder), then any scene over the cap splits into sequential beats.
 */
export const planBeats = (
  scenes: Scene[] = [],
  pageCount = 0,
  panelsPerPage = 3,
): BeatPlan => {
  const perPage = Math.max(1, Math.floor(panelsPerPage) || 3);
  const sceneCount = scenes.length;
  if (sceneCount === 0) {
    return { beats: [], totalPanels: 0, pages: Math.max(0, Math.floor(pageCount) || 0), panelsPerPage: perPage };
  }
  const pages = Math.max(0, Math.floor(pageCount) || 0);
  const targetTotal = pages > 0 ? Math.max(sceneCount, pages * perPage) : sceneCount * 3;

  const base = Math.floor(targetTotal / sceneCount);
  const remainder = targetTotal % sceneCount;

  const beats: Beat[] = [];
  scenes.forEach((scene, index) => {
    const panelsForScene = Math.max(1, base + (index < remainder ? 1 : 0));
    const beatCount = Math.ceil(panelsForScene / MAX_PANELS_PER_BEAT);
    const evenPerBeat = Math.floor(panelsForScene / beatCount);
    const beatRemainder = panelsForScene % beatCount;
    for (let b = 0; b < beatCount; b += 1) {
      const panelCount = evenPerBeat + (b < beatRemainder ? 1 : 0);
      beats.push({
        id: `beat_${scene.id}_${b}`,
        sceneIds: [scene.id],
        synopsis: beatCount > 1
          ? `${scene.synopsis || scene.setting || `Scene ${index + 1}`} (part ${b + 1}/${beatCount})`
          : (scene.synopsis || scene.setting || `Scene ${index + 1}`),
        panelCount,
      });
    }
  });

  return {
    beats,
    totalPanels: beats.reduce((sum, b) => sum + b.panelCount, 0),
    pages: pages > 0 ? pages : Math.max(1, Math.ceil(targetTotal / perPage)),
    panelsPerPage: perPage,
  };
};
