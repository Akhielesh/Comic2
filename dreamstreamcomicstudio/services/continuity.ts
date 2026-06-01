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

const normalizeForMatch = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const containsGroundedName = (source: string, rawName: string) => {
  const target = normalizeForMatch(rawName);
  const normalizedSource = normalizeForMatch(source || "");
  if (!target || !normalizedSource) return false;
  const pattern = new RegExp(`(^|\\s)${escapeRegex(target)}($|\\s)`);
  return pattern.test(normalizedSource);
};

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
  imageId: entity.imageId,
  required: kind === "character"
});

const findLocationId = (
  scene: Scene,
  locations: Location[],
  strictMode: boolean
): string | undefined => {
  const rawText = scene.rawText || "";
  const setting = scene.setting || "";
  const synopsis = scene.synopsis || "";

  const fromRaw = locations.find((location) => containsGroundedName(rawText, location.name));
  if (fromRaw) return fromRaw.id;

  const fromSetting = locations.find((location) => containsGroundedName(setting, location.name));
  if (fromSetting) return fromSetting.id;

  if (!strictMode) {
    const fromSynopsis = locations.find((location) => containsGroundedName(synopsis, location.name));
    if (fromSynopsis) return fromSynopsis.id;
  }

  return locations[0]?.id;
};

const findCharacterIds = (scene: Scene, characters: Character[], strictMode: boolean) => {
  const names = scene.characters || [];
  const fromScene = characters
    .filter((character) =>
      names.some((name) => normalizeName(name) === normalizeName(character.name))
    )
    .map((character) => character.id);
  if (fromScene.length > 0) return fromScene;

  const fromRawText = characters
    .filter((character) => containsGroundedName(scene.rawText || "", character.name))
    .map((character) => character.id);
  if (fromRawText.length > 0) return fromRawText;

  if (strictMode) return [];

  const fromSynopsis = characters
    .filter((character) => containsGroundedName(scene.synopsis || "", character.name))
    .map((character) => character.id);
  if (fromSynopsis.length > 0) return fromSynopsis;

  return characters
    .filter((character) => containsGroundedName(scene.setting || "", character.name))
    .map((character) => character.id);
};

const findItemIds = (scene: Scene, items: Item[], strictMode: boolean) => {
  const fromRawText = items
    .filter((item) => containsGroundedName(scene.rawText || "", item.name))
    .map((item) => item.id);
  if (fromRawText.length > 0) return fromRawText;

  if (strictMode) return [];

  return items
    .filter((item) => containsGroundedName(scene.synopsis || "", item.name))
    .map((item) => item.id);
};

export const buildContinuityBible = (
  scenes: Scene[],
  characters: Character[],
  items: Item[],
  locations: Location[],
  previous?: ContinuityBible,
  options?: {
    strictMode?: boolean;
  }
): ContinuityBible => {
  const strictMode = options?.strictMode ?? true;
  const entities: ContinuityEntity[] = [
    ...characters.map((character) => buildEntity("character", character)),
    ...items.map((item) => buildEntity("item", item)),
    ...locations.map((location) => buildEntity("location", location))
  ];

  const sceneBindings: SceneContinuityBinding[] = scenes.map((scene) => {
    const characterIds = findCharacterIds(scene, characters, strictMode);
    const itemIds = findItemIds(scene, items, strictMode);
    const locationId = findLocationId(scene, locations, strictMode);
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
    state.continuity?.bible,
    { strictMode: (state.continuity?.lockLevel || "strict") === "strict" }
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
  const strictMode = (existing?.lockLevel || "strict") === "strict";
  const bible = buildContinuityBible(scenes, characters, items, locations, existing?.bible, { strictMode });
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
      .map((entityId) => {
        const entity = getEntityById(state, entityId);
        if (!entity) return [];
        // Include both user-uploaded references AND the generated turnaround/concept image
        const ids = [...(entity.referenceImageIds || [])];
        if (entity.imageId) ids.push(entity.imageId);
        return ids;
      })
      .flat(),
    ...(locationId ? (() => {
      const loc = getEntityById(state, locationId);
      if (!loc) return [];
      const ids = [...(loc.referenceImageIds || [])];
      if (loc.imageId) ids.push(loc.imageId);
      return ids;
    })() : [])
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

type ContinuityEntityAsset = {
  id: string;
  kind: ContinuityEntity["kind"];
  name: string;
  description: string;
  imageId?: string;
  referenceImageIds: string[];
};

const resolveContinuityEntityAsset = (state: ComicState, entityId: string): ContinuityEntityAsset | undefined => {
  const character = state.characters.find((entry) => entry.id === entityId);
  if (character) {
    return {
      id: character.id,
      kind: "character",
      name: character.name,
      description: character.description,
      imageId: character.imageId,
      referenceImageIds: dedupe(character.referenceImageIds || [])
    };
  }

  const item = state.items.find((entry) => entry.id === entityId);
  if (item) {
    return {
      id: item.id,
      kind: "item",
      name: item.name,
      description: item.description,
      imageId: item.imageId,
      referenceImageIds: dedupe(item.referenceImageIds || [])
    };
  }

  const location = state.locations.find((entry) => entry.id === entityId);
  if (location) {
    return {
      id: location.id,
      kind: "location",
      name: location.name,
      description: location.description,
      imageId: location.imageId,
      referenceImageIds: dedupe(location.referenceImageIds || [])
    };
  }

  const continuityEntity = getEntityById(state, entityId);
  if (!continuityEntity) return undefined;
  return {
    id: continuityEntity.id,
    kind: continuityEntity.kind,
    name: continuityEntity.name,
    description: continuityEntity.description,
    imageId: continuityEntity.imageId,
    referenceImageIds: dedupe(continuityEntity.referenceImageIds || [])
  };
};

export type PanelReferencePack = {
  imageIds: string[];
  requiredEntityIds: string[];
  requiredEntityPrimaryImageIds: string[];
  fallbackEntityReferenceIds: string[];
  locationImageId?: string;
  styleImageId?: string;
  priorPanelImageId?: string;
};

export const buildPanelReferencePack = (
  state: ComicState,
  panel: ComicPanel,
  options?: {
    styleImageId?: string;
    lastPanelImageId?: string;
    maxReferences?: number;
  }
): PanelReferencePack => {
  const maxReferences = Math.max(1, options?.maxReferences || 8);
  const continuity = resolvePanelContinuity(state, panel);
  const requiredEntityIds = dedupe(continuity.requiredEntityIds || []);

  const requiredEntityPrimaryImageIds: string[] = [];
  const fallbackEntityReferenceIds: string[] = [];

  for (const entityId of requiredEntityIds) {
    if (requiredEntityPrimaryImageIds.length >= 4) break;
    const entity = resolveContinuityEntityAsset(state, entityId);
    if (!entity) continue;
    if (entity.imageId) {
      requiredEntityPrimaryImageIds.push(entity.imageId);
      continue;
    }
    const fallback = entity.referenceImageIds.find(Boolean);
    if (fallback) {
      fallbackEntityReferenceIds.push(fallback);
    }
  }

  const locationAsset = continuity.locationId
    ? resolveContinuityEntityAsset(state, continuity.locationId)
    : undefined;
  const locationImageId = locationAsset?.imageId;

  const styleImageId = options?.styleImageId;
  const priorPanelImageId = options?.lastPanelImageId;

  // Order matters: image models weight the FIRST reference most heavily. Lead with concrete
  // story references (entities, then location, then the prior panel) so each panel depicts the
  // RIGHT subject. The style preview is a look-and-feel anchor only — keep it LAST and include
  // it ONLY when there are no entity references, so an off-topic style image can never override
  // the story content (this was a cause of e.g. boats rendering as superheroes).
  const hasEntityRefs = requiredEntityPrimaryImageIds.length > 0;
  const ordered = dedupe([
    ...requiredEntityPrimaryImageIds,
    ...(locationImageId ? [locationImageId] : []),
    ...(priorPanelImageId ? [priorPanelImageId] : []),
    ...fallbackEntityReferenceIds.slice(0, 2),
    ...(styleImageId && !hasEntityRefs ? [styleImageId] : [])
  ]).slice(0, maxReferences);

  return {
    imageIds: ordered,
    requiredEntityIds,
    requiredEntityPrimaryImageIds: dedupe(requiredEntityPrimaryImageIds).slice(0, 4),
    fallbackEntityReferenceIds: dedupe(fallbackEntityReferenceIds).slice(0, 2),
    locationImageId,
    styleImageId,
    priorPanelImageId
  };
};

export const resolveVisibleEntities = (state: ComicState, panel: ComicPanel) => {
  const continuity = resolvePanelContinuity(state, panel);
  return (continuity.requiredEntityIds || [])
    .map((id) => getEntityById(state, id))
    .filter((e): e is ContinuityEntity => !!e);
};

export const buildPanelScopedContext = (state: ComicState, panel: ComicPanel) => {
  const continuity = resolvePanelContinuity(state, panel);
  const requiredEntities = dedupe(continuity.requiredEntityIds || [])
    .map((entityId) => resolveContinuityEntityAsset(state, entityId))
    .filter((entry): entry is ContinuityEntityAsset => !!entry);

  const characterContext = requiredEntities
    .filter((entry) => entry.kind === "character")
    .map((entry) => `${entry.name}: ${entry.description}`)
    .join(". ");

  const itemContext = requiredEntities
    .filter((entry) => entry.kind === "item")
    .map((entry) => `${entry.name}: ${entry.description}`)
    .join(". ");

  const lockedLocation = continuity.locationId
    ? resolveContinuityEntityAsset(state, continuity.locationId)
    : undefined;

  const locationContext = lockedLocation
    ? `${lockedLocation.name}: ${lockedLocation.description}`
    : "";

  return {
    characters: characterContext,
    items: itemContext,
    location: locationContext
  };
};

export const buildEntityTextContext = (state: ComicState, panel: ComicPanel): string => {
  const entities = resolveVisibleEntities(state, panel);
  if (entities.length === 0) return "";

  return entities.map(e => {
    const parts = [
      `[${e.name}]`,
      e.description ? `Description: ${e.description}` : "",
      // If it's a character, we might want more specific fields if they existed, 
      // but ContinuityEntity seems to be a unified type or we look at the specific lists.
      // Let's check if we can access the original Character/Item/Location objects for more detail.
      // The ContinuityEntity is likely a subset or reference. 
      // Actually getEntityById looks up in state.continuity.bible.entities.
      // Let's assume ContinuityEntity has the fields we need or we look up in state.characters/items/locations.
    ].filter(Boolean).join(" ");

    // Better lookup: find the actual Character/Item/Location because ContinuityEntity might be sparse?
    // The previous code mapped entity IDs to names.
    // Let's try to find the full object for better description.
    const fullChar = state.characters.find(c => c.id === e.id);
    const fullItem = state.items.find(i => i.id === e.id);
    const fullLoc = state.locations.find(l => l.id === e.id);
    const fullObj = fullChar || fullItem || fullLoc;

    if (fullObj) {
      // Use the full object description if available
      return `[${fullObj.name}]: ${fullObj.description}`;
    }
    return `[${e.name}]: ${e.description}`;
  }).join("\n");
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
