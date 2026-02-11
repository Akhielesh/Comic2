import {
  Character,
  ComicPanel,
  ComicState,
  ContinuityBible,
  ContinuityEntity,
  ContinuityState,
  ContinuityValidationResult,
  Item,
  Location,
  PanelContinuity,
  Scene,
  SceneContinuityBinding
} from "../types";

const normalizeName = (value: string) => value.trim().toLowerCase();

const dedupe = (items: string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
};

const extractLockedTraits = (text: string, limit = 5): string[] => {
  if (!text) return [];
  const traits = text
    .split(/[.;,\n]/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, limit);
  return traits;
};

const buildEntity = (
  kind: ContinuityEntity["kind"],
  entity: Character | Item | Location
): ContinuityEntity => ({
  id: entity.id,
  kind,
  name: entity.name,
  description: entity.description,
  lockedTraits: extractLockedTraits(
    kind === "character" ? `${(entity as Character).bio || ""}. ${entity.description || ""}` : entity.description || ""
  ),
  referenceImageIds: dedupe([...(entity.referenceImageIds || []), ...(entity.imageId ? [entity.imageId] : [])]),
  required: kind === "character"
});

const findLocationId = (scene: Scene, locations: Location[]): string | undefined => {
  const setting = normalizeName(scene.setting || "");
  const direct = locations.find((location) => setting.includes(normalizeName(location.name)));
  if (direct) return direct.id;
  return locations[0]?.id;
};

const findCharacterIds = (scene: Scene, characters: Character[]) => {
  const names = scene.characters || [];
  const fromScene = characters
    .filter((character) =>
      names.some((name) => normalizeName(name) === normalizeName(character.name))
    )
    .map((character) => character.id);
  if (fromScene.length > 0) return fromScene;

  const synopsis = normalizeName(scene.synopsis || "");
  return characters
    .filter((character) => synopsis.includes(normalizeName(character.name)))
    .map((character) => character.id);
};

const findItemIds = (scene: Scene, items: Item[]) => {
  const synopsis = normalizeName(scene.synopsis || "");
  return items
    .filter((item) => synopsis.includes(normalizeName(item.name)))
    .map((item) => item.id);
};

export const buildContinuityBible = (
  scenes: Scene[],
  characters: Character[],
  items: Item[],
  locations: Location[],
  previous?: ContinuityBible
): ContinuityBible => {
  const entities: ContinuityEntity[] = [
    ...characters.map((character) => buildEntity("character", character)),
    ...items.map((item) => buildEntity("item", item)),
    ...locations.map((location) => buildEntity("location", location))
  ];

  const sceneBindings: SceneContinuityBinding[] = scenes.map((scene) => {
    const characterIds = findCharacterIds(scene, characters);
    const itemIds = findItemIds(scene, items);
    const locationId = findLocationId(scene, locations);
    return {
      sceneId: scene.id,
      characterIds,
      itemIds,
      locationId,
      requiredEntityIds: dedupe([...characterIds, ...itemIds])
    };
  });

  const now = Date.now();
  return {
    version: (previous?.version || 0) + 1,
    entities,
    sceneBindings,
    createdAt: previous?.createdAt || now,
    updatedAt: now
  };
};

export const buildDefaultContinuityState = (state: ComicState): ContinuityState => {
  const bible = buildContinuityBible(
    state.scenes || [],
    state.characters || [],
    state.items || [],
    state.locations || [],
    state.continuity?.bible
  );
  return {
    bible,
    lockLevel: "strict",
    fallbackPolicy: "auto",
    validation: validateContinuityState({
      ...state,
      continuity: {
        bible,
        lockLevel: "strict",
        fallbackPolicy: "auto"
      }
    })
  };
};

export const buildContinuityFromWorld = (
  scenes: Scene[],
  characters: Character[],
  items: Item[],
  locations: Location[],
  existing?: ContinuityState
): ContinuityState => {
  const bible = buildContinuityBible(scenes, characters, items, locations, existing?.bible);
  const baseState = {
    scenes,
    characters,
    items,
    locations,
    continuity: {
      bible,
      lockLevel: existing?.lockLevel || "strict",
      fallbackPolicy: existing?.fallbackPolicy || "auto"
    }
  } as ComicState;

  return {
    bible,
    lockLevel: existing?.lockLevel || "strict",
    fallbackPolicy: existing?.fallbackPolicy || "auto",
    validation: validateContinuityState(baseState)
  };
};

export const getSceneBinding = (state: ComicState, sceneId: number): SceneContinuityBinding | undefined => {
  return state.continuity?.bible.sceneBindings.find((binding) => binding.sceneId === sceneId);
};

export const getEntityById = (state: ComicState, entityId: string): ContinuityEntity | undefined => {
  return state.continuity?.bible.entities.find((entity) => entity.id === entityId);
};

export const resolvePanelContinuity = (state: ComicState, panel: ComicPanel): PanelContinuity => {
  const binding = getSceneBinding(state, panel.sceneId);
  const requiredEntityIds = dedupe([
    ...(panel.continuity?.requiredEntityIds || []),
    ...(binding?.requiredEntityIds || [])
  ]);
  const locationId = panel.continuity?.locationId || binding?.locationId;
  const referenceImageIds = dedupe([
    ...(panel.continuity?.referenceImageIds || []),
    ...requiredEntityIds
      .map((entityId) => getEntityById(state, entityId)?.referenceImageIds || [])
      .flat(),
    ...(locationId ? getEntityById(state, locationId)?.referenceImageIds || [] : [])
  ]);

  return {
    requiredEntityIds,
    locationId,
    referenceImageIds,
    continuityNotes: panel.continuity?.continuityNotes || undefined,
    driftScore: panel.continuity?.driftScore,
    validatedAt: panel.continuity?.validatedAt,
    flaggedIssues: panel.continuity?.flaggedIssues || []
  };
};

export const collectPanelReferenceImageIds = (state: ComicState, panel: ComicPanel): string[] => {
  const continuity = resolvePanelContinuity(state, panel);
  return dedupe(continuity.referenceImageIds || []);
};

export const validateContinuityState = (state: ComicState): ContinuityValidationResult => {
  const issues: ContinuityValidationResult["issues"] = [];
  const bible = state.continuity?.bible;

  if (!bible) {
    issues.push({
      code: "CONTINUITY_MISSING",
      message: "Continuity bible is missing.",
      severity: "error"
    });
    return {
      isValid: false,
      missingEntityIds: [],
      issues,
      updatedAt: Date.now()
    };
  }

  const missingEntityIds: string[] = [];
  for (const scene of state.scenes) {
    const binding = bible.sceneBindings.find((candidate) => candidate.sceneId === scene.id);
    if (!binding) {
      issues.push({
        code: "SCENE_BINDING_MISSING",
        message: `Scene ${scene.id} has no continuity binding.`,
        severity: "error",
        sceneId: scene.id
      });
      continue;
    }

    const requiredEntityIds = binding.requiredEntityIds || [];
    for (const entityId of requiredEntityIds) {
      const entity = bible.entities.find((candidate) => candidate.id === entityId);
      if (!entity) {
        missingEntityIds.push(entityId);
        issues.push({
          code: "ENTITY_NOT_FOUND",
          message: `Entity ${entityId} referenced by scene ${scene.id} is missing.`,
          severity: "error",
          sceneId: scene.id,
          entityId
        });
        continue;
      }
      if (!entity.referenceImageIds || entity.referenceImageIds.length === 0) {
        missingEntityIds.push(entityId);
        issues.push({
          code: "ENTITY_REFERENCE_MISSING",
          message: `${entity.name} has no reference images.`,
          severity: "error",
          sceneId: scene.id,
          entityId
        });
      }
    }

    const hasAnyLocation = bible.entities.some((entity) => entity.kind === "location");
    if (state.continuity?.lockLevel === "strict" && hasAnyLocation && !binding.locationId) {
      issues.push({
        code: "LOCATION_BINDING_MISSING",
        message: `Scene ${scene.id} has no locked location.`,
        severity: "error",
        sceneId: scene.id
      });
    }
  }

  return {
    isValid: issues.filter((issue) => issue.severity === "error").length === 0,
    missingEntityIds: dedupe(missingEntityIds),
    issues,
    updatedAt: Date.now()
  };
};
