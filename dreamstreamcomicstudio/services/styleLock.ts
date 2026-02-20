import { ComicState, StyleVariant } from "../types";

type StyleLockSource = "selected" | "latest_generated" | "first_generated" | "unresolved";

export type StyleLockResolution = {
  resolved: boolean;
  source: StyleLockSource;
  selectedStyleId?: string;
  stylePrompt?: string;
  styleImageId?: string;
  styleImageUrl?: string;
  styleCategory?: string;
  styleAspectRatio?: ComicState["styleAspectRatio"];
  imageResolution?: ComicState["imageResolution"];
};

const hasImageId = (variant?: StyleVariant | null): variant is StyleVariant =>
  !!variant && typeof variant.imageId === "string" && variant.imageId.trim().length > 0;

const resolveLatestGeneratedVariant = (variants: StyleVariant[]): StyleVariant | undefined => {
  const withGeneratedAt = variants
    .map((variant, index) => ({ variant, index }))
    .filter(({ variant }) => hasImageId(variant) && Number.isFinite(variant.generatedAt));

  if (!withGeneratedAt.length) return undefined;

  withGeneratedAt.sort((a, b) => {
    const aTime = Number(a.variant.generatedAt || 0);
    const bTime = Number(b.variant.generatedAt || 0);
    if (aTime !== bTime) return bTime - aTime;
    return b.index - a.index;
  });

  return withGeneratedAt[0]?.variant;
};

const toResolution = (variant: StyleVariant, source: StyleLockSource): StyleLockResolution => ({
  resolved: true,
  source,
  selectedStyleId: variant.id,
  stylePrompt: variant.prompt,
  styleImageId: variant.imageId,
  styleImageUrl: variant.imageUrl,
  styleCategory: variant.category,
  styleAspectRatio: variant.aspectRatio,
  imageResolution: variant.resolution
});

export const resolveStyleLock = (state: Pick<ComicState, "selectedStyleId" | "styleVariants">): StyleLockResolution => {
  const variants = Array.isArray(state.styleVariants) ? state.styleVariants : [];
  if (!variants.length) {
    return { resolved: false, source: "unresolved" };
  }

  const selectedVariant = variants.find((variant) => variant.id === state.selectedStyleId);
  if (hasImageId(selectedVariant)) {
    return toResolution(selectedVariant, "selected");
  }

  const latestGenerated = resolveLatestGeneratedVariant(variants);
  if (latestGenerated && hasImageId(latestGenerated)) {
    return toResolution(latestGenerated, "latest_generated");
  }

  const firstWithImage = variants.find((variant) => hasImageId(variant));
  if (firstWithImage && hasImageId(firstWithImage)) {
    return toResolution(firstWithImage, "first_generated");
  }

  return { resolved: false, source: "unresolved" };
};

const isDifferent = <T>(current: T, next: T) => current !== next;

export const applyStyleLockResolution = (
  state: ComicState,
  now = Date.now()
): { state: ComicState; changed: boolean; resolution: StyleLockResolution } => {
  const resolution = resolveStyleLock(state);
  if (!resolution.resolved) {
    const shouldMarkMissing = state.styleLockStatus !== "missing";
    if (!shouldMarkMissing) {
      return { state, changed: false, resolution };
    }
    return {
      state: {
        ...state,
        styleLockStatus: "missing"
      },
      changed: true,
      resolution
    };
  }

  const shouldRefreshResolvedAt =
    state.styleLockStatus !== "resolved"
    || state.selectedStyleId !== resolution.selectedStyleId
    || state.styleImageId !== resolution.styleImageId;

  const nextState: ComicState = {
    ...state,
    selectedStyleId: resolution.selectedStyleId,
    stylePrompt: resolution.stylePrompt || state.stylePrompt,
    styleImageId: resolution.styleImageId,
    styleImageUrl: resolution.styleImageUrl || state.styleImageUrl,
    styleCategory: resolution.styleCategory || state.styleCategory,
    styleAspectRatio: resolution.styleAspectRatio || state.styleAspectRatio,
    imageResolution: resolution.imageResolution || state.imageResolution,
    styleLockStatus: "resolved",
    styleLockResolvedAt: shouldRefreshResolvedAt ? now : (state.styleLockResolvedAt || now)
  };

  const changed =
    isDifferent(state.selectedStyleId, nextState.selectedStyleId) ||
    isDifferent(state.stylePrompt, nextState.stylePrompt) ||
    isDifferent(state.styleImageId, nextState.styleImageId) ||
    isDifferent(state.styleImageUrl, nextState.styleImageUrl) ||
    isDifferent(state.styleCategory, nextState.styleCategory) ||
    isDifferent(state.styleAspectRatio, nextState.styleAspectRatio) ||
    isDifferent(state.imageResolution, nextState.imageResolution) ||
    isDifferent(state.styleLockStatus, nextState.styleLockStatus) ||
    isDifferent(state.styleLockResolvedAt, nextState.styleLockResolvedAt);

  return { state: nextState, changed, resolution };
};
