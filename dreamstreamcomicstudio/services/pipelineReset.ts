import { AppStep, Character, ComicState, Item, LayoutType, Location, Scene, StyleVariant } from "../types";
import { buildContinuityFromWorld } from "./continuity";
import { getFormFactorDefaultAspectRatio, recommendStoryPlanning } from "./storyPlanning";

type ResetSourceStage =
  | "script_analysis"
  | "story_planning_confirm"
  | "style_confirm"
  | "world_confirm"
  | "layout_confirm";

const stableHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return `h${Math.abs(hash >>> 0).toString(16)}`;
};

const hashScenes = (scenes: Scene[]) =>
  stableHash(
    JSON.stringify(
      (scenes || []).map((scene) => ({
        id: scene.id,
        rawText: scene.rawText || "",
        synopsis: scene.synopsis || "",
        setting: scene.setting || "",
        characters: scene.characters || []
      }))
    )
  );

const hashWorld = (characters: Character[], items: Item[], locations: Location[]) =>
  stableHash(
    JSON.stringify({
      characters: (characters || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        bio: entry.bio,
        referenceImageIds: entry.referenceImageIds || []
      })),
      items: (items || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        referenceImageIds: entry.referenceImageIds || []
      })),
      locations: (locations || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        referenceImageIds: entry.referenceImageIds || []
      }))
    })
  );

const withStepGate = (
  state: ComicState,
  nextStep: AppStep
): Pick<ComicState, "step" | "maxStepReached"> => ({
  step: nextStep,
  maxStepReached: nextStep
});

const clearCoverState = () => ({
  coverImageId: undefined,
  coverImageUrl: undefined,
  coverPrompt: "",
  coverTemplateId: undefined,
  coverTemplateImageId: undefined,
  coverTemplateImageUrl: undefined
});

const clearPanelState = () => ({
  panelSlotsSnapshot: undefined,
  panelPlanVersion: undefined,
  panels: [],
  continuitySummary: "",
  generationStatus: undefined
});

const stripGeneratedWorldImages = <T extends Character | Item | Location>(entities: T[]) =>
  (entities || []).map((entity) => ({
    ...entity,
    imageId: undefined,
    imageUrl: undefined
  }));

const applyResetSource = (
  source: ResetSourceStage
): Pick<ComicState, "lastResetSourceStage"> => ({
  lastResetSourceStage: source
});

export const resetFromScriptAnalysis = (
  state: ComicState,
  nextScript: string,
  nextScenes: Scene[]
): Partial<ComicState> => {
  const clearedCharacters: Character[] = [];
  const clearedItems: Item[] = [];
  const clearedLocations: Location[] = [];
  const nextContinuity = buildContinuityFromWorld(
    nextScenes,
    clearedCharacters,
    clearedItems,
    clearedLocations,
    state.continuity
  );

  const storyPlanning = recommendStoryPlanning({
    script: nextScript,
    scenes: nextScenes
  });

  return {
    // Scenes confirmed → straight to styling. The old Story-Planning review stage is
    // gone; its recommendation still runs below so layout gets a form-factor default.
    ...withStepGate(state, AppStep.STYLE_SELECTION),
    ...applyResetSource("script_analysis"),
    ...clearCoverState(),
    ...clearPanelState(),
    script: nextScript,
    storyPlanning,
    scenes: nextScenes,
    styleVariants: [],
    selectedStyleId: undefined,
    stylePrompt: "",
    styleImageId: undefined,
    styleImageUrl: undefined,
    styleLockStatus: "missing",
    styleLockResolvedAt: undefined,
    styleCategory: "",
    styleAspectRatio: "1:1",
    imageResolution: "1K",
    characters: clearedCharacters,
    items: clearedItems,
    locations: clearedLocations,
    continuity: nextContinuity,
    layoutType: "grid",
    gridTemplateId: undefined,
    customLayoutPrompt: undefined,
    scriptHash: stableHash(nextScript || ""),
    sceneHash: hashScenes(nextScenes),
    worldHash: undefined
  };
};

export const resetFromStoryPlanningConfirm = (
  state: ComicState
): Partial<ComicState> => {
  // Legacy (the Story-Planning stage was removed): keep only the aspect-ratio carry-over
  // for old saved projects that still route through it.
  const styleAspectRatio = state.storyPlanning
    ? getFormFactorDefaultAspectRatio(state.storyPlanning.formFactor)
    : state.styleAspectRatio;
  return {
    ...withStepGate(state, AppStep.STYLE_SELECTION),
    ...applyResetSource("story_planning_confirm"),
    styleAspectRatio
  };
};

export const resetFromStyleConfirm = (
  state: ComicState,
  style: StyleVariant
): Partial<ComicState> => {
  const strippedCharacters = stripGeneratedWorldImages(state.characters || []);
  const strippedItems = stripGeneratedWorldImages(state.items || []);
  const strippedLocations = stripGeneratedWorldImages(state.locations || []);
  const nextContinuity = buildContinuityFromWorld(
    state.scenes || [],
    strippedCharacters,
    strippedItems,
    strippedLocations,
    state.continuity
  );

  return {
    ...withStepGate(state, AppStep.REFERENCE_BUILDER),
    ...applyResetSource("style_confirm"),
    ...clearCoverState(),
    ...clearPanelState(),
    selectedStyleId: style.id,
    stylePrompt: style.prompt,
    styleImageId: style.imageId,
    styleImageUrl: style.imageUrl,
    styleCategory: style.category,
    styleAspectRatio: style.aspectRatio,
    imageResolution: style.resolution,
    styleLockStatus: style.imageId ? "resolved" : "missing",
    styleLockResolvedAt: style.imageId ? Date.now() : undefined,
    characters: strippedCharacters,
    items: strippedItems,
    locations: strippedLocations,
    continuity: nextContinuity,
    layoutType: "grid",
    gridTemplateId: undefined,
    customLayoutPrompt: undefined,
    worldHash: hashWorld(strippedCharacters, strippedItems, strippedLocations)
  };
};

export const resetFromWorldConfirm = (state: ComicState): Partial<ComicState> => {
  const nextContinuity = buildContinuityFromWorld(
    state.scenes || [],
    state.characters || [],
    state.items || [],
    state.locations || [],
    state.continuity
  );

  return {
    ...withStepGate(state, AppStep.COVER),
    ...applyResetSource("world_confirm"),
    ...clearCoverState(),
    ...clearPanelState(),
    continuity: nextContinuity,
    worldHash: hashWorld(state.characters || [], state.items || [], state.locations || [])
  };
};

export const resetFromLayoutConfirm = (
  state: ComicState,
  layoutType: LayoutType,
  customLayoutPrompt?: string,
  gridTemplateId?: string,
  pageCount?: number
): Partial<ComicState> => {
  return {
    // Layout (+ page count) confirmed → straight into the build. Panel planning is
    // automatic now (generation Phase 1 plans every scene from the chosen design),
    // so there is no manual panel-plan stage in between.
    ...withStepGate(state, AppStep.FULL_GENERATION),
    ...applyResetSource("layout_confirm"),
    ...clearPanelState(),
    layoutType,
    customLayoutPrompt,
    gridTemplateId,
    pageCount: pageCount && pageCount > 0 ? Math.min(60, Math.floor(pageCount)) : undefined
  };
};
