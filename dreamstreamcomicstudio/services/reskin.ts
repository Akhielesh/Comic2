// Re-skin on style change (v3 spec §3.4) — instead of stripping every generated entity
// sheet when the style changes, re-render entities that HAVE a sheet in the new style while
// passing the old sheet as an identity reference ("same character, new rendering style").
// This pure planner decides what can be re-skinned vs. must be rebuilt and frames the cost,
// so the agent can offer the costed choice. The actual re-render (calling generateImage with
// the old sheet at the front of the reference pack) is wired in autoReferences.

export interface Reskinnable {
  id: string;
  name: string;
  /** Generated sheet image, if any. */
  imageUrl?: string;
  imageId?: string;
  referenceImageIds?: string[];
}

export interface ReskinPlan {
  /** Entities that have a sheet and can be re-skinned (identity preserved). */
  reskin: Array<{ id: string; name: string; sheetImageId?: string }>;
  /** Entities with no sheet yet — nothing to migrate, they build fresh in the new style. */
  fresh: Array<{ id: string; name: string }>;
  /** Per-image price estimate for the re-skin batch. */
  estimateUsd: number;
  summary: string;
}

const hasSheet = (e: Reskinnable): boolean => !!e.imageUrl || !!e.imageId || (e.referenceImageIds?.length || 0) > 0;

/**
 * Plan a re-skin for a style change. `perImageUsd` defaults to a conservative $0.04.
 * Entities with an existing sheet are re-skinned (identity-preserving); the rest are fresh.
 */
export const planReskin = (entities: Reskinnable[] = [], perImageUsd = 0.04): ReskinPlan => {
  const reskin = entities.filter(hasSheet).map((e) => ({ id: e.id, name: e.name, sheetImageId: e.imageId || e.referenceImageIds?.[0] }));
  const fresh = entities.filter((e) => !hasSheet(e)).map((e) => ({ id: e.id, name: e.name }));
  const estimateUsd = Math.round(reskin.length * perImageUsd * 100) / 100;
  const summary = reskin.length === 0
    ? 'No existing cast art to migrate — the new style applies on the next render.'
    : `Re-skin ${reskin.length} cast sheet${reskin.length === 1 ? '' : 's'} in the new style (~$${estimateUsd.toFixed(2)}), keeping each character's identity — or rebuild from scratch.`;
  return { reskin, fresh, estimateUsd, summary };
};
