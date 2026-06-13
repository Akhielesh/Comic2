import { AppStep, Character, ComicState, Item, LayoutType, Location, Scene, StyleVariant } from "../types";
import { buildContinuityFromWorld } from "./continuity";
import { transitionAgentRun } from "./comicAgentRun";
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

const normalizeMatchText = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const containsName = (source: string, name: string) => {
  const normalizedSource = normalizeMatchText(source);
  const normalizedName = normalizeMatchText(name);
  if (!normalizedSource || !normalizedName) return false;
  return new RegExp(`(^|\\s)${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|\\s)`).test(normalizedSource);
};

const preserveGroundedWorld = (state: ComicState, nextScript: string, nextScenes: Scene[]) => {
  const groundingText = [
    nextScript,
    ...nextScenes.flatMap((scene) => [
      scene.rawText || "",
      scene.synopsis || "",
      scene.setting || "",
      ...(scene.characters || [])
    ])
  ].join("\n");

  const characters = (state.characters || []).filter((character) => containsName(groundingText, character.name));
  const items = (state.items || []).filter((item) => containsName(groundingText, item.name));
  const locations = (state.locations || []).filter((location) => containsName(groundingText, location.name));

  return { characters, items, locations };
};

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
  const {
    characters: preservedCharacters,
    items: preservedItems,
    locations: preservedLocations
  } = preserveGroundedWorld(state, nextScript, nextScenes);
  const nextContinuity = buildContinuityFromWorld(
    nextScenes,
    preservedCharacters,
    preservedItems,
    preservedLocations,
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
    agentRun: transitionAgentRun(
      state,
      [
        {
          kind: "prompt",
          status: "done",
          summary: `${nextScenes.length} scene${nextScenes.length === 1 ? "" : "s"} analyzed from the story input.`,
          progress: 100
        },
        { kind: "style", status: "active", summary: "Ready to pick the comic's visual language." },
        { kind: "cast", status: "pending" },
        { kind: "cover", status: "pending" },
        { kind: "layout", status: "pending" },
        { kind: "build", status: "pending", progress: 0 },
        { kind: "export", status: "pending", progress: 0 }
      ],
      {
        kind: "prompt",
        status: "info",
        message: `Analyzed the story into ${nextScenes.length} scene${nextScenes.length === 1 ? "" : "s"}.`
      }
    ),
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
    characters: preservedCharacters,
    items: preservedItems,
    locations: preservedLocations,
    continuity: nextContinuity,
    layoutType: "grid",
    gridTemplateId: undefined,
    customLayoutPrompt: undefined,
    scriptHash: stableHash(nextScript || ""),
    sceneHash: hashScenes(nextScenes),
    worldHash: preservedCharacters.length || preservedItems.length || preservedLocations.length
      ? hashWorld(preservedCharacters, preservedItems, preservedLocations)
      : undefined
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
    agentRun: transitionAgentRun(
      state,
      [
        { kind: "prompt", status: "done", progress: 100 },
        { kind: "style", status: "active", summary: "Ready to pick the comic's visual language." }
      ],
      {
        kind: "style",
        status: "info",
        message: "Skipped the retired planning gate and moved to style."
      }
    ),
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
    agentRun: transitionAgentRun(
      state,
      [
        {
          kind: "style",
          status: "done",
          summary: `Style locked${style.category ? `: ${style.category}` : ""}.`,
          progress: 100
        },
        { kind: "cast", status: "active", summary: "Ready to extract and lock the cast/world context." },
        { kind: "cover", status: "pending" },
        { kind: "layout", status: "pending" },
        { kind: "build", status: "pending", progress: 0 },
        { kind: "export", status: "pending", progress: 0 }
      ],
      {
        kind: "style",
        status: "info",
        message: `Locked style direction${style.category ? ` (${style.category})` : ""}.`
      }
    ),
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
    agentRun: transitionAgentRun(
      state,
      [
        {
          kind: "cast",
          status: "done",
          summary: `${(state.characters || []).length} character${(state.characters || []).length === 1 ? "" : "s"}, ${(state.items || []).length} item${(state.items || []).length === 1 ? "" : "s"}, and ${(state.locations || []).length} location${(state.locations || []).length === 1 ? "" : "s"} locked.`,
          progress: 100
        },
        { kind: "cover", status: "active", summary: "Ready to generate a story-grounded cover." },
        { kind: "layout", status: "pending" },
        { kind: "build", status: "pending", progress: 0 },
        { kind: "export", status: "pending", progress: 0 }
      ],
      {
        kind: "cast",
        status: "info",
        message: "Locked cast, world, and continuity context."
      }
    ),
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
    agentRun: transitionAgentRun(
      state,
      [
        {
          kind: "layout",
          status: "done",
          summary: `${pageCount && pageCount > 0 ? Math.min(60, Math.floor(pageCount)) : "Auto"} page plan with ${layoutType.replace(/_/g, " ")} layout.`,
          progress: 100
        },
        { kind: "build", status: "active", summary: "Ready to render and save panels.", progress: 0 },
        { kind: "export", status: "pending", progress: 0 }
      ],
      {
        kind: "layout",
        status: "info",
        message: "Confirmed layout and queued the build."
      }
    ),
    layoutType,
    customLayoutPrompt,
    gridTemplateId,
    pageCount: pageCount && pageCount > 0 ? Math.min(60, Math.floor(pageCount)) : undefined
  };
};
